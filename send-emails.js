/**
 * Personalized Email Outreach Bot
 * LocalTuneUp + Zevahit — GitHub Actions + Google Sheets + Claude + Gmail SMTP
 *
 * Flow:
 *  1. Read rows from Google Sheet (Name, Company, Email, Persona, Notes, Status)
 *  2. For each row with empty Status: call Claude to write a personalized subject+body
 *  3. Send via Gmail/Workspace SMTP (Nodemailer)
 *  4. Write back Status ("Sent" / "Failed: <reason>") + Timestamp + Subject used
 *
 * Required GitHub Secrets:
 *  - GMAIL_USER               your sending address, e.g. salman@localtuneup.com
 *  - GMAIL_APP_PASSWORD       16-char Gmail/Workspace app password
 *  - GEMINI_API_KEY           Gemini API key from Google AI Studio (aistudio.google.com)
 *  - GOOGLE_SERVICE_ACCOUNT_JSON   full JSON key (as one-line string) for a service account
 *                                   that has Editor access to the target Sheet
 *  - SHEET_ID                 the Google Sheet ID (from its URL)
 *
 * Sheet tab must be named "Leads" with header row:
 *  Name | Company | Email | Persona | Notes | Status | SentAt | SubjectUsed
 *  Persona column value must be exactly "LocalTuneUp" or "Zevahit"
 */

const nodemailer = require("nodemailer");
const { google } = require("googleapis");
const { GoogleGenerativeAI } = require("@google/generative-ai");

const SHEET_ID = process.env.SHEET_ID;
const SHEET_TAB = "Leads";
const DAILY_SEND_LIMIT = parseInt(process.env.DAILY_SEND_LIMIT || "80", 10); // stay under Gmail's ~500/day, leave headroom

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const geminiModel = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });

// ---------- Persona system prompts (from brand guidelines) ----------

const PERSONAS = {
  LocalTuneUp: `You are writing a cold outreach email as LocalTuneUp, a Google Business Profile / local SEO optimization service for multi-location businesses (restaurants, retail, franchises).

Role: Google Business Profile Optimization Consultant for multi-location brands.
Audience: Founders/owners/marketing heads of franchise and multi-unit chains who rely on Google Maps for local customers.
Tone: Friendly, professional, concise. Confident but not hyped. No jargon (never say "synergy", "leverage").
Goal: Get the recipient interested enough to accept a free GBP audit or a short call. Do not oversell.
Length: Subject 3-8 words. Body 100-150 words, 3-4 short paragraphs.
Never use: "per my last email", "in conclusion", "touching base", generic filler, or any invented statistics/case studies not provided in the notes.
Never impersonate an individual at the recipient's company. Never request or reference private personal data.
Sign off as "[Sender Name] | LocalTuneUp" — sender name will be provided separately, just leave a placeholder [SENDER_NAME].

Return ONLY valid JSON, no markdown fences, in this exact shape:
{"subject": "...", "body": "..."}
The body should be plain text with \\n\\n between paragraphs (no HTML).`,

  Zevahit: `You are writing a cold outreach email as Zevahit, a digital PR, link-building, and GEO (Generative Engine Optimization) agency.

Role: Digital PR & Link-Building Strategist.
Audience: SEO/marketing leads at agencies or brands who want better search/AI-visibility through content and authoritative backlinks.
Tone: Authoritative, knowledgeable, courteous, professional but not rigid. Persuasive with concrete points, no vague hype.
Goal: Get the recipient to agree to a short exploratory call or reply with interest. Do not oversell or invent claims.
Length: Subject 3-8 words. Body 100-150 words, 3-4 short paragraphs.
Never use: "touching base", excessive pleasantries, unverifiable claims, or invented statistics/case studies not provided in the notes.
Never impersonate an individual at the recipient's company. Never request or reference private personal data.
Sign off as "[Sender Name] | Zevahit" — sender name will be provided separately, just leave a placeholder [SENDER_NAME].

Return ONLY valid JSON, no markdown fences, in this exact shape:
{"subject": "...", "body": "..."}
The body should be plain text with \\n\\n between paragraphs (no HTML).`,
};

