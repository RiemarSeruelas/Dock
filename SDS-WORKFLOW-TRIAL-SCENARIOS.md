# DockFlow SDS Upload and Supplier-Response Trial Scenarios

This checklist is intentionally limited to the SDS workflow:

1. Planner/Administrator uploads an SDS Excel workbook.
2. DockFlow creates a pending proposal for the matched supplier account.
3. The supplier either accepts the schedule or selects **Propose alternative**.
4. A Planner/Administrator approves or rejects an alternative.
5. The supplier enters one- or two-truck details after accepting the schedule.
6. DockFlow creates the final booking, delivery code, QR, calendar entry, notification, and Updated SDS record.

> DockFlow does not have a simple supplier **Deny** button. If the supplier cannot accept the uploaded schedule, use **Propose alternative**. For an undeliverable quantity, use **Change in quantities → Can't deliver** and provide a reason.

## Using the included Excel scenario pack

The ZIP supplied with this guide contains 15 separate upload-ready workbooks. Upload **one workbook at a time**. Do not combine the files, because the duplicate/revision cases depend on a specific order and the intentionally invalid rows should not interfere with normal-flow tests.

The sample supplier is `Ajinomoto`. If your supplier account uses a different exact company name, replace `Ajinomoto` in the Supplier column before uploading. Keep `UNLINKED SDS TEST SUPPLIER` unchanged in file 14 because that file intentionally tests a missing supplier account.

| File | Workflow to test |
|---|---|
| `01-direct-accept-one-truck.xlsx` | Supplier accepts directly with one truck |
| `02-direct-accept-two-trucks.xlsx` | Supplier accepts directly and splits quantities across two trucks |
| `03-propose-later-time-approve.xlsx` | Supplier proposes a later time; planner approves |
| `04-propose-later-time-reject.xlsx` | Supplier proposes a later time; planner rejects with a reason |
| `05-propose-different-date.xlsx` | Supplier proposes a different date |
| `06-split-quantity-over-schedules.xlsx` | Supplier splits one material quantity over multiple schedules |
| `07-partial-cant-deliver.xlsx` | Supplier schedules part and marks the balance Can't deliver |
| `08-all-cant-deliver.xlsx` | Supplier marks the full quantity Can't deliver |
| `09-duplicate-original.xlsx` | Original upload for duplicate/revision testing |
| `10-duplicate-same-content.xlsx` | Upload after file 09; should not create another proposal |
| `11-revision-changed-quantity.xlsx` | Upload after file 09 while still pending; choose Update |
| `12-multiple-dates-times-sites.xlsx` | Grouping, area access, and Ecosystem routing |
| `13-missing-end-time.xlsx` | Two-hour default end and 23:59 cap |
| `14-missing-supplier-account.xlsx` | Commit block for an unlinked supplier account |
| `15-invalid-and-warning-rows.xlsx` | Missing/invalid fields and current warning behavior |

Files 09–11 must be tested on a fresh proposal in this exact order: **09, 10, then 11**. Do not let the supplier confirm file 09 before testing file 11, because only a pending supplier proposal is eligible for the revision/update path.

## Test setup

Create or confirm these accounts before testing:

| Account | Required setup |
|---|---|
| Administrator | Both-area access |
| Planner/Production | Correct Dressings or Savoury area |
| Supplier A | Linked to the exact supplier name used in the workbook |
| Supplier B | Different supplier, used for confidentiality tests |
| Ecosystem | Used only for SDS rows with Site = Ecosystem |

Use a test workbook with these columns where possible:

| Supplier | Material Code | Description | UOM | Quantity | Delivery Date | Delivery Time | End Time | Site | PO Number |
|---|---|---|---|---:|---|---|---|---|---|
| Supplier A | MAT-001 | Test material one | KG | 100 | 2026-09-21 | 09:00 | 11:00 | Dressings | PO-001 |
| Supplier A | MAT-002 | Test material two | KG | 200 | 2026-09-21 | 09:00 | 11:00 | Dressings | PO-002 |

Run the scenarios on a copy of the trial data. Save the browser Network response and API log for every failure.

## A. SDS upload preview and commit

