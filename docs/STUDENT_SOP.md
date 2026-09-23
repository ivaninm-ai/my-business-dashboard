# Student SOP — install your own business dashboard

Release 1.2.0-rc.3 · no terminal, no code editing, no chat assistant. Every step is a web
page, a form in the dashboard, or a value pasted into GitHub's Secrets/Variables screens.
The interactive version of this SOP (with copy buttons and checkpoints) is the installation
guide your instructor shares; this file is the same procedure in plain text.

**Language:** the dashboard is in Chinese by default, with each menu item and button's English name in brackets — for example 准备来源（Prepare source）. This SOP uses the English names. Change the language in **Settings › Business setup › Language**.

**What you will end up with:** a private dashboard at `https://<your-github-name>.github.io/<repo>/`
that reads your own Google Sheets and files, stores its settings and tasks in a workbook in
your own Google Drive, and refreshes on a schedule from your own GitHub repository. A
background worker in your repository uses Gemini (Google AI Studio) to propose what your
columns mean and to write the daily brief. Nothing is shared with the instructor.

## Before you start — accounts

| Account | Used for | Cost |
|---|---|---|
| GitHub | Your copy of the template, scheduled jobs, the website | Free (the repository must be **public** for GitHub Pages on the free plan; it contains only generic code) |
| Google account | Your source Sheets, the Dashboard Workspace, sign-in | Free |
| Google Cloud project | Sheets API, a service account, a browser sign-in client | Free (no billing needed) |
| Google AI Studio | The Gemini API key used by the background worker (source setup and the daily brief) | Free tier for practice with synthetic data; real private business records need a billing-enabled project |

Keep a private notepad for values you will paste. Never paste keys into chat, e-mail or the guide.

## Step 1 — Copy the template into your GitHub account

1. Open the template link your instructor gave you → **Use this template → Create a new repository**.
2. Owner: yourself. Name: `my-business-dashboard` (any name). Visibility: **Public**. Create.
3. ✅ Checkpoint: your repository opens and shows folders `app`, `worker`, `docs`, `prompts`.

## Step 2 — Google Cloud: one project, one API, one sign-in client, one service account

1. console.cloud.google.com → project selector → **New project** → name `dashboard` → Create → select it.
2. **APIs & Services → Library** → search **Google Sheets API** → Enable. ✅ Checkpoint: "API enabled".
3. **APIs & Services → OAuth consent screen** (also called *Google Auth Platform*):
   - User type **External** → app name `Business Dashboard`, your e-mail as support and developer contact → Save.
   - **Audience**: keep **Testing** and add **your own Google e-mail** as a test user. (Only test users can sign in while the app is in Testing. The dashboard asks only for the `drive.file` permission, which is not a sensitive scope.)
4. **APIs & Services → Credentials → Create credentials → OAuth client ID** → type **Web application** → name `dashboard-browser`.
   - **Authorized JavaScript origins → Add URI**: `https://<your-github-name>.github.io` (all lowercase; no path, no trailing slash).
   - Create → copy the **Client ID** (ends with `.apps.googleusercontent.com`) into your notepad. Do not use the client secret; the dashboard never needs it.
5. **IAM & Admin → Service Accounts → Create service account** → name `dashboard-worker` → Create → skip the optional roles → Done.
   - Open it → **Keys → Add key → Create new key → JSON** → the key file downloads. Keep it private.
   - Copy the service account's **e-mail** (`dashboard-worker@….iam.gserviceaccount.com`) into your notepad.
6. ✅ Checkpoint: you have a Client ID, a service-account e-mail, and a downloaded JSON key file.

## Step 3 — Gemini key, GitHub Secrets and Variables

1. Open **Google AI Studio → API keys** (aistudio.google.com) → **Create API key** in your own project. Copy it straight into the GitHub secret below; do not keep it anywhere else.
2. In your repository: **Settings → Secrets and variables → Actions**.

**Secrets tab → New repository secret** (paste the value exactly):