const SENDER_NAME = process.env.SENDER_NAME || "Salman";

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
    range: `${SHEET_TAB}!A2:H`, // skip header row
  });
  const rows = res.data.values || [];
  return rows.map((row, idx) => ({
    rowNumber: idx + 2, // actual sheet row (1-indexed, +1 for header)
    name: row[0] || "",
    company: row[1] || "",
    email: row[2] || "",
    persona: row[3] || "",
    notes: row[4] || "",
    status: row[5] || "",
  }));
}

async function writeStatus(sheets, rowNumber, status, sentAt, subjectUsed) {
  await sheets.spreadsheets.values.update({
    spreadsheetId: SHEET_ID,
    range: `${SHEET_TAB}!F${rowNumber}:H${rowNumber}`,
    valueInputOption: "RAW",
    requestBody: { values: [[status, sentAt, subjectUsed]] },
  });
}

// ---------- Claude personalization ----------

async function personalize(lead) {
  const systemPrompt = PERSONAS[lead.persona];
  if (!systemPrompt) {
    throw new Error(`Unknown persona "${lead.persona}" for ${lead.email}`);
  }

  const userMsg = `Recipient details:
Name: ${lead.name || "(unknown — use a neutral greeting like 'Hello there')"}
Company: ${lead.company || "(unknown — refer to 'your business' generically)"}
Notes/context: ${lead.notes || "(none provided)"}

Write the outreach email now.`;

  const result = await geminiModel.generateContent({
    contents: [{ role: "user", parts: [{ text: userMsg }] }],
    systemInstruction: { role: "system", parts: [{ text: systemPrompt }] },
    generationConfig: { maxOutputTokens: 600, temperature: 0.7 },
  });

  const raw = result.response
    .text()
    .replace(/```json|```/g, "")
    .trim();

  const parsed = JSON.parse(raw);
  const body = parsed.body.replace(/\[SENDER_NAME\]/g, SENDER_NAME);
  return { subject: parsed.subject, body };
}

// ---------- Email sending ----------

function getTransporter() {
  return nodemailer.createTransport({
    service: "gmail",
    auth: {
      user: process.env.GMAIL_USER,
      pass: process.env.GMAIL_APP_PASSWORD,
    },
  });
}

async function sendEmail(transporter, to, subject, body) {
  await transporter.sendMail({
    from: `"${SENDER_NAME}" <${process.env.GMAIL_USER}>`,
    to,
    subject,
    text: body,
  });
}

// ---------- Main ----------

async function main() {
  const sheets = await getSheetsClient();
  const transporter = getTransporter();
  const leads = await readLeads(sheets);

  const pending = leads.filter(
    (l) => l.email && l.persona && (!l.status || l.status.trim() === "")
  );

  console.log(`Found ${pending.length} pending leads. Daily limit: ${DAILY_SEND_LIMIT}`);

  let sentCount = 0;

  for (const lead of pending) {
    if (sentCount >= DAILY_SEND_LIMIT) {
      console.log("Daily send limit reached, stopping for today.");
      break;
    }

    try {
      const { subject, body } = await personalize(lead);
      await sendEmail(transporter, lead.email, subject, body);
      await writeStatus(sheets, lead.rowNumber, "Sent", new Date().toISOString(), subject);
      console.log(`Sent to ${lead.email} (${lead.persona}) — "${subject}"`);
      sentCount++;

      // small delay to avoid Gmail rate-limit flags
      await new Promise((r) => setTimeout(r, 4000));
    } catch (err) {
      const reason = err.message || String(err);
      await writeStatus(sheets, lead.rowNumber, `Failed: ${reason}`, new Date().toISOString(), "");
      console.error(`Failed for ${lead.email}: ${reason}`);
    }
  }

  console.log(`Done. Sent ${sentCount} emails this run.`);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