| ID | Test | Steps | Expected result |
|---|---|---|---|
| SDS-01 | One valid row | Upload one valid row and open Preview | One ready row; supplier account is matched |
| SDS-02 | Several materials, same schedule | Upload MAT-001 and MAT-002 with the same supplier/date/time/site | Preview groups them into one delivery proposal |
| SDS-03 | Different delivery times | Change MAT-002 to 13:00–15:00 | Preview creates two proposals, each with its exact time |
| SDS-04 | Different delivery dates | Move MAT-002 to the next date | Preview creates two proposals |
| SDS-05 | Different receiving sites | Put one row in Dressings and one in Savoury | Rows remain separated by site and area |
| SDS-06 | Ecosystem site | Set Site to Ecosystem | Row is accepted through the Ecosystem import rule |
| SDS-07 | Missing End Time | Leave End Time blank | Preview accepts the row; committed schedule defaults to a two-hour window |
| SDS-08 | Late missing End Time | Use 23:00 with blank End Time | Default end is capped at 23:59 |
| SDS-09 | Missing PO | Leave PO blank | Row follows the current warning rule and no fake placeholder remark is created |
| SDS-10 | Missing supplier account | Use an unregistered supplier name | Preview lists the missing account and Commit is blocked |
| SDS-11 | Supplier spelling mismatch | Add an extra character or different company suffix | It is treated as unmatched unless the normalized matching rule resolves it |
| SDS-12 | Blank supplier | Upload a blank Supplier cell | Row is invalid and no proposal is created |
| SDS-13 | Blank material code | Upload a blank Material Code cell | Row is invalid and no proposal is created |
| SDS-14 | Zero quantity | Set Quantity to 0 | Preview rejects or flags the row; no zero-quantity proposal is committed |
| SDS-15 | Negative quantity | Set Quantity below 0 | Preview rejects the row |
| SDS-16 | Text quantity | Set Quantity to nonnumeric text | Preview rejects the row |
| SDS-17 | Invalid date | Use an impossible or unreadable date | Preview rejects the row |
| SDS-18 | Invalid start time | Use an unreadable time | Preview rejects the row |
| SDS-19 | End before start | Use 11:00 start and 09:00 end | Preview rejects the invalid window |
| SDS-20 | Area violation | Dressings-only planner uploads a Savoury row | Commit is denied for the out-of-scope row |
| SDS-21 | Mixed valid and invalid rows | Upload several valid rows plus one invalid row | Preview clearly separates ready rows from issues; invalid data is not silently committed |
| SDS-22 | Commit valid preview | Select Commit once | Proposal is created with status Pending Supplier / Proposed |
| SDS-23 | Rapid double Commit | Double-click or repeat the same commit request | Only one logical import result is created |

## B. What the supplier should see after upload

| ID | Test | Steps | Expected result |
|---|---|---|---|
| SUP-01 | Correct supplier queue | Sign in as Supplier A after SDS-22 | Uploaded proposal appears under deliveries waiting for confirmation |
| SUP-02 | Wrong supplier isolation | Sign in as Supplier B | Supplier A proposal is absent |
| SUP-03 | Exact schedule | Compare workbook and Supplier A proposal | Date, start time, end time, site, material codes, UOMs, and quantities match |
| SUP-04 | Multiple grouped materials | Open the grouped proposal | Both material lines appear once with their own quantities |
| SUP-05 | Action notification | Open the notification bell | An unresolved action notification links to the proposal |
| SUP-06 | Open without responding | View and close the proposal | It remains Pending Supplier and the action remains unresolved |
| SUP-07 | QR before acceptance | Try to access/download the QR | QR remains unavailable until final booking |

## C. Supplier accepts with one truck

| ID | Test | Steps | Expected result |
|---|---|---|---|
| ONE-01 | Select one truck | Choose Accept delivery → 1 truck | Every material is automatically assigned to Truck 1 |
| ONE-02 | Quantity lock | Inspect Material quantities | Quantities are visible as locked values, not editable inputs |
| ONE-03 | Valid plate normalization | Enter `abc1234` | Field normalizes to `ABC-1234` |
| ONE-04 | Invalid plate | Enter fewer than 3 letters or 4 digits | Confirm is blocked with a plate-format message |
| ONE-05 | Valid +63 phone | Select +63 and enter ten digits beginning with 9 | Phone is accepted |
| ONE-06 | Valid local phone | Select 0 and enter ten digits beginning with 9 | Phone is accepted and normalized by the API |
| ONE-07 | Invalid phone | Enter too few digits or a number not beginning with 9 | Confirm is blocked |
| ONE-08 | Missing driver | Leave Driver blank | Confirm is blocked and identifies Entry 1 |
| ONE-09 | Missing PO | Leave PO blank | Confirm is blocked and identifies Entry 1 |
| ONE-10 | Missing DR | Leave DR blank | Confirm is blocked and identifies Entry 1 |
| ONE-11 | Blank helpers | Leave both helper fields blank | Confirmation remains allowed |
| ONE-12 | Valid confirmation | Complete all required fields and Confirm | One approved booking, one delivery code, and one QR are created |
| ONE-13 | Check final ticket | Open the booked delivery | Ticket shows the correct truck, driver, phone, separate PO and DR, date/time, materials, and QR |
| ONE-14 | Check calendar | Open Day and Week views | Booking appears at the uploaded time and duration |
| ONE-15 | Check notification resolution | Reopen the supplier notification | Original action is resolved after confirmation |
| ONE-16 | Repeat confirmation request | Resubmit the same response through a stale tab | API rejects the already-responded proposal; no duplicate booking appears |

