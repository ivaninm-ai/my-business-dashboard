# Alternative layout fixture: Demo Physio Studio (synthetic)

A small service business with a layout that differs from BetterSpace: dd/mm/yyyy text
dates, "RM 1,200.00" money text, no stock table, and different header names. It proves
that one application handles a second layout through mapping alone. Regenerate the CSVs
with `node test/fixtures/alt-service-studio/make-fixture.mjs`.

Hand-checked expectations (reporting date 2026-08-30, period 1–30 Aug):

- Eligible bookings exclude the No-show (B-1006). August order value = 120 + 150 + 1200 + 120 + 200 + 120 = **RM 1,910** (6 bookings).
- Cash collected in August = 120 + 150 + 600 + 120 = **RM 990**. All-time cash = RM 1,190.
- Outstanding = B-1003 (1200 − 600 = 600) + B-1005 (200) + B-1007 (120, pay by 12/09) = **RM 920**. Overdue = B-1003 (pay by 26/08) + B-1005 (pay by 25/08) = **RM 800**.
- Pending completion: B-1003 (appointment 02/09), B-1005 (29/08 → overdue), B-1007 (31/08). Overdue completion: **B-1005**.
- Follow-ups: C-03 (25/08, overdue), C-04 (30/08, today), C-01 (02/09). C-04 has no therapist but is a customer, not a prospect, so no "unassigned prospect".
- Stock module is hidden: no stock table is mapped.
