# Release notes

## 1.2.0-rc.3 — 23 September 2026

- **Chinese interface.** The dashboard, the worker's messages, generated task titles and
  reasons, install-check results and GitHub run summaries are in Simplified Chinese by
  default. Menu items, buttons and the setup controls named in the guide read
  `中文（English）`, so the guide, screenshots and search results still match.
- One language setting: **Settings › Business setup › 语言（Language）** — 中文 (default),
  English, or Bahasa Melayu (Malay brief, English screens). It controls the screens,
  the task text written at the next import, and the AI brief. The previous "Brief
  language" field is this setting; profiles saved with English stay English until changed.
- Dates follow the language (2026年8月30日). Owners' own data (names, status words,
  column names) is never translated. Gemini is asked to write setup notes in the same
  language.
- Implementation: `app/shared/i18n.mjs` (helpers) and `app/shared/i18n-zh.mjs` (≈800
  strings). English stays as the fallback. `test/i18n.test.mjs` fails if any interface
  text lacks a Chinese translation or its placeholders differ. The optional
  `DASHBOARD_LANGUAGE` environment variable forces the worker's language (tests use it).
- The installation guide names every dashboard button and message by its new label.
- Worker, app and prompt changes; no workflow files changed. Update 1.2.0-rc.1/rc.2
  installations with *5 · Update from template* → `v1.2.0-rc.3`, then *4 · Publish
  dashboard* (required: the screens changed).
- 54 automated tests.

## 1.2.0-rc.2 — 23 September 2026

- Fix: source preparation failed with *Gemini returned an invalid proposal* on the first
  real Gemini call. The setup request now sends Gemini a strict answer template
  (structured output), accepts a missing or single-sentence `notes` field, and — if a
  reply is still unusable — names the fields Gemini returned (never their values).
- Worker and prompt only; no workflow files changed. Existing 1.2.0-rc.1 installations
  update with *5 · Update from template* → tag `v1.2.0-rc.2`, then *4 · Publish dashboard*.
- 50 automated tests.

## 1.2.0-rc.1 — local candidate, 23 September 2026

**Students no longer use Claude.** Setup happens inside the dashboard; background AI is
Gemini, run by the student's own GitHub Actions worker.

- **Business setup** (Settings): business profile (name, type, description, brief
  language, currency, timezone, AI priorities), AI data setting and report-date rule,
  then one source at a time: live Google Sheet or local XLSX / CSV / text PDF / DOCX.
  *Prepare source* queues a request; the *Import data* workflow asks Gemini for a
  proposal; the owner reviews row meanings, column choices, date format and statuses,
  previews counts/totals and clicks *Activate source*. Nothing is used before activation.
  Replaces the onboarding Skill ZIP, the setup-package JSON import and the
  source-update.json route.
- **Gemini instead of Anthropic**: secret `GEMINI_API_KEY` (Google AI Studio), default
  model `gemini-3.5-flash-lite`, key sent only in the `x-goog-api-key` header by the
  worker. Instructions live in `prompts/data_mapping.md` and `prompts/daily_brief.md`.
  The brief follows the chosen language. Quota/key/model errors are explained; figures
  keep updating when AI fails.
- **AI data setting**: AI calls are refused until the owner chooses *synthetic practice
  records (free tier)* or *real records (billing-enabled project)*; Google's unpaid tier
  must not receive personal or confidential data.
- **Local files** are read in the browser (read-excel-file, Papa Parse, pdf.js, mammoth),
  bundled at publish time by `npm run build` into `app/vendor/` (not committed). Limits:
  10 MB, 12 sheets, 5,000 rows per table, 50 PDF pages, 80,000 text characters; scanned
  PDFs are rejected. A file is replaced under its existing source (*Update / remap*);
  replacement is whole-file only — 1.1.0's append and corrected-record modes are not
  offered in the dashboard.
- Install check now fails when `GEMINI_API_KEY` is missing (setup cannot work without it).
- Workflows changed: `import.yml` (new *Prepare pending source* step, Gemini key),
  `ai.yml`, `install-check.yml`, `deploy-pages.yml` (`npm ci` + `npm run build`),
  `tests.yml` (build before test), `update-template.yml` (copies `prompts/`, tag default).
- Fixed while finishing this candidate: every PDF failed in the browser
  (`destroy is not a function` with pdf.js 6); the Report date choice reset to *Today*
  after *Save business profile* before the first activation; preview totals are now
  labelled as raw column sums; order-status fields appear only when a sales table is
  selected; the post-activation banner no longer points to the old connection step;
  scheduled runs finish quietly until the keys are added, so a new repository no longer
  e-mails "Run failed" every hour during installation (manual runs still report it).
