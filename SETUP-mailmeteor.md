# Research + Personalize Bot — Setup (for Mailmeteor sending)

This is a SEPARATE workflow from the earlier Gmail-SMTP sender. This one only
researches leads and writes personalized subject/body into your Sheet.
Mailmeteor then sends from that same Sheet.

## 1. Update your Google Sheet
Add these columns to the `Leads` tab (header row), in this exact order:

`Name | Company | Email | Persona | Status | ResearchNotes | Subject | Body`

- `Persona` must be exactly `LocalTuneUp` or `Zevahit`.
- Leave `Status`, `ResearchNotes`, `Subject`, `Body` empty — the bot fills them.
- Add your leads: just Name, Company, Email, Persona are required per row.

## 2. Reuse your existing secrets
You already have these from the earlier setup — no changes needed:
- `GEMINI_API_KEY`
- `GOOGLE_SERVICE_ACCOUNT_JSON`
- `SHEET_ID`

(`GMAIL_USER` / `GMAIL_APP_PASSWORD` are not used by this workflow — you can
leave them as-is, they're only used by the other workflow if you still have it.)

## 3. Run it
- Actions tab → "Research and Personalize Leads (for Mailmeteor)" → Run workflow
- Check the Sheet: `Status` should say `Ready`, and `ResearchNotes`, `Subject`,
  `Body` should be filled in with content that references real details about
  the company (or an honest "industry-based" angle if research came up short).

## 4. Set up the Mailmeteor merge
In your Gmail draft (the one Mailmeteor uses as the template):
- Subject field: `{{Subject}}`
- Body: `{{Body}}`

This makes Mailmeteor substitute the ENTIRE subject and body per contact from
the Sheet columns, rather than just inserting a name into a fixed template —
so each email is fully custom, not just a mail-merge with blanks filled in.

Run the Mailmeteor merge as usual once the Sheet shows `Status = Ready` for
the leads you want to send to.

## Notes on cost / rate limits
- Each lead makes 2 Gemini calls (research with Google Search grounding, then
  writing). Google Search grounding is billed per call — check current pricing
  at ai.google.dev/gemini-api/docs/pricing before running at full 100/day
  volume, since grounding isn't always covered by the free tier.
- There's a 5-second delay built in between calls to stay under rate limits.
  100 leads ≈ 100 × (2 calls + 10s delay) — expect the run to take roughly
  20-30 minutes.
- If research comes back thin (e.g. a very small/local business with no online
  footprint), the bot is instructed to stay honest rather than invent details —
  the email will lean on industry/category framing instead. Worth spot-checking
  a sample of `ResearchNotes` before a big send to make sure quality holds up.
