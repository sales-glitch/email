# Research + Personalize Bot — Setup (Grok API, for Mailmeteor sending)

This script does NOT write a full email. It researches each lead using Grok's
Live Search (real-time web search) and produces just two personalized pieces
— a Subject line and a short "PersonalizedNote" (opening hook) — which you
insert into your OWN fixed email template as merge tags.

## 1. Update your Google Sheet
Add these columns to the `Leads` tab (header row), in this exact order:

`Name | Company | Email | Persona | Status | ResearchNotes | Subject | PersonalizedNote`

- `Persona` must be exactly `LocalTuneUp` or `Zevahit`.
- Leave `Status`, `ResearchNotes`, `Subject`, `PersonalizedNote` empty — the bot fills them.
- Add your leads: just Name, Company, Email, Persona are required per row.

## 2. GitHub Secrets
- `XAI_API_KEY` — your Grok API key from console.x.ai (this replaces GEMINI_API_KEY;
  delete the old Gemini secret if you want, it's no longer used)
- `GOOGLE_SERVICE_ACCOUNT_JSON` — unchanged from before
- `SHEET_ID` — unchanged from before

## 3. Run it
Actions tab → "Research and Personalize Leads (for Mailmeteor)" → Run workflow.

Check the Sheet: `Status` should say `Ready`, with `ResearchNotes`, `Subject`,
and `PersonalizedNote` filled in.

## 4. Build your Mailmeteor template
Write your full email once, with the two merge tags dropped in wherever they
belong. Example for LocalTuneUp:

```
Subject: {{Subject}}

Hi {{Name}},

{{PersonalizedNote}}

At LocalTuneUp, we help multi-location businesses like yours get more
visibility on Google Maps and attract more walk-in customers through
optimized Google Business Profiles.

Would you be open to a quick call this week to see how it could work
for {{Company}}?

Best,
Salman | LocalTuneUp
```

Everything except `{{Subject}}`, `{{PersonalizedNote}}`, `{{Name}}`, and
`{{Company}}` stays fixed across every email.

## Notes on cost
- xAI does not have a guaranteed free API tier — you pay per token plus a
  per-call fee for the web_search tool (check console.x.ai for your current
  rate; historically around $5 per 1,000 tool calls, on top of token costs).
- 100 leads/day = 100 web_search-enabled research calls + 100 plain
  writing calls. Check your xAI console spend dashboard after the first
  run to confirm actual cost before scaling up.
- If research comes back thin for a lead (small business, no online footprint),
  the note will honestly lean on industry/category framing instead of
  inventing details — worth spot-checking a sample of `PersonalizedNote`
  values before a big send.
