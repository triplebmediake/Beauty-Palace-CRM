# Cute Nails & Salons Kenya - backend

Status: schema, commission engine, checkout, login/permissions and API are written. Unit and API tests pass
against a STUB database. The SQL has NOT yet been run against a real PostgreSQL - do that first (see below).

## First run (PostgreSQL 14+, Node 20+)
    createdb salon
    psql salon -f db/schema.sql
    psql salon -f db/seed.sql          # roles, permissions, categories, default commission rules, settings
    psql salon -c "INSERT INTO branches (code, name) VALUES ('MAIN', 'Main Branch');"
    npm install
    cp .env.example .env               # set DATABASE_URL and a random JWT_SECRET (32+ chars)
    node --env-file=.env scripts/create-admin.js you@example.com "Your Name" "StrongPassword123"
    npm test                           # engine + checkout + auth + API tests
    npm start

Connect as a limited database user, not the owner: see the notes at the end of db/schema.sql.

## Layout
    db/schema.sql, db/seed.sql          database (seed.sql is generated: node scripts/gen-seed.js > db/seed.sql)
    src/commission/engine.js            rule lookup + commission maths (integer cents)
    src/sales/plan.js, checkout.js      pricing, materials, frozen commissions; one-transaction sale + void
    src/auth/*                          passwords (scrypt), tokens, TOTP, permissions, login
    src/api/routes.js, src/http/app.js  endpoints and a small HTTP server
    src/import/*                        historical Excel/CSV import (parse -> normalize -> plan -> run)

## Importing historical data (Owner / super admin only: permission data.import)
Columns are found by name, in any order: Date, Customer (or Client/Name), Phone/Contact, Technician, Service, Amount,
Payment method (Mode of Payment), Material used, Branch. Customer, Date, Service, Amount are required.
Files: .xlsx or .csv (not old .xls: Save As .xlsx). Maximum 12 MB; split larger books by year.

Before importing: make sure your services, technicians, branches and products exist (or tick "create missing services/technicians").

    POST /import/preview     { filename, contentBase64, options }   dry run, writes NOTHING, lists every problem row
    POST /import/commit      same body                               writes everything in ONE transaction
    GET  /import/batches                                             history of imports
    POST /import/:id/rollback { reason }                             voids every sale from that import

options: dateFormat "dmy"|"mdy" (default dmy: 05/10/2026 = 5 Oct), branchId, defaultTechnicianId, createServices, createTechnicians,
skipInvalidRows, unknownMaterials "error"|"ignore", onOverlap "skip"|"import", paidBefore (date), serviceAliases {"Gel": "Gel Polish"},
technicianAliases, mapping {"amount": "Total KES"}, sheet.

Rules the import follows:
- One customer + one day + one branch = ONE visit, with a line per service.
- Customers: matched by phone number first, then by exact name. Same name with a different phone stays separate; a name shared by
  several customers and no phone is rejected rather than guessed. New customers get NO marketing consent.
- Re-importing the same file is harmless: every visit has a fingerprint and duplicates are skipped. A day on which that customer already
  has a live (non-imported) sale is skipped unless onOverlap is "import".
- Commission is calculated with the rule in force on each sale date, then frozen. Commission dated before the start of the current
  Saturday-Friday week (or `paidBefore`) is recorded as already PAID through one "IMPORT batch N" payment per technician; later
  commission stays pending for your normal approve/pay run.
- Materials are recorded for cost only. Stock levels are NOT changed by history.
- Loyalty points are not awarded for imported history.
- Rollback voids the sales (they stay visible), reverses commission so it nets to zero, cancels the visits and retires the customers,
  services and staff the import created if they have no other sales.

## Hosts without a shell (Railway etc.)
Set ADMIN_EMAIL, ADMIN_NAME, ADMIN_PASSWORD once (after the schema, seed and a branch exist). On start the server creates the first
super admin only if there are no users. Then delete ADMIN_PASSWORD. Health check path: /health

## Setting up the database without any SQL tool (Railway etc.)
Set RUN_SETUP=true (plus optional BRANCH_CODE and BRANCH_NAME) and deploy. On start the server loads db/schema.sql and db/seed.sql
into an EMPTY database and creates the first branch. If the database already has tables it does nothing. Read the deployment log:
"Setup finished" = success; "SETUP FAILED -> ..." shows the exact error. Remove RUN_SETUP afterwards.

Set DATABASE_SSL=true if the database is reached over its public address and refuses unencrypted connections.

Admin recovery (no shell): set ADMIN_EMAIL, ADMIN_NAME, ADMIN_PASSWORD and ADMIN_RESET=true, deploy, check the log says "Password RESET", then delete ADMIN_PASSWORD and ADMIN_RESET.

## Loading the price list and technicians

**Price list (40 services from the salon posters).** In Railway, add the variable `LOAD_CATALOGUE` = `true` on the app and let it redeploy. The log shows `Catalogue: 40 new service(s) added`. It is safe to leave on or repeat: existing services are never overwritten, so prices you change later are kept. Durations are starting guesses and can be edited.
Not yet priced (no poster supplied): Facials, Lashes, Makeup, Wig installation, Piercings, Pedicure variants.

**Branch 1 technicians (19 nails, 6 hair).** Add the variable `LOAD_ROSTER` = `true`; the log shows `Roster: 25 technician(s) added`. Safe to repeat.

**Other technicians later.** Signed in as the Owner/Super Admin, `POST /technicians` with
`{ "branchId": 1, "specialty": "NAILS", "names": ["Mary W", "Jane A", ...] }` (then again with `"specialty": "HAIR"`). Names already on file are skipped. `GET /technicians` and `GET /services` list what is stored.

## The web screen and staff logins

Open the app's address in a browser (the same address as before). You get a sign-in page, then screens by role: New sale (receptionist), Sales reports, Commissions (management) and My sales / My commission (technicians).
- **Owner/admin → "Staff logins" tab**: "Create logins for all technicians" makes a login for each technician (e.g. `ahmed@cutenails.local`) with a one-time temporary password. "Add another person" creates the receptionist login. "Reset password" is next to each person.
- Everyone can change their own password with "Change password" at the top.
- Business week runs Saturday to Friday. Commission is calculated on the price after discount.

## Sale notes and hair materials
- Every sale has an optional **Notes** box; the note prints on the receipt and shows in the daily sales report. The `notes` column is added automatically to an existing database when the app starts.
- Hair services (category HAIR, including wig services) require **Materials bought for this service (KSh)** at the till (type 0 if none). Commission = 50% x (price after discount - materials). The materials amount and the commission are frozen on the sale. Other categories do not show the box.
- The daily sales report shows **Materials** and **Commission** on each service row (with totals); the CSV has two extra columns at the end, MATERIALS COST and COMMISSION.

## Dashboard
Management roles (Super Admin, Owner, Manager, Accountant) get a **Dashboard** tab: sales, unique customers, services sold, average spend, services per customer, new vs returning, commission owed, inventory value (only for roles allowed to see stock value), estimated operating profit (sales - materials - commission - expenses), weekly target progress, today's figures, alerts and technician performance, for Today / This week / Last week / This month / Last month. Owners set the weekly target with the "Set weekly target" button. Expenses and stock only appear once they are entered (there is no screen for them yet).

## Inventory, Expenses, Customers, Appointments
- **Inventory** (Owner, Manager, Accountant; managers of stock can add/adjust): item list with low-stock warnings, add item (with opening quantity), change stock (bought more, damaged, expired, returned, count correction), edit, and per-item history. Stock value is shown only to roles allowed to see it.
- **Expenses** (Owner/Accountant record; Manager views): record by category, date, amount, description and reference; totals by category; deleting needs a reason and is logged. Feeds the dashboard profit figure.
- **Customers** (Receptionist, Manager, Owner): search, filter by status (VIP, Active, Due, At risk, Lapsed, Win-back, ...), profile with visit history, top service, usual technician, notes, allergies, marketing consent, WhatsApp link (only if consented), add/edit customer.
- **Appointments** (Receptionist, Manager, Owner; technicians see only their own): book with services, technician, deposit and notes; double-booking a technician is refused; change status; "Ring up sale" pre-fills the sale screen and marks the appointment completed when the sale is saved.

## Import history and paying commission (web screens)
- **Import history** tab (Owner / Super Admin): choose an .xlsx or .csv of past sales, set the date style, press *Preview*. Nothing is saved until *Import now*. Unknown service/technician names can be matched to existing ones from a drop-down, then *Check again*. Every import is a batch that can be undone (*Undo*, a reason is required). Commission for weeks before the current one is recorded as already paid.
- **Commissions** tab: pick the dates, *Approve* (per technician, or *Approve all pending*), then *Pay* to settle a technician's approved lines (M-Pesa, cash, bank or other, with an optional reference). Managers can approve; Owners and Accountants can approve and pay.

## Follow-ups, loyalty points and campaigns
- **Follow-ups** tab (everyone who can see customers): customers whose usual return time has passed ("Due now", "At risk", plus optional "Lapsed"/"Win-back"). Anyone with a booked appointment is left out. WhatsApp opens with a ready message (only for customers who agreed to marketing) and records the contact; the tab shows the number waiting.
- **Loyalty** tab: Owner/Manager set the rules (spend per point, per-visit and birthday bonuses, value of a point, minimum to use). Points are added automatically on every new sale for a customer and taken back if the sale is voided. On *New sale*, pick the customer and press *Use points on this sale*; the points are deducted when the sale is completed. Imported history does not earn points. Managers can adjust a balance (reason required) from the customer profile.
- **Campaigns** tab (Owner/Manager create; others view): choose customer groups (VIP, Lapsed, Win-back, birthday this month...), write a message (`{name}` and `{salon}` are filled in) or start from a template. Only customers who agreed to marketing, have not opted out and have a phone number are included. The system does not send messages itself: staff tap *Send* per person to open WhatsApp/SMS with the message ready; it is then marked sent. *Asked to stop* removes the customer from all future campaigns. Results (replies, bookings, visits, revenue within the tracking window) show on the list.

## Settings screen
Owner / Super Admin see a **Settings** tab: logo, salon name and tagline, phone/WhatsApp/email/address/website/Instagram, receipt footer and tax PIN, opening hours for each day, and the customer-status rules (return time, Lapsed / Win-back / Inactive days, VIP thresholds). The name and logo appear on the sign-in page, the menu and receipts; the name is also used for `{salon}` in campaign messages. Settings live in the `app_settings` table; the new permission `settings.business` is added to existing databases automatically on start.

## Appointments and opening hours
Appointments can only be booked inside the opening hours set in Settings (Nairobi time). The booking form shows that day's hours and warns as soon as a chosen time is outside them; the server also refuses it (closed day, before opening, or a booking that would end after closing time). Existing appointments are not changed.
The Owner (and Super Admin) can tick **Owner override: allow outside opening hours** on the booking form. Such a booking is marked in its notes ("Booked outside opening hours by ..."). Managers and receptionists cannot override.

## Branch 2: Beauty Palace Kenya
Add the variable `LOAD_BRANCH2` = `true` in Railway and deploy. The log shows `Branch 2 "Beauty Palace Kenya": 13 technician(s) added ...`. It creates the branch (code `BPK`, which prefixes its receipt numbers: BPK-2026-000001), its 9 nail technicians and 4 hairdressers, and gives every Owner and Super Admin login access to it. Safe to repeat; afterwards you can delete the variable. Receptionists, managers and accountants for Branch 2 are created in **Staff logins** while Branch 2 is selected in the menu.
People who work in more than one branch get a **Branch** switcher at the top of the menu. Sales, appointments, inventory and expenses record data for the selected branch; the Dashboard, Sales reports and Commissions can also show **All branches** together. Customers and the service price list are shared by both branches; stock is separate per branch.

## Re-opening a sale and reprinting its receipt
In **Sales reports**, the Daily sales table has a **Receipt** column. Click a receipt number to open that sale's receipt (items, technician, discount, payments, notes). **Print receipt** prints it, marked "REPRINT"; voided sales show "VOIDED". Needs the permission to view receipts (Owner, Manager, Accountant, Receptionist); technicians see the number without a link.

## Receipt numbers
Receipt numbers are the branch code, the year and a running number: **CNS-2026-000001** for Cute Nails (Branch 1) and **BPK-2026-000001** for Beauty Palace Kenya (Branch 2). On start the server renames Branch 1's code to `CNS` (and Branch 2's to `BPK`). Receipts issued earlier, such as MAIN-2026-000001, are never changed; new ones carry on from the same counter with the new prefix.

## Services screen (add, edit, hide)
Owner / Super Admin see a **Services** tab: add a service (name, category, price, duration), edit any service, or untick "Show on the menu" to hide one from new sales (hiding never deletes; past sales are untouched). Changing a price needs a short reason and is logged. Changes apply to new sales only. Categories (Hair, Nails, Massage, ...) decide commission: Hair asks for materials cost and pays 50% after materials; the rest pay 40% of the price after discount.

## Commission per service

Open **Services** (owner). At the top, **Commission by category** shows the umbrella rule (for example Nails 40% of price, Hair 50% after materials) with a **Change** button. Every service in the category follows it.

To give one service its own rate, click **Edit** on the service, open the **Commission** box, choose **Custom rule for this service**, pick how it is worked out (percent of price, percent after materials, or a fixed KSh amount), enter the value and the date it starts. Choose **Use the category rule** to go back.

- Changes apply to new sales only; past sales keep the commission they were sold with.
- A service paid "after materials" asks for the materials cost on the New sale screen.
- A rule changed on the same day it starts is corrected in place; otherwise a new rule starts on the chosen date and the old one ends.
- Only the Owner (and Super admin) can change commission rules. Managers can see them, receptionists cannot.
- Precedence: technician+service, technician, service, category, default.

## Customer birthdays

Birthday is optional and is never printed on receipts. It can be entered when adding a customer (Customers tab), on the New sale screen (for a new customer, or for an existing customer who has none yet), and on the customer's profile. It powers the Loyalty birthday bonus and the "Birthday this month" campaign group.

## Payslips and commission exports

On the **Commissions** tab, pick the dates (the business week is Saturday to Friday) and press **Payslip** on a technician's row. The payslip lists every service with its commission, then services, sales, materials, total commission, already paid and balance due, with lines to sign. **Save payslip** downloads it as a text file, **Print** prints it. Technicians see only their own payslip.

Under the summary cards, **Export** gives two CSV files that open in Excel: **All commissions** and **Approved only**. Each line shows date, receipt, branch, technician, service, price, materials, rate, commission, status, and the approval and payment details. Voided sales appear as negative "(reversal)" lines. Exports need the "Export data" permission (owner, manager and accountant have it).

## Staff profiles

Open the **Staff** tab and tap a name. The profile shows lifetime sales since joining, customers served, services done, visits, the services the person is best known for, and absences. People who manage staff (owner, manager) can edit phone, email, ID number, date of employment and active status, upload a photo of the ID (stored privately, never shown to receptionists), and record absences (absent, sick, approved leave, late). Voided sales are not counted. The technician's phone number is shown on the **Commissions** screen and in the Pay window so payments can be sent by mobile money. Existing databases get the new fields automatically on the next start.

## Import notes

Each imported payment is stored with its own reference (IMPORT-<sale>-<method>). Re-uploading a file that was already imported is recognised by what is in the file (phone or name, date, services and amounts), so the same sales are skipped rather than doubled.

## Collabo (two hairdressers on one service)

On the New sale screen, a hair service has a tick box **Collabo: two hairdressers share this**. Tick it and choose the second hairdresser. The commission worked out for the service (for example 50% after materials) is split equally between the two; an odd cent goes to the first. Each hairdresser gets half of the service amount in the sales reports, half the customer credit in their profile, and their own commission line, payslip entry and mobile-money payment. The receipt shows both names on the line, and voiding the sale reverses both commissions. Only hair services can be shared, and it is always an equal 50/50 split.

## Branch 2 (Beauty Palace Kenya, code BPK)

- Run once: set `LOAD_BRANCH2=true` on Railway, let it deploy, then remove the variable. It creates the branch, 9 nail + 4 hair technicians, and gives owner/super-admin access.
- Settings → choose **"Beauty Palace Kenya only"** to set that branch's name, logo, phone, address, receipt footer and opening hours. Anything left blank (or equal to the default) follows "All branches". Status/VIP rules stay global.
- Receipts are numbered `BPK-year-number`; reports, commissions, staff and appointments are separated per branch; appointments respect that branch's opening hours.
- Inventory for Branch 2 starts empty: add its products on the Inventory screen while that branch is selected.

## One installation per branch
Set `ONLY_BRANCH_CODE` (for example `BPK`) on an installation that serves a single branch. The branch switcher and the "which branch" choices disappear, and that branch is used everywhere.
