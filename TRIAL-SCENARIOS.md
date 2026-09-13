# DockFlow trial and regression scenarios

Use this checklist on a copy of the trial data. Back up `.env` and `data/trial-data.json` first. Test in Chrome or Edge at desktop width and once at mobile width. Record the case ID, account, result, screenshot, browser Network response, and API log for every failure.

## Suggested test accounts

| Account | Scope | Main checks |
|---|---|---|
| Administrator | Both | All areas, accounts, schedules, Ecosystem, SAP |
| Administrator | Dressings | Dressings-only accounts and deliveries |
| Administrator | Savoury | Savoury-only accounts and deliveries |
| Planner/Production | Dressings | SDS import, schedule, Ecosystem requests |
| Planner/Production | Savoury | SDS import, schedule, Ecosystem requests |
| Supplier A | Dressings | Confirmation, alternatives, own entries |
| Supplier A | Savoury | Same supplier name, separate area access |
| Supplier B | Dressings | Confidentiality between suppliers |
| Security | Both | Gate review and Gate in |
| Warehouse | Dressings | Unloading, clearance, SAP receiving fields |
| Warehouse | Savoury | Area isolation |
| SAP Analyst | Dressings | PostgreSQL rows and SAP editing |
| SAP Analyst | Savoury | Area-specific SAP access |
| Ecosystem | Ecosystem | Incoming deliveries and outgoing requests |

## 1. Startup, persistence, and refresh

| ID | Scenario | Expected result |
|---|---|---|
| SYS-01 | Start with PostgreSQL available | App starts; SAP shows rows on an allowed network |
| SYS-02 | Start with PostgreSQL unavailable | JSON-backed DockFlow still works; SAP shows a clear unavailable message |
| SYS-03 | Restart containers after creating accounts and bookings | JSON accounts/bookings persist |
| SYS-04 | Restart after editing a SAP row | PostgreSQL SAP edit persists |
| SYS-05 | Leave a normal page open for five minutes | Background refresh does not produce 429 errors |
| SYS-06 | Leave SAP open for five minutes | Ten-second newest-page refresh works without losing loaded pages or edits |
| SYS-07 | Hide the browser tab and wait | SAP polling pauses while hidden and resumes when visible |
| SYS-08 | Open two normal DockFlow tabs | Both remain usable without “Too many requests” |
| SYS-09 | Open SAP and a normal page in separate tabs | SAP polling does not block JSON API actions |
| SYS-10 | Refresh the browser during an authenticated session | Session restores or refreshes without returning to a broken state |

## 2. Login, activation, and accounts

| ID | Scenario | Expected result |
|---|---|---|
| AUTH-01 | Correct username and password | Login succeeds |
| AUTH-02 | Correct email and password | Login succeeds when email login is supported |
| AUTH-03 | Wrong password | Clear 401-style error; no generic server failure |
| AUTH-04 | Twenty failed attempts for one username, then another valid username | Only the attacked username/IP key is limited; the other account can log in |
| AUTH-05 | Valid login while SMTP is unavailable | Login succeeds and activation explains that the code could not be sent |
| AUTH-06 | First login for a new account | Activation is required |
| AUTH-07 | Enter wrong verification code | Verification stays blocked with a clear error |
| AUTH-08 | Enter correct code, then mismatched new passwords | Password is not changed |
| AUTH-09 | Enter correct code and matching 8+ character passwords | Activation completes and app opens |
| AUTH-10 | Create account and use the initial-password eye | Password toggles between hidden and visible |
| AUTH-11 | Click outside the initial-password control | Password returns to hidden |
| AUTH-12 | Create duplicate username | Request is rejected without creating another account |
| AUTH-13 | Create duplicate email | Request is rejected according to the account rule |
| AUTH-14 | Create a scoped account from a scoped admin | New account is forced to the admin’s area |
| AUTH-15 | Scoped admin opens Administration | Only that area group is shown |
| AUTH-16 | One account exists in a role group | Card stays at the same compact maximum width |
| AUTH-17 | Several accounts exist in a role group | Cards wrap with consistent widths |
| AUTH-18 | Delete another account with correct admin password | Login access is removed; historical records remain |
| AUTH-19 | Delete with incorrect admin password | Nothing is deleted; exact error is shown |
| AUTH-20 | Try deleting the currently signed-in account | Delete control remains disabled |

