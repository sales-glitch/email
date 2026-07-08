/**
 * Research + Personalize Bot (for Mailmeteor)
 * LocalTuneUp + Zevahit — Google Sheets + Gemini (with Google Search grounding)
 *
 * This script does NOT send emails and does NOT write a full email body.
 * It:
 *  1. Reads leads from a Google Sheet (Name, Company, Email, Persona)
 *  2. RESEARCHES each lead using Gemini's built-in Google Search grounding
 *     (finds info about the company/brand starting from just its name)
 *  3. Writes a short PERSONALIZED SUBJECT and a 2-4 sentence PERSONALIZED NOTE
 *     (an opening-hook paragraph referencing real researched details)
 *  4. Writes ResearchNotes, Subject, PersonalizedNote, Status back to the Sheet
 *
 * YOU build the rest of the email as a fixed template in your Mailmeteor
 * Gmail draft, and insert {{Subject}} and {{PersonalizedNote}} as merge tags
 * wherever they belong (subject line, and the opening hook of the body).
 * Everything else in the template (value prop, CTA, signature) stays fixed.
 *
 * Required GitHub Secrets:
 *  - GEMINI_API_KEY                Gemini API key from Google AI Studio
 *  - GOOGLE_SERVICE_ACCOUNT_JSON   full JSON key (as one-line string) for a service account
 *                                   that has Editor access to the target Sheet
 *  - SHEET_ID                      the Google Sheet ID (from its URL)
 *
 * Sheet tab must be named "Leads" with header row:
 *  Name | Company | Email | Persona | Status | ResearchNotes | Subject | PersonalizedNote
 *  Persona column value must be exactly "LocalTuneUp" or "Zevahit"
 *  Leave Status empty for leads not yet processed.
 */

import { google } from "googleapis";
import { GoogleGenAI } from "@google/genai";

const SHEET_ID = process.env.SHEET_ID;
const SHEET_TAB = "Leads";
const DAILY_LEAD_LIMIT = parseInt(process.env.DAILY_LEAD_LIMIT || "100", 10);

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
const RESEARCH_MODEL = "gemini-2.5-flash";
const WRITE_MODEL = "gemini-2.5-flash";

// ---------- Persona context (brand angle used to steer research + writing) ----------

