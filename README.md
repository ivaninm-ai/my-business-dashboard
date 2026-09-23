# Business Dashboard template

A student-owned business dashboard: static site on GitHub Pages, background jobs in
GitHub Actions, and Google Sheets as the only storage. No database service, no Apps
Script, no server to run. Each student creates their own copy from this template and
configures it through Secrets, Variables, Google screens and forms in the dashboard.

**Students:** start with [`docs/STUDENT_SOP.md`](docs/STUDENT_SOP.md) or the interactive
installation guide your instructor shared. Problems: [`docs/TROUBLESHOOTING.md`](docs/TROUBLESHOOTING.md).

## How it fits together

```
 Your source Google Sheets ──(Viewer, service account)──▶ GitHub Actions worker
        (read-only)                                          │ validate · map · metrics · tasks · AI
                                                              ▼ (Editor, service account)
 Your browser ──(your Google sign-in, drive.file)──▶ Dashboard Workspace (Google Sheet)
   GitHub Pages site: generic code only                       settings · snapshots · tasks · calendar · AI results
```

- The site holds no data and no keys; Google sharing is the access boundary.
- Secrets (`GOOGLE_SERVICE_ACCOUNT_JSON`, `DASHBOARD_WORKSPACE_ID`, `GEMINI_API_KEY`)
  live only in GitHub Secrets. Public settings are Variables.
- Business setup happens in the dashboard: the worker asks Gemini to propose what each
  table and column means (instructions in `prompts/`), and the owner reviews and
  activates it. No chat assistant, Skill or JSON file is involved.
- Task decisions and notes are yours; imported snapshots are rebuilt from your sources.

## Repository layout

| Path | Purpose |
|---|---|
| `app/` | The dashboard site (published to Pages). `app/shared/` holds the modules shared with the worker: canonical model, mapping, metrics, tasks, package validation, Sheets client, workspace layout, schema |
| `app/file-readers.js` | Browser readers for XLSX/CSV/PDF/DOCX; bundled into `app/vendor/` by `npm run build` at publish time |
| `worker/` | GitHub Actions jobs: install check, source preparation (Gemini proposal), import, AI brief |
| `prompts/` | Gemini instructions: `data_mapping.md` (source interpretation), `daily_brief.md` (daily brief) |
| `.github/workflows/` | 1 Install check · 2 Import data · 3 AI brief · 4 Publish dashboard · 5 Update from template · Tests |
| `config/` | Setup-package contract and examples |
| `docs/` | Student SOP, troubleshooting, instructor test script, release notes, limitations, source matrix, backup/update guide |
| `scripts/` | `write-config.mjs` (publish-time config from Variables), `build.mjs` (browser file readers) |
| `test/` | Simulated Google API, fixtures (BetterSpace B2C/B2B copies, alternative service layout) and 48 tests |

## Maintainers

```bash
npm ci
npm run build         # bundle the browser file readers into app/vendor/
npm test              # 48 simulated tests (fake Google API, mocked Gemini)
npm run fake-google   # simulation server + dashboard at http://127.0.0.1:8790/ (mock sign-in)
node test/sim/worker.mjs <setup|import|ai> <workspaceId> [--day day2]   # run the worker against the simulation
```

`setup` and `ai` call the real Gemini endpoint. To stay offline in the simulation,
preload the stand-in: `NODE_OPTIONS=--import=./test/sim/mock-gemini.mjs
GEMINI_API_KEY=test-only node test/sim/worker.mjs setup <workspaceId>` (`MOCK_GEMINI=429`
simulates an exhausted quota). Use a real key only with synthetic data.

Publish a release by tagging (`v1.2.0-rc.1`); students apply it with workflow 5.
The former Claude onboarding skill is retired; `app/shared/setup-package.schema.json`
remains the internal contract that Business setup writes.

# Local candidate 1.2.0-rc.1

This candidate moves setup into the dashboard and switches background AI to Gemini.
Read [docs/RELEASE_NOTES.md](docs/RELEASE_NOTES.md) and
[docs/MIXED_SOURCES.md](docs/MIXED_SOURCES.md). It has passed local simulation; a live
Google/GitHub/Gemini installation remains an instructor acceptance step. Do not label
this a student-ready published release.