## 3. Role and area isolation

| ID | Scenario | Expected result |
|---|---|---|
| AREA-01 | Both-area admin switches Dressings/Savoury | Overview, Monitoring, Schedule, docks, and counts change together |
| AREA-02 | Security switches Dressings/Savoury | Both areas are available |
| AREA-03 | Dressings planner signs in | Only Dressings operational records are available |
| AREA-04 | Savoury planner signs in | Only Savoury operational records are available |
| AREA-05 | Dressings Warehouse opens a Savoury delivery URL directly | Server denies access |
| AREA-06 | Supplier A views data | Supplier B deliveries and internal descriptions are absent |
| AREA-07 | SAP Analyst opens normal operational endpoints | Only allowed pages/endpoints are available |
| AREA-08 | Supplier manipulates a request to edit SAP | Server rejects it |
| AREA-09 | Planner manipulates a request to edit SAP-only fields | Server rejects it |
| AREA-10 | Warehouse manipulates a request to edit SAP-only fields | Server rejects it |

## 4. SDS spreadsheet import

| ID | Scenario | Expected result |
|---|---|---|
| SDS-01 | Import one valid Dressings row | One pending supplier proposal is created |
| SDS-02 | Import several rows with same supplier/date/time/site | Rows group into one proposal with several materials |
| SDS-03 | Import rows with different time | Separate proposals use their exact times |
| SDS-04 | Import rows with different date | Separate proposals use their exact dates |
| SDS-05 | Import rows with a supplied End Time | Saved window matches Start–End exactly |
| SDS-06 | Import rows without End Time | End defaults to two hours after start, capped at 23:59 |
| SDS-07 | Import 23:00 without End Time | Window ends at 23:59, not the next day |
| SDS-08 | Import a supplier with no account | Preview identifies the missing account; commit is blocked |
| SDS-09 | Import invalid quantity | Preview reports the row and does not silently create it |
| SDS-10 | Import invalid date/time | Preview reports the row |
| SDS-11 | Import blank PO | Accepted according to current warning rule; no fake remark is created |
| SDS-12 | Import identical workbook twice | Second commit creates no duplicate proposal |
| SDS-13 | Change quantity in an already imported pending row | Conflict review shows the change |
| SDS-14 | Resolve conflict as Update | Pending proposal is updated |
| SDS-15 | Export Updated SDS after an updated import | Only newest revision for the same identity is exported |
| SDS-16 | Dressings planner imports Savoury-only rows | Out-of-scope rows are rejected |
| SDS-17 | Dressings planner imports Ecosystem rows | Ecosystem exemption is accepted as designed |
| SDS-18 | Import a workbook containing Dressings and Ecosystem for one supplier | Each row keeps its site and exact schedule |

## 5. Supplier confirmation — one truck

| ID | Scenario | Expected result |
|---|---|---|
| ONE-01 | Open confirmation and select one truck | Every requested material quantity is assigned automatically |
| ONE-02 | Inspect the quantity display | Quantity is visible but locked; no editable number control is shown |
| ONE-03 | Switch from two trucks back to one | Full requested quantity returns to Truck 1 and locks |
| ONE-04 | Enter plate as `abc1234` | It normalizes to `ABC-1234` |
| ONE-05 | Enter fewer than 3 letters or 4 digits | Confirmation is blocked |
| ONE-06 | Enter phone using `+63` and ten digits starting with 9 | Accepted |
| ONE-07 | Enter phone using local `0` and ten digits starting with 9 | Accepted and normalized server-side |
| ONE-08 | Leave driver blank | Confirmation is blocked |
| ONE-09 | Leave PO blank | Confirmation is blocked |
| ONE-10 | Leave DR blank | Confirmation is blocked |
| ONE-11 | Leave helpers blank | Confirmation succeeds |
| ONE-12 | Submit valid one-truck details | Booking and QR are created once |
| ONE-13 | Double-click Confirm rapidly | Only one booking result is created |

