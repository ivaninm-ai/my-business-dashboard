# Instructor test script — fresh student simulation (1.2.0-rc.1)

You act as a student with a fresh GitHub account, a fresh Google Cloud project, a Google
AI Studio key and the synthetic BetterSpace records. Follow **only** `STUDENT_SOP.md` (or
the installation guide). Record every extra instruction, error, and support intervention
in the table at the end; each is a usability defect to fix in the template or guide.

Estimated time: 60–75 minutes (each source preparation waits for a GitHub Actions run).
Synthetic data only: choose *Synthetic practice records · free tier* in Business setup.

## Preparation (instructor, before acting as a student)

1. Publish the template repository (public) with release tag `v1.2.0-rc.1` and enable
   "Template repository" in its settings.
2. Upload `01_B2C_Retail/BetterSpace_B2C.xlsx` to Google Drive **as a native Google Sheet**
   (File → Save as Google Sheets). Keep General access Restricted. Do not modify the
   original file.
3. For Part D, keep local copies of the B2B CSVs (`02_B2B_Furniture/csv/`) and a
   text-based PDF export of `Payments.csv` (print to PDF from a spreadsheet app).
4. Have a Google AI Studio account ready. No Claude account or Skill is needed.

## Part A — Installation (SOP steps 1–6)

| # | Action | Expected | Result / time |
|---|---|---|---|
| A1 | Create repository from template | Repo with `app/`, `worker/`, `docs/`, `prompts/` | |
| A2 | Google Cloud project + Sheets API + consent screen (Testing, self as test user) + OAuth web client with origin `https://<name>.github.io` + service account + JSON key | Client ID, SA e-mail, key file | |
| A3 | Google AI Studio → create API key. Secrets `GOOGLE_SERVICE_ACCOUNT_JSON`, `GEMINI_API_KEY`; variable `GOOGLE_OAUTH_CLIENT_ID` | Saved | |
| A4 | Pages → GitHub Actions; run **4 · Publish dashboard** | Run builds the file readers (`npm run build`); summary shows site URL; site shows *Connect Google* | |
| A5 | Connect Google with the test-user account | Consent shows only "See, edit, create, and delete only the specific Google Drive files you use with this app" | |
| A6 | Create workspace | Data connections shows Workspace ID; a "Dashboard Workspace" Sheet exists in Drive | |
| A7 | Save SA e-mail; add secret `DASHBOARD_WORKSPACE_ID`; share workspace with SA as Editor | — | |
| A8 | Run **1 · Install check** | All ✅ including *GEMINI_API_KEY secret present*, except *Setup package* (not configured yet) | |
| A9 | **Denial test:** open the site in a private window and sign in with a *different* Google account (not a test user) | Google blocks sign-in (Testing audience) — no data visible. Then add that account as a test user, sign in, paste the workspace ID → *Google did not allow access* — still no data | |

## Part B — Business setup with Gemini (SOP steps 7–8)

| # | Action | Expected | Result |
|---|---|---|---|
| B1 | Settings → Business setup: name, type, language, currency, timezone, priorities; AI data setting *Synthetic*; Report date *Latest record date*; **Save business profile**; reload the page | All values, including Report date, are still shown after reload | |
| B2 | Add a new source → Live Google Sheet → paste the B2C Sheet link; share it with the SA as Viewer; **Prepare source** | *Waiting for the worker*; nothing activated | |
| B3 | **Open Import data → Run workflow**; wait; **Reload** | *Ready for review*. The run's *Prepare pending source* step is green; the import step reports *no_setup* (normal before the first activation) | |
| B4 | **Review detected records** | Four tables proposed (customers, sales, payments, stock) with the Sheet's own column names; statuses split into pending/done/excluded. Record every wrong guess in the obstacles log | |
| B5 | Change the sales *amount* to *Not provided*; tick the box; **Validate and preview totals** | Rejected: *required field sales.amount is not mapped*; nothing saved | |
| B6 | Restore it; validate; compare counts 120/320/300/12 and the amount column totals with the Sheet; **Activate source** | *Source activated*; banner asks you to run Import data | |
| B7 | Run **2 · Import data** → Reload | Badge *data as of 30 Aug 2026*; Overview: RM 25,650 August order value, 104 orders, outstanding RM 0, 3 low-stock items, 8 overdue completions | |
| B8 | Remove the SA's Viewer permission on the source; run import | Run fails with the *share as Viewer* message; badge *stale — last import failed*; figures unchanged | |
| B9 | Restore Viewer; run import | *unchanged* or *success*; badge green | |