const PERSONAS = {
  LocalTuneUp: {
    researchAngle: `This prospect is being considered for LocalTuneUp, a Google Business Profile / local SEO service for multi-location businesses (restaurants, retail, franchises). Focus research on: how many physical locations/stores they run, which cities/countries, what industry/cuisine/category, and any recent expansion, funding, or new-location news. If possible, note whether they seem to rely on walk-in/local customers (which makes Google Maps visibility relevant to them).`,
    writeSystemPrompt: `You are writing a short personalized subject line and opening note for a cold outreach email from LocalTuneUp, a Google Business Profile / local SEO optimization service for multi-location businesses.

You are NOT writing the full email — only two things:
1. A subject line (3-8 words)
2. A "personalized note" — a 2-4 sentence opening hook that will be inserted into a fixed email template. It should reference something specific and real about the recipient's company (from the Research Notes) to prove this isn't a generic mass email.

Tone: Friendly, professional, concise. Confident but not hyped. No jargon.
Never use: "per my last email", "in conclusion", "touching base", generic filler.
Never impersonate an individual at the recipient's company. Never reference private personal data.
Subject line rule: keep it GENERIC-but-relevant to the LocalTuneUp pitch (curiosity or value-driven). Do NOT put the company name or any specific researched detail in the subject — that hurts deliverability and can feel spammy. All personalization/specificity belongs only in the note, never the subject.

CRITICAL: Only reference facts that appear in the Research Notes provided to you. If the notes say information is limited or unconfirmed, do NOT invent specifics (locations, numbers, news) — instead write a genuine, honest note anchored on their industry/category (e.g. "Running a multi-location [industry] business means Google Maps visibility across every outlet directly affects walk-ins.").

Return your response in EXACTLY this format, nothing before or after, no markdown, no code fences:
SUBJECT: <the subject line, one line only>
NOTE:
<the 2-4 sentence personalized opening note>`,
  },

  Zevahit: {
    researchAngle: `This prospect is being considered for Zevahit, a digital PR, link-building, and GEO (AI-search visibility) agency. Focus research on: their industry/niche, whether they're an SEO agency, e-commerce brand, or multi-location business, their approximate online/content presence, and any recent news (funding, launches, press mentions) relevant to a digital PR / backlink pitch.`,
    writeSystemPrompt: `You are writing a short personalized subject line and opening note for a cold outreach email from Zevahit, a digital PR, link-building, and GEO (Generative Engine Optimization) agency.

You are NOT writing the full email — only two things:
1. A subject line (3-8 words)
2. A "personalized note" — a 2-4 sentence opening hook that will be inserted into a fixed email template. It should reference something specific and real about the recipient's company (from the Research Notes) to prove this isn't a generic mass email.

Tone: Authoritative, knowledgeable, courteous, professional but not rigid.
Never use: "touching base", excessive pleasantries, unverifiable claims.
Never impersonate an individual at the recipient's company. Never reference private personal data.
Subject line rule: keep it GENERIC-but-relevant to the Zevahit pitch (curiosity or value-driven). Do NOT put the company name or any specific researched detail in the subject — that hurts deliverability and can feel spammy. All personalization/specificity belongs only in the note, never the subject.

CRITICAL: Only reference facts that appear in the Research Notes provided to you. If the notes say information is limited or unconfirmed, do NOT invent specifics — instead write a genuine, honest note anchored on their industry/niche (e.g. "Growing an audience in [industry] usually means backlinks and press mentions matter more every quarter.").

Return your response in EXACTLY this format, nothing before or after, no markdown, no code fences:
SUBJECT: <the subject line, one line only>
NOTE:
<the 2-4 sentence personalized opening note>`,
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

async function writeResult(sheets, rowNumber, status, researchNotes, subject, personalizedNote) {
  await sheets.spreadsheets.values.update({
    spreadsheetId: SHEET_ID,
    range: `${SHEET_TAB}!E${rowNumber}:H${rowNumber}`,
    valueInputOption: "RAW",
    requestBody: { values: [[status, researchNotes, subject, personalizedNote]] },
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

// ---------- Step 2: Personalized subject + note generation ----------

async function writeNote(lead, researchNotes) {
  const persona = PERSONAS[lead.persona];
  if (!persona) {
    throw new Error(`Unknown persona "${lead.persona}" for ${lead.email}`);
  }

  const userMsg = `Recipient: ${lead.name || "(unknown — use a neutral greeting)"}
Company: ${lead.company || "(unknown — refer to 'your business' generically)"}

Research Notes:
${researchNotes}

Write the subject line and personalized note now.`;

  const response = await ai.models.generateContent({
    model: WRITE_MODEL,
    contents: userMsg,
    config: {
      systemInstruction: persona.writeSystemPrompt,
      maxOutputTokens: 600,
      temperature: 0.7,
      thinkingConfig: { thinkingBudget: 0 },
    },
  });

  const raw = response.text.trim();
  const subjectMatch = raw.match(/SUBJECT:\s*(.+)/i);
  const noteMatch = raw.match(/NOTE:\s*([\s\S]*)/i);

  if (!subjectMatch || !noteMatch) {
    throw new Error(`Could not parse AI response (missing SUBJECT/NOTE). Raw: ${raw.slice(0, 200)}`);
  }

  const subject = subjectMatch[1].trim();
  const personalizedNote = noteMatch[1].trim();
  return { subject, personalizedNote };
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
      await new Promise((r) => setTimeout(r, 5000));

      console.log(`Writing note for ${lead.company}...`);
      const { subject, personalizedNote } = await writeNote(lead, researchNotes);

      await writeResult(sheets, lead.rowNumber, "Ready", researchNotes, subject, personalizedNote);
      console.log(`Done: ${lead.email} — "${subject}"`);
      processedCount++;

      await new Promise((r) => setTimeout(r, 5000));
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