## D. Supplier accepts with two trucks

| ID | Test | Steps | Expected result |
|---|---|---|---|
| TWO-01 | Enable two trucks | Choose Accept delivery → 2 trucks | Truck 1 and Truck 2 forms appear |
| TWO-02 | Quantity controls | Inspect both cards | Quantity fields become editable only in two-truck mode |
| TWO-03 | Split one material | Set MAT-001 to 60 on Truck 1 | Truck 2 automatically becomes 40 |
| TWO-04 | Reverse edit | Change MAT-001 on Truck 2 to 25 | Truck 1 automatically becomes 75 |
| TWO-05 | Assign one material to one truck | Set MAT-002 to 200/0 | MAT-002 belongs only to the truck with quantity 200 |
| TWO-06 | Split several materials | Use MAT-001 60/40 and MAT-002 125/75 | Each material totals its own original requested quantity |
| TWO-07 | Quantity below zero | Try a negative amount | Value is prevented/clamped or confirmation is blocked |
| TWO-08 | Quantity above total | Try more than the requested total | Value is prevented/clamped or confirmation is blocked |
| TWO-09 | Duplicate plates | Enter the same plate for both trucks | Confirmation is blocked |
| TWO-10 | Missing Truck 2 required field | Leave Truck 2 DR, PO, driver, or phone blank | Confirmation is blocked and identifies Entry 2 |
| TWO-11 | Valid two-truck confirmation | Complete both truck cards and Confirm | Two approved booking rows and two unique delivery codes/QRs are created |
| TWO-12 | Stored time consistency | Compare both booked rows | Both retain the same date, start time, and end time from the SDS proposal |
| TWO-13 | Calendar overlap | Open the calendar | Both trucks appear side by side at the same vertical time, not one after another |
| TWO-14 | Filter consistency | Compare supplier, planner, and Ecosystem-filtered views | The same shipment stays at the same displayed time in every view |
| TWO-15 | Ticket identity | Open both tickets | Each ticket shows only its own plate, driver, phone, PO, DR, QR, and allocated quantities |
| TWO-16 | Switch back to one truck before submit | Select 1 truck | Truck 1 receives the full quantities again and values lock |

## E. Supplier cannot accept the uploaded schedule

### E1. Propose a different date/time

| ID | Test | Steps | Expected result |
|---|---|---|---|
| ALT-01 | Different date only | Propose alternative with a new date and the same time | Planner sees original and proposed date |
| ALT-02 | Different time only | Keep date and select a new time | Planner sees original and proposed time |
| ALT-03 | Different date and time | Change both fields | Both proposed values are retained |
| ALT-04 | Optional explanation | Enter “Truck available later” | Reason appears in planner review and notification/email |
| ALT-05 | Submit only once | Send proposal | Status becomes Waiting for planner approval; a second supplier response is blocked |
| ALT-06 | No truck details yet | Inspect the alternative form | Truck/driver/PO/DR are not required until the schedule is approved and accepted |

### E2. Propose quantity changes

| ID | Test | Steps | Expected result |
|---|---|---|---|
| QTY-01 | One later allocation | Move the full MAT-001 quantity to another date/time | Planner sees one complete allocation |
| QTY-02 | Split one material across two dates | Allocate MAT-001 as 60 and 40 on different dates | Total remains 100 and both schedules appear in review |
| QTY-03 | Split one material across two times | Allocate 60 at 09:00 and 40 at 13:00 on the same date | Two exact time allocations appear |
| QTY-04 | Split multiple materials | Give each material its own date/time breakdown | Totals are validated per material and UOM, never as one combined total |
| QTY-05 | Total below requested | Leave MAT-001 allocations totaling below 100 | Remaining amount is added when the field loses focus or submission is blocked until total is 100 |
| QTY-06 | Total above requested | Make MAT-001 total more than 100 | Submission is blocked |
| QTY-07 | Zero allocation row | Enter 0 | Empty/zero row is not treated as a valid scheduled quantity |
| QTY-08 | Can't deliver without reason | Mark quantity Can't deliver and leave reason blank | Submission is blocked |
| QTY-09 | Partial can't deliver | Schedule 60 and mark 40 Can't deliver with a reason | Planner sees scheduled 60 and undeliverable 40 separately |
| QTY-10 | Entire material can't deliver | Mark all 100 Can't deliver with a reason | Planner sees no fake date/time for that amount |
| QTY-11 | Every material can't deliver | Mark all requested quantities Can't deliver | Approval records the unable-to-deliver outcome and does not create a fake booked truck |

