# DockFlow Delivery Scheduling System

DockFlow helps authorized company personnel and suppliers manage proposed delivery schedules, truck confirmations, QR-based receiving, live monitoring, delivery history, and supplier performance in one application.

The system follows every confirmed truck from booking through Gate out and records all operational timestamps in **Asia/Manila time (GMT+8)**.

## Who Should Use DockFlow

- Administrators responsible for accounts, receiving-site settings, schedules, and system supervision
- Dressings and Savoury Planners responsible for SDS uploads and schedule decisions
- Supplier account owners responsible for confirming trucks and proposed delivery times
- Security personnel responsible for Gate in and Gate out scans
- Dressings and Savoury Warehouse personnel responsible for Unloading and Received scans
- Authorized personnel reviewing delivery history and supplier performance

## Main Functions

- Role-based user accounts and page access
- SDS workbook import and proposal comparison
- Supplier-account validation before a delivery can proceed
- Material-code-based delivery planning
- One-truck-at-a-time supplier confirmation
- Supplier acceptance or reschedule requests
- Planner or Administrator reschedule decisions
- Delivery-code and QR-code generation after confirmation
- QR scanning for each delivery stage
- Scan timestamps and scanner-account audit records
- Live truck monitoring and automatic process prioritization
- Automatic dock occupancy during onsite delivery stages
- Trip ETA and estimated arrival time
- In-app notifications with unresolved-action counters
- Optional email verification and delivery notifications
- Delivery history with search and filters
- Supplier performance reports and styled Excel export
- Downloadable booking receipt in PDF format
- Responsive desktop, television, tablet, and mobile layouts
- Light and dark themes, including Fullscreen Monitoring
- JSON trial storage for operation without PostgreSQL
- Authentication, authorization, rate limiting, CORS protection, security headers, and request tracking

## Account Roles and Access

| Account | Main Access and Responsibility |
| --- | --- |
| **Administrator** | Full access to Overview, Monitoring, Schedule, Scan, History, Reports, Accounts, receiving-site settings, and supplier route settings. |
| **Planner – Dressings** | Reviews Dressings activity, imports SDS schedules, monitors deliveries, and decides supplier reschedule requests. |
| **Planner – Savoury** | Reviews Savoury activity, imports SDS schedules, monitors deliveries, and decides supplier reschedule requests. |
| **Supplier Account** | Sees only its company schedules and records, confirms trucks and material codes, requests rescheduling, performs the Trip scan, and views its own history and reports. |
| **Security** | Sees Monitoring, Schedule, and Scan; records Gate in and Gate out. |
| **Warehouse – Dressings** | Sees Dressings Monitoring, Schedule, and Scan; records Unloading and Received. |
| **Warehouse – Savoury** | Sees Savoury Monitoring, Schedule, and Scan; records Unloading and Received. |

Access is enforced by the API. Hiding a page in the sidebar is not the only protection; unauthorized API requests are also rejected.

## Dashboard Pages

| Page | Purpose |
| --- | --- |
| **Overview** | Shows today’s arrivals, trucks in transit, onsite activity, received deliveries, dock status, latest handoffs, and schedule responses. |
| **Monitoring** | Shows one card per confirmed truck, sorted by the latest delivery stage. Includes date-range filtering and a television-friendly fullscreen mode. |
| **Schedule** | Shows proposed and confirmed schedules on a day or week calendar. Authorized company users can import an SDS and review reschedule requests. |
| **My Entries** | Lets a supplier review its own proposals, confirm truck information and material codes, open approved QR codes, and view delivery details. |
| **Scan** | Records Trip, Gate in/out, Unloading, and Received according to the signed-in account’s role. |
| **History** | Stores previous deliveries and rejected proposals in one searchable record view. |
| **Reports** | Shows supplier delivery performance and allows a styled Excel report export. |
| **Administration** | Lets the Administrator create or delete accounts, check email-verification status, configure supplier dispatch addresses, and protect the receiving-site address. |

## Delivery Workflow

The normal process is:

`SDS import → Supplier review → Booked → Trip → Gate in → Unloading → Received → Gate out`

### 1. Create the Required Accounts

Before importing an SDS, create a Supplier Account whose company name matches the supplier in the workbook.

1. Sign in as Administrator.
2. Open **Administration → Accounts**.
3. Select **Add account**.
4. Choose **Supplier Account**.
5. Enter the supplier company name, username, initial password, and recipient email.
6. Give the login details to the authorized supplier representative through a secure channel.

If no active Supplier Account matches an imported supplier, DockFlow warns the uploader and blocks that supplier’s proposal from proceeding.

Deleting a Supplier Account requires the current Administrator password. Historical delivery records remain available after the account is deleted.

