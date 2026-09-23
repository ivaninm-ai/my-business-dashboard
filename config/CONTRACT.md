# Setup package contract (v1.0)

The **setup package** is the one JSON document that the dashboard's Business setup
writes after the owner reviews a source, and that the worker validates and consumes.
(Until 1.1.0 a Claude onboarding skill produced it; that skill is retired.)
It is configuration, not code: headers, meanings, allowed values, policies chosen from a
fixed catalogue. Nothing in it is executed.

- Schema (single source of truth): [`../app/shared/setup-package.schema.json`](../app/shared/setup-package.schema.json)
- Validator used by the app and worker: `app/shared/package.mjs` (`validatePackage`)
- Former mirror validator in the retired skill: `skill/business-dashboard-onboarding/scripts/validate_package.py`
- Examples: [`examples/`](examples/) — BetterSpace B2C, BetterSpace B2B, Demo Physio Studio (service, no stock)

## Top-level sections

| Section | Purpose |
|---|---|
| `package_version` `package_id` `generated_at` `generated_by` | Versioning and provenance of the package itself |
| `confirmation` | `draft` or `confirmed`; who confirmed; `open_questions` still to answer |
| `business` | Name, model (`b2c`/`b2b`/`service`/`mixed`/`other`), industry, description, team, locale, timezone, currency (+ symbol), owner questions, `ai_guidance`, `synthetic` |
| `reporting_date` | `fixed` (value), `today` (in business timezone) or `latest_event_date` (latest sale/payment/stock-snapshot date in the records) |
| `period` | Default period preset and `history_start` |
| `modules` | Which sections are enabled; sections without a mapped table are hidden anyway |
| `labels` | Display vocabulary (Accounts, Bookings, Receipts…) |
| `sources` | One entry per file: `google_sheet` (live, refreshed by the worker) or `manual_package` (reviewed rows carried in `records`) |
| `tables` | One table per canonical entity: sheet name, header row, row meaning, identity strategy, field mappings |
| `status_map` | Source status values → `pending` / `done` / `excluded` buckets |
| `policies` | Date order for ambiguous text dates, money unit, task rules (from the catalogue) with parameters |
| `validation.sample` | Row counts and totals observed in the sample, used for reconciliation after the first live import |
| `provenance` | Sample files inspected and notes |
| `meanings` | Confirmed/documented/interpreted meanings, in plain language |
| `records` | Reviewed rows for manual sources only (≤ 5,000 per entity); `null` for live sources |

## Canonical entities and fields

Defined in `app/shared/model.mjs`. A student's spreadsheet keeps its own headers; a
field mapping links each header (or a constant) to a canonical field.

| Entity | Required | Optional |
|---|---|---|
| `customers` | `id`, `name` | `type` (customer/prospect), `contact`, `created_date`, `owner`, `next_follow_up_date`, `notes` |
| `sales` | `id`, `date`, `amount` | `customer_id`, `item_id`, `description`, `offering_type` (product/service), `quantity`, `unit_price`, `channel`, `status`, `payment_due_date`, `promised_completion_date`, `actual_completion_date` |
| `payments` | `id`, `sale_id`, `date`, `amount` | `method` |
| `stock` | `id`, `on_hand` | `name`, `snapshot_date`, `reserved`, `reorder_threshold` |

Field types: `text`, `money` (parsed to integer cents; accepts numbers or text such as
"RM 1,200.00"), `integer`, `date` (ISO, spreadsheet serial, or text in the declared
`date_order`), `enum` (with a `values` alias map), `status` (through `status_map`).

## Identity

`identity.mode` is `source_id` (default; the mapped `id` column), `composite` (two or
more mapped fields joined; requires a `limits` note disclosing what happens when the
combination repeats) or `row_number` (fragile; a warning is always shown). Duplicate
identities within a table are rejected before import.

## Task-rule catalogue

`policies.tasks[]` may enable/disable these rules and set only the listed parameters:

| Rule | Needs | Parameters | Trigger |
|---|---|---|---|
| `payment_follow_up` | sales, payments | `offset_days` (default 1) | Positive unpaid balance on an eligible sale |
| `follow_up_due` | customers | — | Recorded next follow-up date present |
| `review_account` | customers, sales | — | Customer-type account with no sales rows (review only) |
| `review_replenishment` | stock | — | Available ≤ reorder threshold |
| `completion_overdue` | sales | — | Pending sale with promised completion before the reporting date |
| `completion_due_soon` | sales | `within_days` (default 3) | Pending sale promised within N days |
| `unassigned_prospect` | customers | — | Prospect with no owner |

Task keys are `rule:record_id`, so repeated imports never duplicate a task and user
decisions survive refreshes. Recorded deadlines are always kept separately from
suggested action dates.

## What the app rejects

Schema violations; unknown entities/fields/rules; a required canonical field not
mapped; a header and a constant on the same field; two tables for one entity; a
`google_sheet` table without `sheet_name`; unlisted status values (at import time);
duplicate or blank identities (at import time); unsafe transforms (there is no place
to express any); records supplied for a live source; more than 5,000 rows per entity.

## Versioning

`package_version` is `1.0`. A future `1.x` adds optional properties only; the app keeps
accepting `1.0`. Breaking changes will bump the major version, and the app will refuse
the new version with a message naming the required template release.