## 6. Supplier confirmation — two trucks

| ID | Scenario | Expected result |
|---|---|---|
| TWO-01 | Select two trucks | Quantity controls become editable for both trucks |
| TWO-02 | Change Truck 1 quantity | Truck 2 automatically becomes Total minus Truck 1 |
| TWO-03 | Change Truck 2 quantity | Truck 1 automatically becomes Total minus Truck 2 |
| TWO-04 | Set one truck quantity to zero for a material | That material belongs only to the positive-quantity truck |
| TWO-05 | Split one material 50/50 | Two database shipment rows are created, each with its allocated quantity |
| TWO-06 | Split several materials differently | Every material total is conserved independently |
| TWO-07 | Use duplicate plates | Confirmation is blocked |
| TWO-08 | Leave Truck 2 PO or DR blank | Confirmation is blocked and names Entry 2 |
| TWO-09 | Use invalid Truck 2 phone | Confirmation is blocked and names Entry 2 |
| TWO-10 | Submit valid two-truck details | Two bookings and two delivery codes are created |
| TWO-11 | Compare both resulting rows | Date, start time, and end time are identical to the source schedule |
| TWO-12 | Open day/week calendar | Overlapping trucks appear side by side at the same vertical time |
| TWO-13 | Compare supplier, planner, and Ecosystem views | The same truck stays at the same vertical time in every filtered view |
| TWO-14 | Open each delivery ticket | Each shows its own plate, driver, phone, PO, DR, QR, and allocated quantities |

## 7. Proposed alternatives

| ID | Scenario | Expected result |
|---|---|---|
| ALT-01 | Propose a different date, same time | Planner sees original vs proposed date |
| ALT-02 | Propose same date, different time | Planner sees original vs proposed time |
| ALT-03 | Propose different date and time | Both changes are retained |
| ALT-04 | Submit Reschedule without changing date/time | Existing schedule is retained; no invalid blank values |
| ALT-05 | Add optional reason | Reason appears for planner and in email |
| ALT-06 | Submit alternative | Status becomes Waiting for planner approval; supplier cannot submit another |
| ALT-07 | Planner approves | Supplier receives approved pending confirmation |
| ALT-08 | Planner rejects without reason | Rejection is blocked |
| ALT-09 | Planner rejects with reason | Supplier sees rejection and reason |
| ALT-10 | Supplier confirms one truck after approval | Booking uses approved date/time |
| ALT-11 | Supplier confirms two trucks after approval | Both bookings use approved date/time/end time |
| ALT-12 | Quantity change: split one material over two dates | Planner sees two allocation rows; approval creates two proposals |
| ALT-13 | Quantity change: split one material over two times on same date | Approval creates two proposals at the exact times |
| ALT-14 | Quantity change: several materials share one new time | They group into one proposal |
| ALT-15 | Quantity change totals less than requested | Submission is blocked or remaining amount is explicitly added on blur |
| ALT-16 | Quantity change totals more than requested | Submission is blocked |
| ALT-17 | Mark quantity Can’t deliver without reason | Submission is blocked |
| ALT-18 | Mark all quantities Can’t deliver with reasons | Planner approval records unable-to-deliver outcome without fake booking |
| ALT-19 | Reject an alternative, then import/update the schedule | App does not resurrect an already invalid stale response silently |
| ALT-20 | Propose a new time without manually setting an end | Approved schedule automatically spans two hours |
| ALT-21 | Approve, then add one or two trucks | Two-hour start/end window remains unchanged on every booking |

## 8. Schedule and calendar consistency

