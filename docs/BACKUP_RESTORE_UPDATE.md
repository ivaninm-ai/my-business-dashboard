# Backup, restore and updates

## What lives where

| Item | Where | Backed up by |
|---|---|---|
| Original records | Your source Google Sheets / files | You (Google Drive version history) |
| Business profile, setup package, source links, saved file records, service-account e-mail | Dashboard Workspace › `Settings`, `Sources` | Export backup |
| Task decisions, calendar notes, AI requests | Workspace › `Task_Decisions`, `Calendar`, `AI_Requests` | Export backup |
| Imported snapshots, metrics, suggestions, AI results, logs | Workspace importer/worker tabs | Not needed — rebuilt by the next import (AI results are regenerated on request) |
| Application code | Your GitHub repository | GitHub |
| Secrets | GitHub Secrets | Not exportable — re-enter if you rebuild the repository |

Google Drive also keeps version history of the workspace workbook (File › Version history).

## Export a backup

Dashboard › **Settings › Export backup** → `dashboard-backup-<date>.json`. It includes the
records saved from local files (Excel/CSV/PDF/DOCX sources), so treat it as private
business data. It excludes rebuilt `Data_*` snapshots and all keys.

## Restore

1. Create or open a workspace (Data connections).
2. **Settings › Restore from backup…** → choose the file → Restore.
3. Run **2 · Import data** to rebuild snapshots.

Rows with the same keys are overwritten; other rows are kept.

## Move to a new Google account or device

The dashboard can only open workspaces created by the same Google account (drive.file).
On a new account: create a new workspace, restore from backup, share the new workspace
with the service account as Editor, update the `DASHBOARD_WORKSPACE_ID` secret, run the
install check.

## Apply a template update

1. Read the release notes the instructor publishes. Moving from 1.1.0 to 1.2.0 needs a
   fresh installation (see the release notes); later updates use the steps below.
2. GitHub › **Actions › 5 · Update from template › Run workflow** → template repository
   and release tag (as announced) → Run.
3. If the summary lists workflow files that differ, open each named file in the template
   release, copy its contents, and paste it over the same file in your repository with
   the GitHub web editor (pencil icon → Commit changes).
4. Run **4 · Publish dashboard**, then **1 · Install check**.

Your workspace is not part of the repository and is never modified by an update. If a
release adds new workspace tabs or keys, the install check (or the next import) adds them
without clearing anything.

## Roll back

Run **5 · Update from template** with the previous tag, then publish again.