### 2. Import an SDS Workbook

Authorized Administrators and Planners open **Schedule → Import SDS**, then select the schedule file.

DockFlow accepts:

- `.xlsx`
- `.xlsm`
- `.xls`
- `.xlsb`
- `.xltx`
- `.xltm`
- `.ods`
- `.csv`
- `.tsv`

The main operational fields are:

| Field | Use |
| --- | --- |
| **Week** | Delivery week number |
| **Site** | Dressings or Savoury work area |
| **Supplier** | Supplier company linked to a Supplier Account |
| **Material code** | Protected item identifier shown instead of a material description |
| **UOM** | Unit of measure |
| **Quantity** | Planned amount or weight |
| **Date** | Proposed entrance date |
| **Time** | Proposed entrance time |

An import creates a **proposal**, not an approved booking. It does not yet create a QR code or report entry.

DockFlow compares uploaded rows with existing proposals:

- Identical information remains unchanged.
- A new proposal is added.
- A conflicting pending schedule opens a comparison showing the existing and uploaded values.
- The uploader chooses **Keep existing** or **Use uploaded schedule** for each conflict.
- Confirmed and completed records are preserved.

### 3. Supplier Reviews the Proposal

The linked supplier sees the proposal at the top of **Schedule** and in **My Entries**.

The supplier can:

- Accept the proposed date and time; or
- Reject the proposed time, provide a reason, and propose one alternative date and time.

If the supplier proposes an alternative, the Administrator or correct Planner receives an action-required notification and reviews the original schedule, proposed schedule, and supplier reason.

The company can approve or reject the alternative. The decision is returned to the supplier through the application and, when configured, by email.

### 4. Supplier Confirms the Truck Load

For an accepted schedule, the supplier confirms one truck at a time:

1. Enter the truck plate number.
2. Enter the driver name.
3. Choose the phone country code.
4. Enter the numeric local phone number.
5. Select every material code carried by that truck.
6. Select **Confirm Delivery**.

If material codes remain, the supplier repeats the confirmation for the next truck. All material codes for the proposal must be assigned.

After the final truck is confirmed:

- The delivery becomes **Booked**.
- A delivery code is generated for each truck.
- The QR code becomes available.
- The truck appears in Monitoring.
- The delivery becomes eligible for Reports.

Repeated clicks do not intentionally create duplicate truck confirmations; the server validates the workflow state before saving.

### 5. Scan the Delivery Stages

| Stage | Responsible Account | Result |
| --- | --- | --- |
| **Trip** | Supplier | Marks the truck in transit and starts ETA calculation. |
| **Gate in** | Security | Marks the truck onsite, removes ETA, and occupies an available dock automatically. |
| **Unloading** | Warehouse | Marks unloading in progress and keeps the dock occupied. |
| **Received** | Warehouse | Marks the goods received and records the receiving timestamp. |
| **Gate out** | Security | Completes the onsite journey and releases the occupied dock. |

Every scan records the delivery stage, Manila timestamp, signed-in scanner account, scanner role, delivery, and truck identifiers. The scan flow cannot skip the required order.

## Using the Scanner During the HTTP Trial

For a temporary local-network HTTP deployment:

- Use **Take QR photo** to open the phone camera and process the captured image.
- Use a USB or Bluetooth QR scanner that types into the scan field.
- Enter the delivery code manually when necessary.

A continuous live-camera stream normally requires HTTPS because mobile browsers treat camera access as a secure feature. The **Live camera** option becomes available when DockFlow is deployed through HTTPS.

## Monitoring and Dock Control

Monitoring shows one compact card per confirmed truck. Cards are ordered by progress, so a truck at Unloading appears above a truck still at Trip.

The process priority is:

`Gate out → Received → Unloading → Gate in → Trip → Booked`

Use the calendar to select a start date and an end date. Select **See all** to remove the date range.

Fullscreen Monitoring:

- Uses the currently selected light or dark theme.
- Shows a large live Manila clock.
- Fits multiple compact delivery cards on a television display.
- Keeps delivery details inside fullscreen when a card is opened.
- Can be closed with the fullscreen button or the `Esc` key.

Dock Control has two receiving docks. Dock assignment is automatic for the trial: an onsite truck occupies an available dock from Gate in until Gate out.

## ETA and Location Handling

The Administrator configures the receiving-site destination under **Administration → Receiving site** and a supplier dispatch address from that supplier’s Account card. The receiving-site address requires the current Administrator password before it can be viewed or changed.

DockFlow uses free address and routing services to calculate road distance and base travel time. It then applies a configurable Manila weekday, weekend, and peak-hour estimate. This is an estimate, not live traffic.