- **Upgrade:** installing 1.2.0 over 1.1.0 with *5 · Update from template* is not
  supported (the old workflow does not copy `prompts/`; six workflow files changed).
  Install fresh, then restore a backup.
- Verified locally: 48 automated tests (simulated Google API, mocked Gemini) and a
  browser walkthrough with the real file readers against the simulated Google API and a
  local Gemini stand-in (Sheet + text PDF + BOM CSV → expected B2B figures; XLSX
  replacement; quota failure and retry; scanned PDF and .txt rejection). **Not verified:**
  real Google OAuth/Sheets, GitHub Pages/Actions, and real Gemini calls (mapping quality,
  PDF extraction accuracy, free-tier quota). No release has been published.

## 1.1.0-rc.1 — local candidate, 23 September 2026

- Source-specific reviewed file updates: replace / append / full-record upsert, with
  preview, stable IDs, duplicate checks, data dates and pending-import messaging.
- Daily AI includes business profile, task notes, upcoming calendar and explicit
  source freshness. Completed/dismissed/resolved task references are filtered out.
- Skipped or failed scheduled imports no longer trigger automatic paid AI runs.
  AI_AUTO=off still permits queued requests after successful refreshes.
- Reporting dates advance in business timezone; changed policies invalidate the
  import cache even when source rows are identical.
- Interrupted snapshot writes block figures and AI until rebuilt. Task date/owner
  clearing is preserved. Import/AI public summaries no longer print record details.
- Updated local installation guide and onboarding Skill file-update instructions.
  Saved-file data in backups is now disclosed.
- Real Google OAuth/Sheets, GitHub scheduling, Anthropic calls and Skill use in
  Claude remain unverified. No release has been published.

## 1.0.0 — 22 September 2026 (first release; build verified in simulation only)

**Architecture:** static dashboard on GitHub Pages + GitHub Actions worker + student-owned
Google Sheets (source workbooks read-only; one managed *Dashboard Workspace* for
settings, snapshots, tasks, calendar, AI results). No database service, no Apps Script,
no proxy. Browser authorisation uses Google Identity Services with the `drive.file`
scope; the workspace is created by the app so no Google Picker or browser API key is
needed.

**Included**
- Dashboard: Overview, Sales, Customers, Payments, Stock, Tasks, Calendar, AI insights,
  Data connections, Settings. Sections without a mapped table are hidden.
- Deterministic metrics (METRIC_RULES generalised): booked order value, cash by payment
  date, outstanding/overdue balances, pending/overdue completions, stock availability,
  follow-ups, repeat customers, prior-period comparison, monthly trend.
- Task engine: seven catalogue rules, stable keys (`rule:record_id`), recorded deadlines
  separate from suggested dates, decisions preserved across refreshes, resolved-by-data
  reconciliation, stale flag, custom tasks, in-app calendar with notes.
- AI worker (Anthropic Messages API, structured JSON output, default model
  `claude-opus-5`, configurable through `AI_MODEL`): brief with headline, priorities that
  reference existing task keys only, watch items and data caveats; queued requests from
  the dashboard; failures recorded, never affecting metrics.
- Worker: install check, scheduled/manual import with full validation before any write,
  snapshot history, lease + workflow concurrency group, retention limits.
- Setup-package contract v1.0 with schema, validator (JS + Python mirror) and three
  examples (B2C retail, B2B furniture, service clinic without stock).
- Prepared workflows: 1 Install check · 2 Import data · 3 AI brief · 4 Publish dashboard ·
  5 Update from template (+ maintainer tests).
- Student SOP, troubleshooting by symptom, instructor test script, limitations,
  backup/restore, update guide, source-support matrix.

**Verified (simulated Google API and mocked AI provider — see `../EVIDENCE.md`)**
- 31 automated tests: fixture reconciliation for BetterSpace B2C/B2B Day 1 and Day 2
  (all totals and alert-ID sets), second header layout, service layout with text
  dates/money and no stock, changed headers, duplicate/blank IDs, partial failure,
  permission removal, lease, invalid package rejection, backup/restore, template-update
  safety, AI success/failure/missing-key/queue.
- Browser walkthrough of the first complete path in the built-in browser against the
  simulation: sign-in → create workspace → import package → connect source → worker
  import → dashboard → three task decisions → Day 2 refresh → reload → decisions kept,
  no duplicates → AI request queued → failure labelled → sign-out clears data.

**Not verified in this release (requires the owner's accounts)**
- Live Google OAuth consent/Testing-audience behaviour, Sheets API calls, Pages
  deployment, Actions schedule, Anthropic API call, GitHub template flow. The instructor
  test script covers these.

**Known limitations** — see `LIMITATIONS.md`.
