# Troubleshooting — by what you see

| You see | Cause | Fix |
|---|---|---|
| Site shows **Not configured yet** | Variable `GOOGLE_OAUTH_CLIENT_ID` missing/misspelled, or the site was published before it was set | Add the variable (Settings › Secrets and variables › Actions › **Variables**), run **4 · Publish dashboard** again |
| Site is 404 | Pages source not set to *GitHub Actions*, or the publish workflow has not run | Settings › Pages › Source = GitHub Actions; run **4 · Publish dashboard**; open the URL from the run summary |
| Google: **Access blocked: … has not completed the Google verification process** | Your e-mail is not a test user while the consent screen is in Testing | Google Auth Platform › Audience › add your e-mail as test user; sign in with exactly that account |
| Google: **Error 400: redirect_uri_mismatch / origin_mismatch** | The Authorized JavaScript origin is missing or differs from the site origin | Credentials › your OAuth client › add `https://<your-github-name>.github.io` (lowercase, no path) |
| Google: **Error 401: invalid_client** | Client ID pasted incompletely or from another project | Copy the full Client ID (ends `.apps.googleusercontent.com`) into the variable; publish again |
| Sign-in popup closes and nothing happens | Popup blocked | Allow popups for the site and click **Connect Google** again |
| **Your Google session has expired** | Access tokens last about an hour | Click **Reconnect**; nothing is lost |
| **That workbook is not a Dashboard Workspace** | You pasted a source Sheet or a workbook not created by the dashboard | Use **Create a new Dashboard Workspace**, or the ID shown in Data connections of the device that created it |
| **Google did not allow access** when pasting a workspace ID | With `drive.file`, the app can only open workspaces it created for this Google account | Sign in with the account that created it, or create a new workspace and re-import your backup |
| Install check ❌ **Workspace reachable with Editor access** | Workspace not shared with the service account, or shared as Viewer | Open the workspace › Share › service-account e-mail as **Editor** |
| Install check ❌ **Source … readable as Viewer / Denied** | Source Sheet not shared with the service account | Share the source with the service-account e-mail as **Viewer** |
| Install check ❌ **Worksheets not found: …** | Tab names differ from the mapping | Rename the tab back, or Settings › Business setup › *Update / remap* that source, review and activate |
| Install check ❌ **DASHBOARD_WORKSPACE_ID secret present** | Secret missing | Data connections › Copy › add secret `DASHBOARD_WORKSPACE_ID` |
| Install check / import: **GOOGLE_SERVICE_ACCOUNT_JSON is missing or is not the complete JSON key** | Partial paste | Open the key file in Notepad, select all, copy, replace the secret |
| Import **failed — Column "X" (used for …) was not found … Headers found: …** | A column was renamed in the source | Rename it back, or Settings › Business setup › *Update / remap* that source and choose the new column |
| Import **failed — status "…" is not listed in status_map** | A new status value appeared | Settings › Business setup › *Update / remap* the sales source and put the new status under pending / done / excluded |
| Import **failed — identifier "…" appears on rows …** | Duplicate ID in the source | Fix the source rows; the previous good data stays visible meanwhile |
| Import **failed — Payment … refers to sale … not in the sales table** | Receipt whose order is missing | Fix the source; balances would be wrong otherwise |
| Badge **stale — last import failed** | Latest import failed; previous snapshot shown | Data connections › Message tells you why; fix and run **2 · Import data** |
| Import **busy — Another worker run … in progress** | Two runs overlapped or a run crashed within the last 10 minutes | Wait 10 minutes, run again |
| Import **unchanged** | Source data identical to the current snapshot | Nothing to do; this is normal |
| Scheduled import did not run at the exact hour | GitHub schedules can be delayed or dropped | Use **Run "Import data" now**; consider two hours in `REFRESH_HOURS_UTC` |
| AI insights or Business setup: **GEMINI_API_KEY secret is not set** | No key | Google AI Studio › API keys › create a key; add it as the secret `GEMINI_API_KEY` |
| **Gemini rejected the API key** | Wrong/revoked key | Create a new key in Google AI Studio and replace the secret |
| **Gemini quota reached** (brief or setup) | Free-tier or project quota used up | Wait for the quota to reset. Imports and figures continue; for setup click **Retry preparation** later |
| Business setup: **Gemini returned an invalid proposal (received …)** | Gemini answered in an unexpected shape | Click **Retry preparation** and run Import data again. If it repeats, send the whole message to your instructor — it lists field names only, no business data |
| **Gemini model unavailable for this project** | `AI_MODEL` names a model your project cannot use | Delete the `AI_MODEL` variable to use the default, or pick a model listed in Google AI Studio |
| **Choose the AI data setting in Business setup…** | No AI data setting saved | Settings › Business setup › AI data setting; *synthetic* only for practice data |
| AI insights: **1 request(s) queued** for a long time | Worker has not run since the request | Run **3 · AI brief** (or wait for the next scheduled import) |
| Brief says *older snapshot* | Data was imported after the brief | Request a new brief |
| Business setup: **required field sales.amount is not mapped** (or similar) | A required column was left *Not provided* | Review again and choose the column; if the source has no such column it cannot be used for that record type |
| Business setup: **Column "X" is missing or duplicated** | Two columns share a name, or the header row number is wrong | Rename one column in the source, or correct *Row containing column names* |
| Business setup: **… already has an authoritative source** | Another source already supplies that record type | Ignore that table here, or update the existing source instead |
| Business setup: **Waiting for the worker** for a long time | The Import data workflow has not run since you clicked Prepare | Click **Open Import data → Run workflow**, wait for the green tick, then **Reload** |
| **PDF page N has no readable text** | Scanned PDF (image only) | Use the original spreadsheet export or a text-based PDF; OCR is not supported |
| **No supported … table was found** / **No supported records found in this document** | The file is a summary report, or not one of the four record types | Use a detailed record export (one row per customer, order, payment or stock item) |
| Banner: **The setup package is a draft with open questions** | Setup restored from an old draft package | Settings › Business setup › *Update / remap* each source and activate it |
| A task I completed reappeared | Tasks are keyed by rule + record ID; the same key never duplicates. A *new* task with a different ID appeared | Check the record ID on the card |
| Task shows **stale** | Your decision was made on an older snapshot | Review it; the badge is informational |
| Task shows **resolved by data** | The condition no longer exists in the current data (e.g. the balance was paid) | Nothing to do; your decision is kept as history |
| Figures differ from my spreadsheet total | Cancelled/excluded rows, the reporting date, or receipts after the reporting date | Settings shows the status map and reporting-date rule; Sales/Payments tables show exactly which rows count |
| Overview shows **growth unavailable** | No sales in the comparison period | Not an error |
| The workbook shows odd tabs | Those are the dashboard's own tabs (`Data_*`, `Tasks_*`, …) | Do not edit them by hand; use the dashboard |
| I deleted a workspace tab by mistake | — | Run **1 · Install check**: it re-adds missing tabs without clearing others (data in a deleted tab is gone; importer-owned tabs are rebuilt by the next import) |

If none of these match, open **Data connections → Recent runs** and send the *message*
text (never the key file or the workbook) to your instructor.