| Name | Value |
|---|---|
| `GOOGLE_SERVICE_ACCOUNT_JSON` | The entire contents of the downloaded JSON key file (open it in Notepad, select all, copy) |
| `GEMINI_API_KEY` | Your Google AI Studio API key. **Required**: Business setup cannot prepare sources without it; the daily brief also uses it |

**Variables tab → New repository variable**:

| Name | Value |
|---|---|
| `GOOGLE_OAUTH_CLIENT_ID` | The Client ID from step 2.4 |
| `BUSINESS_LABEL` | (optional) the name to show on the sign-in page |
| `REFRESH_HOURS_UTC` | (optional) hours to import, e.g. `23` (= 07:00 Malaysia) or `1,7` ; `off` disables the schedule |
| `AI_MODEL` | (optional) defaults to `gemini-3.5-flash-lite`; leave it unless your instructor says otherwise |
| `AI_AUTO` | (optional) `off` to stop the automatic brief after each import |

`DASHBOARD_WORKSPACE_ID` is added in step 6. ✅ Checkpoint: two secrets and at least one variable saved.

## Step 4 — Publish the dashboard site

1. **Settings → Pages → Build and deployment → Source: GitHub Actions**.
2. **Actions** tab → if asked, **I understand my workflows, go ahead and enable them**.
3. Left list → **4 · Publish dashboard** → **Run workflow** → Run. Wait for the green tick (about one minute).
4. Open the run → the summary shows **Open: https://<your-github-name>.github.io/<repo>/**. Bookmark it.
5. ✅ Checkpoint: the page shows *Connect Google*. (If it says *Not configured yet*, the variable in step 3 is missing or misspelled.)

## Step 5 — Sign in and create your Dashboard Workspace

1. Open your dashboard → **Connect Google** → choose the e-mail you added as a test user → **Continue** → allow.
   - If Google says *Access blocked*: add that e-mail as a test user (step 2.3) and try again.
   - If Google says *origin not allowed* / *redirect_uri_mismatch*: check the Authorized JavaScript origin (step 2.4) matches your site address up to `.github.io`.
2. **Create a new Dashboard Workspace**. The dashboard creates a Google Sheet in your Drive and opens **Data connections**.
3. ✅ Checkpoint: **Data connections** shows a Workspace ID and an *Open workspace* link.

## Step 6 — Share the workspace with your worker and save its ID

1. In **Data connections**, paste your service-account e-mail into the field and **Save** (it is shown so you can copy it later).
2. Click **Copy** next to the Workspace ID → GitHub → **Settings → Secrets and variables → Actions → Secrets → New repository secret**: name `DASHBOARD_WORKSPACE_ID`, value = the ID.
3. Click **Open workspace ↗** → Google Sheets **Share** → add the service-account e-mail as **Editor** → Send (untick *Notify* if offered). Keep *General access* **Restricted**.
4. GitHub → **Actions → 1 · Install check → Run workflow**. ✅ Checkpoint: key, workspace, write-access and `GEMINI_API_KEY` checks pass. *Setup package ❌* is expected until steps 7–8; rerun the check after those steps.

## Step 7 — Describe your business and prepare a source (in the dashboard)

1. Dashboard → **Settings → Business setup**. Fill in business name, type, what you sell, language (default 中文; it applies to the whole dashboard and the AI brief), currency, timezone and what the AI brief should focus on.
2. **AI data setting**: *Synthetic practice records · free tier* for the training pack; *Real business records · billing-enabled Gemini project* for real private data (enable billing in Google first — this choice does not enable it for you).
3. **Report date**: *Today* for a live business; *Latest record date* for historical practice data. Click **Save business profile**.
4. **Connect or update a source → Source: Add a new source**:
   - **Live Google Sheet**: paste the link of the native Google Sheet (File → Save as Google Sheets if it is an uploaded Excel file). In that Sheet: **Share** → service-account e-mail as **Viewer**; General access stays Restricted.
   - **Local file**: choose XLSX, CSV, a text-based PDF or DOCX, and the date the records describe (*File data as of*). The file is read in your browser; only the extracted rows or text are saved to your workspace.
