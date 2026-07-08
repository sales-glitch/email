/**
 * Research + Personalize Bot (for Mailmeteor)
 * LocalTuneUp + Zevahit — Google Sheets + Gemini (with Google Search grounding)
 *
 * This script does NOT send emails. It:
 *  1. Reads leads from a Google Sheet (Name, Company, Email, Persona)
 *  2. RESEARCHES each lead using Gemini's built-in Google Search grounding
 *     (finds the company website, locations, industry, recent news, etc.
 *      starting from just the brand name + person name)
 *  3. PERSONALIZES a subject + body referencing real, researched details
 *  4. Writes ResearchNotes, Subject, Body, Status back to the Sheet
 *
 * You then run a Mailmeteor merge from that same Sheet to actually send.
 * Mailmeteor setup: in your Gmail draft template, set Subject to "{{Subject}}"
 * and Body to "{{Body}}" so each contact gets their fully personalized text.
 *
 * Required GitHub Secrets:
 *  - GEMINI_API_KEY                Gemini API key from Google AI Studio
 *  - GOOGLE_SERVICE_ACCOUNT_JSON   full JSON key (as one-line string) for a service account
 *                                   that has Editor access to the target Sheet
 *  - SHEET_ID                      the Google Sheet ID (from its URL)
 *
 * Sheet tab must be named "Leads" with header row:
 *  Name | Company | Email | Persona | Status | ResearchNotes | Subject | Body
 *  Persona column value must be exactly "LocalTuneUp" or "Zevahit"
 *  Leave Status empty for leads not yet processed.
 */

import { google } from "googleapis";
import { GoogleGenAI } from "@google/genai";

const SHEET_ID = process.env.SHEET_ID;
const SHEET_TAB = "Leads";
const DAILY_LEAD_LIMIT = parseInt(process.env.DAILY_LEAD_LIMIT || "100", 10);
const SENDER_NAME = process.env.SENDER_NAME || "Salman";

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
const RESEARCH_MODEL = "gemini-2.5-flash"; // grounding-capable, cost-predictable
const WRITE_MODEL = "gemini-2.5-flash";

// ---------- Persona context (brand angle used to steer research + writing) ----------

const PERSONAS = {
  LocalTuneUp: {
    researchAngle: `This prospect is being considered for LocalTuneUp, a Google Business Profile / local SEO service for multi-location businesses (restaurants, retail, franchises). Focus research on: how many physical locations/stores they run, which cities/countries, what industry/cuisine/category, and any recent expansion, funding, or new-location news. If possible, note whether they seem to rely on walk-in/local customers (which makes Google Maps visibility relevant to them).`,
    writeSystemPrompt: `You are writing a cold outreach email as LocalTuneUp, a Google Business Profile / local SEO optimization service for multi-location businesses (restaurants, retail, franchises).

Role: Google Business Profile Optimization Consultant for multi-location brands.
Audience: Founders/owners/marketing heads of franchise and multi-unit chains globally who rely on Google Maps for local customers.
Tone: Friendly, professional, concise. Confident but not hyped. No jargon (never say "synergy", "leverage").
Goal: Get the recipient interested enough to accept a free GBP audit or a short call. Do not oversell.
Length: Subject 3-8 words. Body 100-150 words, 3-4 short paragraphs.
Never use: "per my last email", "in conclusion", "touching base", generic filler.
Never impersonate an individual at the recipient's company. Never reference private personal data.
Sign off as "[SENDER_NAME] | LocalTuneUp".

CRITICAL: Only reference facts that appear in the Research Notes provided to you. If the notes say information is limited or unconfirmed, do NOT invent specifics (locations, numbers, news) — write a great email anchored on their industry/category instead, staying honest about what's known.

Return your response in EXACTLY this format, nothing before or after, no markdown, no code fences:
SUBJECT: <the subject line, one line only>
BODY:
<the full email body, plain text, blank line between paragraphs>`,
  },

  Zevahit: {
    researchAngle: `This prospect is being considered for Zevahit, a digital PR, link-building, and GEO (AI-search visibility) agency. Focus research on: their industry/niche, whether they're an SEO agency, e-commerce brand, or multi-location business, their approximate online/content presence, and any recent news (funding, launches, press mentions) relevant to a digital PR / backlink pitch.`,
    writeSystemPrompt: `You are writing a cold outreach email as Zevahit, a digital PR, link-building, and GEO (Generative Engine Optimization) agency.

Role: Digital PR & Link-Building Strategist.
Audience: SEO/marketing leads at agencies or brands globally who want better search/AI-visibility through content and authoritative backlinks.
Tone: Authoritative, knowledgeable, courteous, professional but not rigid. Persuasive with concrete points, no vague hype.
Goal: Get the recipient to agree to a short exploratory call or reply with interest. Do not oversell or invent claims.
Length: Subject 3-8 words. Body 100-150 words, 3-4 short paragraphs.
Never use: "touching base", excessive pleasantries, unverifiable claims.
Never impersonate an individual at the recipient's company. Never reference private personal data.
Sign off as "[SENDER_NAME] | Zevahit".

CRITICAL: Only reference facts that appear in the Research Notes provided to you. If the notes say information is limited or unconfirmed, do NOT invent specifics — write a great email anchored on their industry/niche instead, staying honest about what's known.

Return your response in EXACTLY this format, nothing before or after, no markdown, no code fences:
SUBJECT: <the subject line, one line only>
BODY:
<the full email body, plain text, blank line between paragraphs>`,
  },
};