| ID | Scenario | Expected result |
|---|---|---|
| CAL-01 | Booking 05:00–07:00 | Ticket begins at 05:00 line and spans two hours |
| CAL-02 | Booking 17:00–19:00 | Ticket begins at 5 PM line and spans to 7 PM |
| CAL-03 | Two 17:00–19:00 bookings | They are side by side, not 17:00–19:00 then 19:00–21:00 |
| CAL-04 | Add an unrelated 17:00 Dressings booking | Ecosystem ticket does not move vertically |
| CAL-05 | Filter to Ecosystem-only data | Stored times and vertical positions remain unchanged |
| CAL-06 | View same date in Day and Week modes | Start/end positions match |
| CAL-07 | Planner edits start/end | Ticket moves to the new exact window |
| CAL-08 | Planner sets end before start | Save is blocked |
| CAL-09 | Planner edits one of two truck bookings | Only selected booking changes; notification identifies that booking |
| CAL-10 | Scroll through 24-hour timeline | Axis labels stay aligned with tickets |
| CAL-11 | Booking at 00:00 | Ticket appears at top of day |
| CAL-12 | Booking ending 23:59 | Ticket stays within the day lane |

## 9. Delivery ticket and QR

| ID | Scenario | Expected result |
|---|---|---|
| TKT-01 | Open approved ticket | Plate, driver, and phone are prominent and readable |
| TKT-02 | Inspect details | PO number and DR number are separate fields |
| TKT-03 | Open pending ticket | QR remains locked |
| TKT-04 | Open approved ticket | QR loads through authenticated endpoint |
| TKT-05 | Download booking PDF | PDF opens and matches booking details |
| TKT-06 | Supplier edits truck details before unloading | Allowed fields update; schedule stays unchanged |
| TKT-07 | Supplier tries editing after unloading begins | Server blocks the change |

## 10. Ecosystem

| ID | Scenario | Expected result |
|---|---|---|
| ECO-01 | Add material code, description, UOM | Catalog saves all three fields |
| ECO-02 | Submit request as scoped planner | Destination is locked to planner’s area |
| ECO-03 | Submit multiple materials | One request contains each selected catalog item and quantity |
| ECO-04 | Manipulate client description/UOM | Server uses trusted catalog values |
| ECO-05 | Repeat same request ID | Duplicate is rejected |
| ECO-06 | Ecosystem views outgoing request | It appears in My entries/notifications with descriptions |
| ECO-07 | Supplier sends inbound delivery to Ecosystem | Ecosystem sees only its incoming delivery |
| ECO-08 | Wrong Ecosystem account opens a specifically assigned inbound delivery | Access is denied |
| ECO-09 | Two trucks deliver one Ecosystem schedule | Both retain the same stored time and appear side by side |
| ECO-10 | Compare Ajinomoto supplier view and Ecosystem view | Same shipment IDs have the same date/start/end values |

## 11. Scan and receiving workflow

| ID | Scenario | Expected result |
|---|---|---|
| SCAN-01 | Supplier records optional Trip | Status changes once and timestamp/actor are saved |
| SCAN-02 | Skip Trip and scan Gate | Gate workflow still works |
| SCAN-03 | Gate scan earlier than allowed | Entry is blocked until permitted time |
| SCAN-04 | Security reviews then accepts Gate | Gate in timestamp is recorded |
| SCAN-05 | Security rejects Gate without reason | Rejection is blocked |
| SCAN-06 | Security rejects Gate with categorized reason | Supplier is notified; booking remains correctable |
| SCAN-07 | Scan same stage twice | No duplicate transition/timestamp is created |
| SCAN-08 | Warehouse scans Unloading before Gate in | Server blocks sequence |
| SCAN-09 | Warehouse scans Unloading after Gate in | Unloading timestamp is recorded |
| SCAN-10 | Try the old Received stage | Server rejects it as an unavailable stage |
| SCAN-11 | Gate out before Unloading | Server blocks the sequence |
| SCAN-12 | Gate out after Unloading | Gate-out and unloading-completion timestamps are recorded and the dock is released |
| SCAN-13 | Repeat Gate out | No duplicate transition/timestamp is created |

## 12. SAP PostgreSQL worksheet