5. Click **Prepare source**, then **Open Import data → Run workflow** → **Run workflow** in GitHub. When the run finishes, return to the dashboard and press **Reload**.
6. ✅ Checkpoint: Business setup shows *Ready for review* and a **Review detected records** button. If it shows an error (for example *Gemini quota reached*), nothing was activated; fix the cause and click **Retry preparation**.

Prepare one source at a time. Do not add the same orders twice (for example an Excel export and a PDF of the same orders).

## Step 8 — Review what each column means, activate, import

1. **Review detected records**. For each table choose what one row represents (customer, order/job/booking, received payment, stock item) or **Ignore this table**. Check the date format.
2. Check every field marked `*`, especially the record ID, order date, amount, received-payment date and payment deadline. The drop-downs list your own column names. An amount must be clearly either an order value or money received; choose *Not provided* for anything that does not apply.
3. If the source has orders, put its status words into *pending / done / excluded*. For PDF/DOCX, open **view records** and compare every extracted row with the original — AI extraction can omit or misread rows.
4. Tick the confirmation box → **Validate and preview totals** → compare the record counts and column totals with your file → **Activate source**. Nothing changes before you click Activate.
5. GitHub → **Actions → 2 · Import data → Run workflow**. When it finishes, dashboard → **Reload**.
6. ✅ Checkpoint: the badge at the top reads *data as of <date>* and the Overview matches your records. Repeat steps 7–8 for each further source. One source per record type (one customer table, one order table, …); payments need the matching order table.

## Step 9 — Prove it works (5 minutes)

1. **Tasks**: accept one suggestion, complete one, dismiss one, edit one (date/owner/note).
2. Close the browser. Open the dashboard again, reconnect. ✅ Your decisions are still there.
3. Change one value in your source Sheet (for the training pack: Stock R003 on-hand 8 → 33). Run **2 · Import data** again → Reload. ✅ The figure changed, your decisions are kept, no duplicate tasks appeared.
4. Restore the value; import again. ✅ The figure returns.

## Updating a local file

Google Sheets are read on every import. A local file keeps its last activated records until
you replace it:

1. **Data connections** → the file's card → **Update this file in Business setup**.
2. **Source** → *Update / remap: <that source>* (not *Add a new source*). Choose the new file and its *File data as of* date.
3. **Prepare source** → run **Import data** → **Reload** → review → **Activate source** → run **Import data** again → **Reload**.

The new file replaces that source's records completely, so it must contain every record you
want to keep. Other sources, task decisions and calendar notes are kept. See
[Mixed sources](MIXED_SOURCES.md).

## Daily use

- The import runs automatically at the hours in `REFRESH_HOURS_UTC` (default 23:17 UTC ≈ 07:17 Malaysia). GitHub may delay or skip scheduled runs; to request a refresh use **Data connections → Run "Import data" now**.
- The AI brief is generated after each successful import and on **AI insights → Request analysis** (processed on the next worker run, or run **3 · AI brief → Run workflow**). If Gemini's quota is reached, figures still update and the previous brief stays visible with its date.
- Your Google session lasts about an hour. When asked, click **Reconnect**. **Sign out** clears all data from the page.
- Back up: **Settings → Export backup** (settings, links, decisions, notes and saved file records — keep it private). Restore into a new workspace with **Restore from backup**.
- Update: when the instructor announces a release, **Actions → 5 · Update from template → Run workflow** with the tag, then **4 · Publish dashboard** and **1 · Install check**. Your workspace is untouched.

## What is not automatic (honest limits)

- Only native Google Sheets refresh on the schedule. Local XLSX/CSV/PDF/DOCX files are replaced by you in Business setup.
- Each preparation needs a GitHub Actions run (Run workflow, or the next hourly run) before you can review it.
- Gemini proposes; you confirm. Column meanings and PDF/DOCX extraction must be checked before activation. Scanned PDFs (no text layer) are not supported.
- Google's free tier must not receive personal or confidential records. Real private data needs a billing-enabled Gemini project.
- One person editing tasks at a time is assumed. Up to 5,000 rows per table; files up to 10 MB; PDFs up to 50 pages.
- Nothing is sent to external calendars or messaging; the calendar is inside the dashboard.
