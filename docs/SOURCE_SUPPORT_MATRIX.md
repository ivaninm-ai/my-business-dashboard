# Source support matrix (release 1.2.0-rc.1)

| Source | Read by | Live connection | Refresh | Notes |
|---|---|---|---|---|
| Google Sheets (native) | Worker (service account) | **Yes** — share with the service account as Viewer, paste the link in Business setup | Every import (scheduled + manual via GitHub Actions) | Only live connector. Dates may be real dates or ISO/dd-mm text; money may be numbers or "RM 1,200.00" text |
| Excel (.xlsx) | Browser (read-excel-file) | No | Replace the file in Business setup | Up to 12 sheets, 5,000 rows each. Convert to a native Google Sheet (File → Save as Google Sheets) if you want scheduled refresh. Save old .xls files as .xlsx first |
| CSV | Browser (Papa Parse) | No | Replace the file in Business setup | UTF-8, with or without the byte-order mark Excel adds |
| PDF (text) | Browser (pdf.js) extracts text; Gemini proposes tables | No | Replace the file in Business setup | Up to 50 pages / 80,000 characters. Every extracted row must be compared with the original before activation |
| PDF (scanned) | — | No | — | Rejected with a message: no OCR in this release |
| DOCX | Browser (mammoth) extracts text; Gemini proposes tables | No | Replace the file in Business setup | Same review rule as PDF |
| Drive-hosted Excel, synced folders | Not yet | Not yet | — | Later connector; needs Drive API scopes and additional sharing steps |
| Databases, POS/marketplace APIs | No | No | — | Export to a Google Sheet first |

**Live means:** the worker reads the Sheet from Google on every import using the service
account.

**Local file means:** the browser reads the file; its extracted rows (or text) are sent to
the worker once for a mapping proposal, then saved in the private Workspace Sheet when the
owner activates the source. Each import reuses those saved rows until the owner replaces
the file. The original file is never stored. See [Mixed sources](MIXED_SOURCES.md).
Row limit 5,000 per record type; file size limit 10 MB.
