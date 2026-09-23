// Deterministic synthetic service-business fixture with a different layout:
// dd/mm/yyyy text dates, "RM 1,200.00" money text, no stock, different headers.
// Run: node test/fixtures/alt-service-studio/make-fixture.mjs (regenerates the CSVs).
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = path.dirname(fileURLToPath(import.meta.url));
const clients = [
  ['C-01', 'Aisha Rahman', '012-0000001', '01/06/2026', 'Farah', '02/09/2026', ''],
  ['C-02', 'Ben Tan', '012-0000002', '15/06/2026', 'Farah', '', ''],
  ['C-03', 'Chen Wei', '012-0000003', '20/06/2026', 'Kumar', '25/08/2026', 'Prefers mornings'],
  ['C-04', 'Devi Nair', '012-0000004', '05/07/2026', '', '30/08/2026', 'Referred by C-01'],
  ['C-05', 'Emily Ong', '012-0000005', '10/08/2026', 'Kumar', '', ''],
];
const bookings = [
  ['B-1001', 'C-01', '03/08/2026', 'Physio session', 'RM 120.00', 'Done', '03/08/2026', '03/08/2026'],
  ['B-1002', 'C-02', '05/08/2026', 'Sports massage', 'RM 150.00', 'Done', '05/08/2026', '05/08/2026'],
  ['B-1003', 'C-03', '12/08/2026', 'Rehab package (4)', 'RM 1,200.00', 'Booked', '26/08/2026', '02/09/2026'],
  ['B-1004', 'C-01', '18/08/2026', 'Physio session', 'RM 120.00', 'Done', '18/08/2026', '18/08/2026'],
  ['B-1005', 'C-04', '25/08/2026', 'Assessment', 'RM 200.00', 'Booked', '25/08/2026', '29/08/2026'],
  ['B-1006', 'C-02', '28/08/2026', 'Sports massage', 'RM 150.00', 'No-show', '28/08/2026', '28/08/2026'],
  ['B-1007', 'C-05', '29/08/2026', 'Physio session', 'RM 120.00', 'Booked', '12/09/2026', '31/08/2026'],
  ['B-1008', 'C-03', '15/07/2026', 'Assessment', 'RM 200.00', 'Done', '15/07/2026', '15/07/2026'],
];
const receipts = [
  ['R-501', 'B-1001', '03/08/2026', 'RM 120.00', 'Card'],
  ['R-502', 'B-1002', '05/08/2026', 'RM 150.00', 'Cash'],
  ['R-503', 'B-1003', '12/08/2026', 'RM 600.00', 'Bank transfer'],
  ['R-504', 'B-1004', '18/08/2026', 'RM 120.00', 'Card'],
  ['R-505', 'B-1008', '15/07/2026', 'RM 200.00', 'Cash'],
];
const csv = rows => rows.map(r => r.map(v => /[",]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v).join(',')).join('\n') + '\n';
writeFileSync(path.join(dir, 'Clients.csv'), csv([['Client ID', 'Client', 'Phone', 'Since', 'Therapist', 'Next visit', 'Notes'], ...clients]));
writeFileSync(path.join(dir, 'Bookings.csv'), csv([['Booking Ref', 'Client ID', 'Session date', 'Service', 'Fee', 'Status', 'Pay by', 'Appointment date'], ...bookings]));
writeFileSync(path.join(dir, 'Receipts.csv'), csv([['Receipt No', 'Booking Ref', 'Paid on', 'Amount', 'Method'], ...receipts]));
console.log('fixture written');