| ID | Scenario | Expected result |
|---|---|---|
| SAP-01 | Allowed network + correct DB | Existing imported rows appear newest first |
| SAP-02 | Wrong database name | Clear unavailable response; no JSON fallback |
| SAP-03 | Correct DB but wrong schema/table case | Clear unavailable response explaining the connection/table issue in logs |
| SAP-04 | Network outside `SAP_ALLOWED_CIDRS` | No rows are returned |
| SAP-05 | Scroll through 27,000 rows | Rows load in pages; browser/API remain responsive |
| SAP-06 | Search DR, batch, item, supplier | Server returns matching PostgreSQL rows |
| SAP-07 | Change sort newest/oldest | Order changes without loading all rows at once |
| SAP-08 | SAP Analyst adds a row | Row is saved; Encoded by uses the current analyst |
| SAP-09 | SAP Analyst edits allowed fields | Revision increments and changes persist |
| SAP-10 | Planner edits Destination | Destination saves; SAP-only fields remain protected |
| SAP-11 | Warehouse edits receiving fields | Allowed fields save; SAP-only fields remain protected |
| SAP-12 | Two users edit same revision | Stale save receives a conflict instead of overwriting silently |
| SAP-13 | Edit a cell while ten-second refresh occurs | Unsaved local edit is not discarded |
| SAP-14 | Apply formatting and row height | Formatting persists after refresh/restart |
| SAP-15 | Export workbook | Leading zeros and saved formats remain intact |
| SAP-16 | App syncs a Gate-in row that already has analyst edits | Existing edits are preserved |
| SAP-17 | Gate in is within scheduled time plus grace | On Time is Yes |
| SAP-18 | Gate in is later than scheduled time plus grace | On Time is No |
| SAP-19 | Warehouse enters Actual Quantity Received equal to or above DR Quantity | In Full is Yes |
| SAP-20 | Warehouse enters Actual Quantity Received below DR Quantity | In Full is No |
| SAP-21 | On Time and In Full are both Yes | OTIF is Yes |
| SAP-22 | Either On Time or In Full is No | OTIF is No |
| SAP-23 | Actual Quantity Received is blank | In Full and OTIF stay blank, not falsely No |

## 13. Clearance and reports

| ID | Scenario | Expected result |
|---|---|---|
| CLR-01 | Warehouse opens Clearance | Searchable allowed deliveries appear |
| CLR-02 | SAP Analyst opens Clearance | View/download works; editing follows role rules |
| CLR-03 | Supplier tries Clearance endpoint | Access is denied |
| CLR-04 | Open a delivery with matching SAP DR/PO/material | Supplier, truck, quantity, batch/lot, and timestamps autofill |
| CLR-05 | Enter Warehouse/QA fields and download | One A4 landscape page contains matching left/right copies |
| CLR-06 | Delivery has multiple materials | Values are combined on one delivery page as designed |
| CLR-07 | Filter by supplier and status | Only matching clearance entries remain |
| CLR-08 | Filter by From and To dates | Only schedules inside the inclusive date range remain |
| CLR-09 | Clear filters | Full clearance list returns |
| RPT-01 | Change report month | Counts and rows follow selected month |
| RPT-02 | Supplier opens report | Only that supplier’s deliveries appear |
| RPT-03 | Open operational report | Old receipt-based OTIF fields are absent; OTIF remains in SAP Analysis |
| RPT-04 | Export report Excel | Download matches visible month and role scope |

## 14. Responsive and recovery checks

| ID | Scenario | Expected result |
|---|---|---|
| UI-01 | Desktop 1920×1080 | No clipped modal actions or unreadable account cards |
| UI-02 | Laptop 1366×768 | Calendar, confirmation, and ticket can scroll without overlap |
| UI-03 | Mobile 390×844 | Forms stack; primary actions remain reachable |
| UI-04 | Browser zoom 125% and 150% | Key controls remain usable |
| UI-05 | Dark mode | Ticket, calendar, SAP selection, and errors remain legible |
| UI-06 | Network drops during save | Error is shown and unsaved input is not presented as saved |
| UI-07 | API restarts while page is open | Page recovers after refresh/session renewal |
| UI-08 | Press Escape in nested modal | Only the active modal closes cleanly |

## Failure report template

```text
Case ID:
Account role and area:
Shipment / delivery code:
Steps performed:
Expected:
Actual:
Browser and screen size:
Network request URL/status/response:
API log lines at the same time:
Screenshot:
Repeatable: Always / Sometimes / Once
```