ETA behavior:

- Starts after the supplier records Trip.
- Shows distance, travel minutes, and estimated arrival time.
- Disappears after Gate in because the truck has reached the site.
- Requires internet access unless the address and routing services are hosted on the local network.

Stored addresses and coordinates are encrypted with `LOCATION_ENCRYPTION_KEY`. Routing requests are made by the server so provider details and location data are not exposed as browser API keys.

## Notifications

The notification bell is beside the light/dark toggle in the top navigation.

Notifications cover:

- A new proposed schedule for the signed-in supplier
- A changed or rescheduled supplier proposal
- A supplier’s alternative-time request for the company
- Company approval or rejection of a proposed alternative
- A delivery marked Received

Opening an informational notification marks it read. An action-required number remains until the related supplier confirmation or company decision is completed.

## Email Verification and Email Notifications

Planner and Supplier accounts can verify their own recipient email using a six-digit code. Unverified accounts remain visible to the Administrator as pending. Security and Warehouse accounts do not require an email address.

The application sender is the private Administrator mailbox configured in `.env`. For Gmail, use a **Google App Password**, not the normal Gmail password.

When email notifications are enabled:

- Suppliers receive only changes belonging to their own company.
- New schedule messages include that supplier’s proposed details.
- Reschedule messages show the relevant Before and After details.
- Supplier alternative requests show the reason, scheduled time, and proposed time to the company.
- A Received message confirms the delivery and its material codes.

Email credentials are never returned by the API or displayed in the browser.

## History and Reports

History keeps previous delivery and rejection records. Authorized users can search and filter by the fields available to their role. Supplier users only see their own company.

Reports include confirmed deliveries, Gate-out completions, average Trip-to-Gate time, average Unloading time, average site turnaround time, and supplier-specific delivery details.

Company users can view all suppliers or select one supplier. The active filter is also used for the styled Excel export.

## Important Operating Rules

- DockFlow uses Asia/Manila time for schedules, notifications, scans, PDFs, and reports.
- An SDS upload creates proposals; it does not automatically book trucks.
- A supplier must have an active linked Supplier Account.
- Suppliers see material codes, not material descriptions.
- All material codes must be assigned to confirmed trucks.
- A QR code is created only after the supplier finishes confirmation.
- Pending proposals do not appear in Monitoring or Reports.
- ETA is available only between Trip and Gate in.
- A delivery remains active until Gate out.
- Gate in and Gate out use the same Security station.
- Unloading and Received are separate Warehouse stages.
- Scan order and role permissions are enforced by the API.
- Historical records remain when an account is deleted.
- Browser password-saving prompts are controlled by the browser and device policy; DockFlow avoids intentionally storing passwords in application data.

## Security and Privacy

DockFlow includes password hashing with bcrypt, short-lived access tokens, rotating refresh sessions, HTTP-only refresh cookies, role-based API authorization, separate rate limits, configured CORS origins, private-network origin support, security headers, request IDs, server-side validation, protected uploads, encrypted stored locations, server-only email/routing configuration, and scanner-account audit information.

Rate limiting temporarily rejects excess requests with HTTP `429`. It does not permanently ban an IP address. Login, token refresh, ETA lookup, and general API traffic have separate limits.

Keep `.env`, passwords, App Passwords, token secrets, and the location-encryption key private. Use HTTPS, restricted firewall rules, managed secrets, backups, and a protected database before a production internet deployment.

## Trial Storage and Offline Behavior

The current trial runs with PostgreSQL disabled. Business data is stored in:

```text
data/trial-data.json
```

Docker mounts this file from the project folder, so normal container recreation keeps the trial records.

Before manually editing or replacing the JSON file:

1. Stop DockFlow.
2. Create a backup copy.
3. Keep the existing JSON structure and valid data types.
4. Restart DockFlow and verify the accounts and schedules.

The core scheduling, confirmation, scanning, monitoring, history, and reports work on the local network. Public ETA lookup and Gmail delivery require internet access unless replacement services are hosted locally.

## Running DockFlow with npm

This option is useful for local development and testing.

### Requirements

- Windows PowerShell or Command Prompt
- Node.js **22.13.0 or newer**
- npm
- The complete DockFlow project folder

### 1. Open the Project Folder

```powershell
cd "C:\path\to\DockFlow"
```

### 2. Create the Private Environment File

```powershell
Copy-Item .env.example .env
```

Open `.env` and replace all placeholder secrets. At minimum, configure:

```env
APP_ORIGIN=http://localhost:3000
CORS_ORIGINS=http://localhost:3000
BOOTSTRAP_ADMIN_USERNAME=your_admin_username
BOOTSTRAP_ADMIN_PASSWORD=your_private_admin_password
ACCESS_TOKEN_SECRET=use_a_long_random_secret
REFRESH_TOKEN_SECRET=use_a_different_long_random_secret
LOCATION_ENCRYPTION_KEY=use_a_stable_random_value_of_at_least_32_characters
DB_ENABLED=false
TZ=Asia/Manila
```

For optional Gmail notifications, also configure:

```env
EMAIL_NOTIFICATIONS_ENABLED=true
SMTP_HOST=smtp.gmail.com
SMTP_PORT=465
SMTP_SECURE=true
SMTP_USER=your_sender@gmail.com
SMTP_APP_PASSWORD=your_google_app_password
MAIL_FROM=
```

Do not commit or share `.env`.

### 3. Install Packages

```powershell
npm.cmd install
```

### 4. Start the API and Website

```powershell
npm.cmd run dev
```

Open:

```text
http://127.0.0.1:3000
```

The terminal should show both the API and WEB processes. Keep the terminal open while using DockFlow.

### 5. Check the Project

```powershell
npm.cmd run lint
npm.cmd test
```

### 6. Stop npm Development Mode

Press `Ctrl+C`, then confirm termination if PowerShell asks.

## Running DockFlow with Docker

This is the preferred option for a repeatable local trial or deployment computer.

### Requirements

- Docker Desktop
- The complete project folder, including `Dockerfile` and `docker-compose.yml`
- A configured `.env` file
- Internet access for the first image build

### 1. Open the Project Folder

```powershell
cd "C:\path\to\DockFlow"
```

### 2. Create and Configure `.env`

```powershell
Copy-Item .env.example .env
```

For the default Docker address, keep:

```env
APP_PORT=5059
APP_ORIGIN=http://localhost:5059
CORS_ORIGINS=http://localhost:5059
ALLOW_PRIVATE_NETWORK_ORIGINS=true
DB_ENABLED=false
TZ=Asia/Manila
```

Also replace all Administrator, token, encryption, and optional email placeholders with private values.

When opening DockFlow from another phone or computer on the same network, `ALLOW_PRIVATE_NETWORK_ORIGINS=true` allows normal private-network origins. Keep the host firewall limited to trusted networks.

### 3. Build and Start DockFlow

```powershell
docker compose up -d --build
```

The API health check must pass before Docker starts the web container.

### 4. Check the Containers

```powershell
docker compose ps
```

Both `api` and `web` should show as running. The API should show as healthy.

If a service is not running:

```powershell
docker compose logs api --tail 100
docker compose logs web --tail 100
```

### 5. Open DockFlow

On the Docker computer:

```text
http://localhost:5059
```

From another trusted device on the same network:

```text
http://SERVER_IP:5059
```

Replace `SERVER_IP` with the IPv4 address of the Docker computer.

### 6. Normal Start Without Rebuilding

```powershell
docker compose up -d --no-build --pull never
```

### 7. Rebuild After a Code Update

```powershell
docker compose down
docker compose up -d --build --force-recreate
```

### 8. Apply `.env` Changes Without Rebuilding

```powershell
docker compose up -d --force-recreate --no-build
```

### 9. View Recent Logs

```powershell
docker compose logs --tail 100
```

To follow the logs live:

```powershell
docker compose logs -f
```

### 10. Stop DockFlow

```powershell
docker compose down
```

Do not use `docker compose down -v` unless you intentionally want to remove Docker-managed volume data.

### Docker Troubleshooting

#### Docker Cannot Download an Image

The first build requires access to Docker Hub. If the message contains `context deadline exceeded`, check internet access, VPN or proxy settings, firewall rules, DNS, and Docker Desktop connectivity, then retry.

#### The API Is Unhealthy

Run:

```powershell
docker compose logs api --tail 100
```

Confirm that `.env` contains valid secrets and that `data/trial-data.json` is valid JSON and writable.

#### The Website Container Does Not Start

The website waits for the API health check. Fix the API error first, then run:

```powershell
docker compose up -d
```

#### Another Device Shows a CORS Error

Confirm:

```env
ALLOW_PRIVATE_NETWORK_ORIGINS=true
```

Then recreate the containers:

```powershell
docker compose up -d --force-recreate --no-build
```

#### QR Live Camera Is Unavailable

Use **Take QR photo**, a hardware QR scanner, or manual delivery-code entry during HTTP testing. Deploy behind HTTPS for continuous browser camera access.

#### ETA or Email Does Not Work

Both features require outbound internet access in the default configuration. Check the API logs, address details, SMTP configuration, Google App Password, provider availability, and firewall rules.