## Part C — Tasks, calendar, refresh (SOP step 9)

| # | Action | Expected | Result |
|---|---|---|---|
| C1 | Tasks: accept `completion_overdue:RS-001`, complete `review_replenishment:R003` with a note, dismiss one, edit one date | Toast *Saved to your workspace*; Task_Decisions tab in the workbook has the rows | |
| C2 | Sign out, close browser, reopen, reconnect | Decisions unchanged; no business text visible before sign-in | |
| C3 | Calendar | Recorded deadlines (orange), accepted task dates (blue), overdue (red); no invented times | |
| C4 | In the source Sheet change Stock R003 on_hand 8 → 33; run import; Reload | Low-stock 3 → 2; R003 task shows *resolved by data* with your note kept; no duplicate tasks | |
| C5 | Replace all four tabs with the Day 2 workbook contents (full replacement); import | Badge *data as of 31 Aug 2026*; 105 orders, RM 25,735; overdue completions 10; RS-001 completion task resolved; decisions kept | |
| C6 | Rename header `total_amount` to `Total (RM)` in the source; import | Failed with *Column "total_amount" … Headers found: … "Total (RM)"*; previous data still shown | |
| C7 | Rename it back; import | Success | |

## Part D — Mixed sources and file replacement (new workspace, B2B pack)

| # | Action | Expected | Result |
|---|---|---|---|
| D1 | New workspace. Sheet source from `BetterSpace_B2B.xlsx` (native Google Sheet): keep Customers + Sales, set Payments and Stock to *Ignore* | Preview: 45 customers, 90 sales | |
| D2 | Local file: the payments PDF, *File data as of* 2026-08-30 → prepare → run → review | Extracted table visible under *view records*; compare every row; preview 146 payments, amount column total RM 532,550 | |
| D3 | Local file: `Stock.csv` → prepare → run → review → activate; run import | Overview: RM 231,060 August; cash RM 193,765; outstanding RM 91,090; overdue RM 30,515; low stock 3 | |
| D4 | Accept `review_replenishment:T001`. Save a copy of Stock as XLSX with T001 on_hand 999. Data connections → *Update this file in Business setup* → *Update / remap: <stock source>* → the XLSX → prepare → run → review → activate → import | Low stock 3 → 2; payments still 146; the Sheet link unchanged; T001 decision kept | |
| D5 | Try a scanned (image-only) PDF and a `.txt` file | Rejected in the browser with a clear message; nothing queued | |

## Part E — AI brief

| # | Action | Expected | Result |
|---|---|---|---|
| E1 | After a successful import | *AI brief after a completed refresh* step green; AI insights shows headline, priorities referencing existing task keys, data caveats, snapshot/model (`gemini-3.5-flash-lite…`)/rules; language follows Business setup | |
| E2 | Replace `GEMINI_API_KEY` with a wrong value; run **3 · AI brief** | *Gemini rejected the API key*; earlier brief still readable | |
| E3 | Change AI data setting to *Real business records* on a project without billing; request a brief | Record what happens (free-tier projects may still answer — the setting records the owner's choice and cannot verify billing) | |
| E4 | Restore the key | Next brief completes | |

## Part F — Backup, update, second layout

| # | Action | Expected | Result |
|---|---|---|---|
| F1 | Settings → Export backup | JSON file downloads; contains settings, links, decisions, notes and saved file records; no `Data_*` snapshot rows and no keys | |
| F2 | Create a second workspace on the same account; Restore from backup; run import | Decisions, links and file sources restored; data re-imported | |
| F3 | Run **5 · Update from template** with the current tag | *Already up to date* or a commit; workspace untouched; Install check ✅ | |
| F4 | (Optional) Repeat Part B with `test/fixtures/alt-service-studio` CSVs pasted into a Sheet | Stock section hidden; RM 1,910 August; overdue RM 800 | |

## Obstacles log

| Step | What happened | Extra instruction needed | Fix (template / guide / SOP) |
|---|---|---|---|
| | | | |

Acceptance: every checkpoint met; the obstacles log contains no item that requires a
terminal, code editing, a chat assistant, or a step missing from the SOP.
