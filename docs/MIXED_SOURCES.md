# Google Sheets + saved Excel/PDF/DOCX records

## First setup

Every source is added in **Settings → Business setup**, one at a time: prepare → run
Import data → review → activate. Decide which source owns each kind of record. This
release supports one table each for customers, sales/orders/jobs, payments and stock.
It does not support arbitrary business document types, multiple sales tables, or
supplier invoices as customer payments. Unsupported documents must be identified before
students start setup.

For example: Sales + Customers in a live Google Sheet, Payments from a text-based PDF,
and Stock from a local Excel or CSV. The setup then has three sources; file sources use
`manual_package`. The browser reads the file; only the extracted rows (or, for PDF/DOCX,
the extracted text and the tables Gemini proposes from it) are saved in the private
Workspace Sheet. The original file is not uploaded to GitHub or stored by the dashboard.

## What Gemini does, and what it does not

The background worker (Import data workflow, step *Prepare pending source*) sends Gemini
the business profile and a sample of each table (first 15 rows), or the full extracted
text of a PDF/DOCX, with the instructions in `prompts/data_mapping.md`. Gemini proposes
which table is which record type and which column is which field; for documents it also
copies the records into tables. The proposal is saved as *Ready for review*. Nothing is
used until the owner reviews it and clicks **Activate source**. Figures are always
calculated by the application from the activated rows, never by Gemini.

## When one file changes

1. Open **Data connections** → that file's card → **Update this file in Business setup**.
2. Choose **Source → Update / remap: <that source>** (not *Add a new source*), the new
   file (XLSX, CSV, text PDF or DOCX — the format may differ from last time) and its
   *File data as of* date. Click **Prepare source**.
3. Run **Import data** (link under the button), wait for it to finish, then **Reload**.
4. **Review detected records**, tick the confirmation, **Validate and preview totals**,
   compare counts and totals with the file, **Activate source**.
5. Run **Import data** again, then **Reload**. The worker checks relationships across all
   sources before replacing the dashboard figures.

The new file **replaces** that source's saved records completely: records missing from
the new file are removed for that source. Use a complete current export, not a file of
today's additions only. (1.1.0's append and corrected-record modes are not offered in
the dashboard in this release.) Other sources, Sheet links, task decisions and calendar
notes are kept. Do not activate while an import is running; if the source changed after
the preview, the app asks you to prepare it again.

“Activated” means the file records are ready for the next import. It does not mean the
combined dashboard has been refreshed yet. If combined validation fails, inspect
Data connections and correct the file; the worker does not silently drop records.
If a snapshot write is interrupted, figures and AI are blocked until a successful
rebuild. Sheets is not transactional; avoid concurrent setup/file edits and imports.

## Daily briefing and calendar

The worker combines fresh Sheet reads with the last saved file records. It includes
each file's declared data date/upload time and labels unknown dates honestly. Those
caveats remain in the saved AI result even if the AI omits them. A morning Sheet read
does not make an old PDF current.

The calendar displays recorded completion/payment/follow-up dates, accepted dated
tasks, and your notes. Unaccepted AI suggestions do not become appointments. Completed,
dismissed and resolved tasks disappear from the action calendar; recorded source
deadlines remain until the records change. Notes persist through imports. The daily
AI request includes task notes and the calendar for today and the next 14 days (up to
40 entries). No appointment times or external Google Calendar sync are inferred.

## Schedule details

The workflow checks at minute **17** of each UTC hour. Default hour 23 means roughly
**07:17 Malaysia time**, subject to GitHub delays. The AI step only follows a successful
or unchanged import, never a skipped/failed import. `AI_AUTO=off` suppresses automatic
briefs but still allows explicitly queued requests after a refresh. `REFRESH_HOURS_UTC=off`
disables scheduled imports; use manual workflows to process requests.

GitHub can disable public-repository schedules after 60 days without repository
activity. Updating a Google Sheet does not count as repository activity. Check
Actions when imports stop; re-enable the disabled workflow, then run Import data.
Manual workflow dispatch also enters GitHub's queue; it is not an immediate guarantee.
See [GitHub schedule documentation](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows).

## Storage and backup

Workspace Settings holds the reviewed file rows, so **Export backup includes those
private file records**, alongside settings, links and decisions. It excludes rebuilt
Data_* snapshots and service-account/API keys. Keep backup files private. Original
PDF/Excel files remain wherever the student maintains them.

## Current verification boundary

Mixed-source and recovery checks use a simulated Google API and a local stand-in for
the Gemini endpoint. The browser walkthrough (Sheet + text PDF + CSV, then an XLSX
replacement) used the real file readers. A fresh Google OAuth/Sheets installation, an
actual GitHub scheduled run, and real Gemini calls (mapping quality, PDF extraction
accuracy, free-tier quota) still require instructor testing before distribution.