## F. Planner/Administrator reviews the supplier alternative

| ID | Test | Steps | Expected result |
|---|---|---|---|
| PLN-01 | Review queue | Sign in as the correct Planner | Alternative appears under Rescheduling with action count |
| PLN-02 | Wrong area planner | Sign in as a planner from the other area | Request is absent and direct API access is denied |
| PLN-03 | Review details | Open request | Original schedule, proposed schedule, reason, and quantity allocations are clear |
| PLN-04 | Approve date/time alternative | Select Approve reschedule | Supplier receives a new pending confirmation using the approved date/time |
| PLN-05 | Approve quantity split | Approve QTY-02 or QTY-03 | DockFlow creates one pending supplier proposal per distinct date/time group |
| PLN-06 | Approve partial Can't deliver | Approve QTY-09 | Only deliverable allocations become pending proposals; reason remains recorded |
| PLN-07 | Reject without reason | Select Reject and submit blank reason | Action is blocked |
| PLN-08 | Reject with reason | Enter a reason and Reject | Request status becomes Rejected and supplier sees the reason |
| PLN-09 | Repeat decision in stale tab | Submit Approve/Reject again | API reports already reviewed and does not duplicate schedules |
| PLN-10 | Notification resolution | Finish a decision | Planner action notification is resolved |
| PLN-11 | Supplier notification | Approve or reject | Supplier receives the corresponding in-app notification and email when configured |

## G. Supplier responds after planner approval

| ID | Test | Steps | Expected result |
|---|---|---|---|
| FIN-01 | Approved new time | Supplier opens the returned proposal | Approved date/time is now the schedule to confirm |
| FIN-02 | One truck after approval | Enter one valid truck and Confirm | One final booking and QR use the approved schedule |
| FIN-03 | Two trucks after approval | Enter two valid trucks and split quantities | Two final bookings share the approved schedule window |
| FIN-04 | Approved quantity split | Confirm each generated date/time proposal | Each booking uses its own approved allocation quantity and schedule |
| FIN-05 | Rejected alternative | Supplier opens rejected request | Rejection reason is visible; no booking or QR was created |
| FIN-06 | Try confirming rejected request by API | Submit a stale confirmation | Server rejects it |

## H. Duplicate upload and changed SDS data

| ID | Test | Steps | Expected result |
|---|---|---|---|
| DUP-01 | Upload identical workbook again | Preview and Commit the same rows | No duplicate proposal is created |
| DUP-02 | Same contents, different filename | Rename workbook and upload | Identity still prevents a duplicate |
| DUP-03 | Change quantity before supplier response | Upload revised quantity and choose Update | Existing pending proposal is updated; supplier sees revised quantity |
| DUP-04 | Change date/time before supplier response | Upload revised schedule and choose Update | Existing pending proposal moves to revised date/time |
| DUP-05 | Ignore conflict | Choose the non-update conflict action | Existing proposal remains unchanged |
| DUP-06 | Revise after final booking | Upload a changed row matching an already booked delivery | System must not silently overwrite or duplicate the completed booking; inspect conflict result |
| DUP-07 | Updated SDS export | Export after DUP-03 or DUP-04 | Only the newest imported revision for that identity is included |

## I. Notifications, email, and confidentiality

| ID | Test | Steps | Expected result |
|---|---|---|---|
| MSG-01 | New SDS notification | Commit a valid upload | Correct supplier receives one actionable notification |
| MSG-02 | Open notification | Click it | Correct proposal opens |
| MSG-03 | Mark/read without response | Open or mark notification read | Required action remains unresolved until supplier responds |
| MSG-04 | Supplier accepts | Confirm a valid booking | Required action resolves |
| MSG-05 | Supplier proposes alternative | Send alternative | Supplier action resolves; planner action is created |
| MSG-06 | Planner approves | Approve request | Planner action resolves; supplier confirmation action is created |
| MSG-07 | Planner rejects | Reject request | Planner action resolves; supplier receives rejection notice |
| MSG-08 | SMTP unavailable | Repeat the workflow with SMTP disabled | Core workflow still completes; email failure does not undo data changes |
| MSG-09 | Supplier confidentiality | Inspect Supplier A bootstrap/network response | Supplier B schedules and internal-only material descriptions are absent |