// ---------- Google Sheets helpers ----------

async function getSheetsClient() {
  const credsJson = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
  const auth = new google.auth.GoogleAuth({
    credentials: credsJson,
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });
  const authClient = await auth.getClient();
  return google.sheets({ version: "v4", auth: authClient });
}

async function readLeads(sheets) {
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: `${SHEET_TAB}!A2:H`,
  });
  const rows = res.data.values || [];
  return rows.map((row, idx) => ({
    rowNumber: idx + 2,
    name: row[0] || "",
    company: row[1] || "",
    email: row[2] || "",
    persona: row[3] || "",
    status: row[4] || "",
  }));
}

async function writeResult(sheets, rowNumber, status, researchNotes, subject, body) {
  await sheets.spreadsheets.values.update({
    spreadsheetId: SHEET_ID,
    range: `${SHEET_TAB}!E${rowNumber}:H${rowNumber}`,
    valueInputOption: "RAW",
    requestBody: { values: [[status, researchNotes, subject, body]] },
  });
}

// ---------- Step 1: Research via Gemini + Google Search grounding ----------

async function researchLead(lead) {
  const persona = PERSONAS[lead.persona];
  const prompt = `Research this prospect using web search. 

Person name: ${lead.name || "(unknown)"}
Company/brand name: ${lead.company || "(unknown)"}

${persona.researchAngle}

Return a factual summary under 150 words covering: what the company does, approximate scale (number of locations/stores if applicable), primary city/country, and any notable recent news (last 12 months) if found. Be explicit if you could not confirm something — say "unconfirmed" rather than guessing. Do not fabricate numbers or facts.`;

  const response = await ai.models.generateContent({
    model: RESEARCH_MODEL,
    contents: prompt,
    config: {
      tools: [{ googleSearch: {} }],
      maxOutputTokens: 1000,
      temperature: 0.3,
      thinkingConfig: { thinkingBudget: 0 },
    },
  });

  return response.text.trim();
}

// ---------- Step 2: Personalized email generation ----------

async function writeEmail(lead, researchNotes) {
  const persona = PERSONAS[lead.persona];
  if (!persona) {
    throw new Error(`Unknown persona "${lead.persona}" for ${lead.email}`);
  }

  const userMsg = `Recipient: ${lead.name || "(unknown — use a neutral greeting)"}
Company: ${lead.company || "(unknown — refer to 'your business' generically)"}

Research Notes:
${researchNotes}

Write the outreach email now.`;

  const response = await ai.models.generateContent({
    model: WRITE_MODEL,
    contents: userMsg,
    config: {
      systemInstruction: persona.writeSystemPrompt,
      maxOutputTokens: 1200,
      temperature: 0.7,
      thinkingConfig: { thinkingBudget: 0 },
    },
  });

  const raw = response.text.trim();
  const subjectMatch = raw.match(/SUBJECT:\s*(.+)/i);
  const bodyMatch = raw.match(/BODY:\s*([\s\S]*)/i);

  if (!subjectMatch || !bodyMatch) {
    throw new Error(`Could not parse AI response (missing SUBJECT/BODY). Raw: ${raw.slice(0, 200)}`);
  }

  const subject = subjectMatch[1].trim();
  const body = bodyMatch[1].trim().replace(/\[SENDER_NAME\]/g, SENDER_NAME);
  return { subject, body };
}

// ---------- Main ----------

async function main() {
  const sheets = await getSheetsClient();
  const leads = await readLeads(sheets);

  const pending = leads.filter(
    (l) => l.email && l.persona && (!l.status || l.status.trim() === "")
  );

  console.log(`Found ${pending.length} pending leads. Daily limit: ${DAILY_LEAD_LIMIT}`);

  let processedCount = 0;

  for (const lead of pending) {
    if (processedCount >= DAILY_LEAD_LIMIT) {
      console.log("Daily lead limit reached, stopping for today.");
      break;
    }

    try {
      console.log(`Researching ${lead.company} (${lead.email})...`);
      const researchNotes = await researchLead(lead);
      await new Promise((r) => setTimeout(r, 5000)); // rate-limit spacing

      console.log(`Writing email for ${lead.company}...`);
      const { subject, body } = await writeEmail(lead, researchNotes);

      await writeResult(sheets, lead.rowNumber, "Ready", researchNotes, subject, body);
      console.log(`Done: ${lead.email} — "${subject}"`);
      processedCount++;

      await new Promise((r) => setTimeout(r, 5000)); // rate-limit spacing
    } catch (err) {
      const reason = err.message || String(err);
      await writeResult(sheets, lead.rowNumber, `Failed: ${reason}`, "", "", "");
      console.error(`Failed for ${lead.email}: ${reason}`);
    }
  }

  console.log(`Done. Processed ${processedCount} leads this run.`);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