## J. Calendar and data-integrity checks

| ID | Test | Steps | Expected result |
|---|---|---|---|
| DATA-01 | Compare workbook to proposal | Check date, start/end, site, quantities | Values match after normalization |
| DATA-02 | Compare proposal to one-truck booking | Check schedule and totals | Schedule is unchanged and every material total is conserved |
| DATA-03 | Compare proposal to two-truck bookings | Sum allocations by material | Sum equals the original quantity for every material |
| DATA-04 | Same-time two-truck display | View Day and Week calendar | Both cards start at the same time line and appear side by side |
| DATA-05 | Different-time proposal display | Approve a different time | Card moves to the approved time, not the original time |
| DATA-06 | Supplier vs planner view | Compare the same shipment ID | Date/start/end values and calendar position agree |
| DATA-07 | Supplier vs Ecosystem view | Compare the same Ecosystem-bound shipment ID | Date/start/end values and calendar position agree |
| DATA-08 | Final booking identifiers | Confirm two trucks | Shipment IDs, delivery codes, and QR codes are unique per truck |
| DATA-09 | Refresh/restart | Refresh browser and restart containers | Pending/approved/rejected states remain consistent |
| DATA-10 | Rapid actions | Double-click Upload Commit, Supplier Confirm, or Planner Decision | Idempotency/conflict checks prevent duplicate logical results |

## Recommended end-to-end trial runs

Complete these in order. They cover the main real-world branches with the least repeated setup.

### Run 1 — Direct acceptance, one truck

1. Upload two materials under one supplier/date/time/site.
2. Commit the preview.
3. Sign in as the supplier.
4. Accept with one truck.
5. Verify quantities are locked.
6. Enter plate, driver, phone, PO, and DR.
7. Confirm.
8. Verify one booking, QR, ticket, calendar card, and resolved notification.

### Run 2 — Direct acceptance, two trucks

1. Upload two materials under one schedule.
2. Supplier accepts with two trucks.
3. Split both material quantities differently.
4. Confirm both trucks.
5. Verify two unique bookings/QRs.
6. Verify both use the same date/start/end and appear side by side.

### Run 3 — Supplier proposes a later time; planner approves

1. Upload 09:00–11:00.
2. Supplier proposes 13:00–15:00 with a reason.
3. Confirm no truck fields are required yet.
4. Planner approves.
5. Supplier confirms one or two trucks.
6. Verify final booking uses 13:00–15:00 everywhere.

### Run 4 — Supplier proposes a later time; planner rejects

1. Upload a valid schedule.
2. Supplier proposes a different time.
3. Planner attempts rejection without a reason; verify it is blocked.
4. Planner enters a reason and rejects.
5. Verify supplier sees the reason and no QR/booking exists.

### Run 5 — Quantity split over two dates

1. Upload MAT-001 quantity 100.
2. Supplier selects Change in quantities.
3. Allocate 60 on Date A and 40 on Date B.
4. Planner approves.
5. Supplier confirms each returned proposal.
6. Verify final quantities total 100 and each booking uses its own date.

### Run 6 — Partial quantity cannot be delivered

1. Upload MAT-001 quantity 100.
2. Supplier schedules 60 and marks 40 Can't deliver.
3. Attempt without a reason; verify it is blocked.
4. Add a reason and submit.
5. Planner approves.
6. Verify only quantity 60 becomes bookable and quantity 40 remains recorded as undeliverable.

### Run 7 — Duplicate and revised workbook

1. Upload and commit a workbook.
2. Upload the identical workbook again; verify no duplicate.
3. Change its quantity/time and upload again.
4. Review the conflict and choose Update.
5. Verify the pending supplier proposal changes once.
6. Export Updated SDS and verify only the newest revision is present.

## Failure-report template

```text
Scenario ID:
Workbook filename:
Workbook row(s):
Account role and area:
Supplier name:
Shipment number:
Steps performed:
Expected result:
Actual result:
Browser Network URL/status/response:
API log at the same timestamp:
Screenshot:
Repeatable: Always / Sometimes / Once
```
