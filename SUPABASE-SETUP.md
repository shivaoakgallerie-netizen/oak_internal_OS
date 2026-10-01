# Activate the real Supabase workspace

Project: https://supabase.com/dashboard/project/ochtkcazmudyhtxjnjmf

The supplied public URL and publishable key are configured. On 30 September 2026, the hosted workflow tables and protected API were verified, the shared notification-email upgrade was installed, and Admin plus Rohit Ghosh and Shibani's separate Staff accounts were activated. Staff now have distinct email alias logins; their existing Auth IDs, roster IDs, phone links and history were preserved and verified. Private recovery links were generated successfully, but Staff password setup, alias inbox delivery and live notification delivery remain pending. Custom SMTP was verified disabled in Authentication → Emails → SMTP Settings. The latest signup check found public signup enabled; disable it before rollout. Phone Auth is not required for the chosen email/password login.

## 1. Database

**Already installed for this project; do not rerun the new-install schema.** For a separate new project, use **SQL Editor → New query**, paste the entire contents of `schema.sql` and click **Run**. This creates the workflow tables, private media bucket, transactional functions and Admin/Staff policies together in one transaction. It adds no sample records or passwords.

Use `schema.sql` only for a new database. For an existing workflow database, back up first and apply `migrations/20260930_secure_admin_staff.sql`. V1 Issue/Update databases first require the older upgrade migration.

**Already applied to this project:** `migrations/20260930_staff_notification_email.sql`. For a separate existing installation, apply it before importing Staff or deploying the updated worker. This standalone upgrade allows a null Staff Auth email, adds a separate notification_email (which may be shared), and keeps Auth email required for active Admin accounts. It preserves IDs, records, permissions and history. It also includes the earlier phone-only column change; that earlier migration does not need to run separately. The importer checks for the notification column before creating Auth identities. A private local roster backup and record counts were saved under backups before this project's update.

Verify:

```sql
select tablename, rowsecurity from pg_tables
where schemaname='public' and tablename in ('team_users','tickets','request_events','attachments');
select public from storage.buckets where id='service-photos';
```

RLS must be true for every workflow table. Bucket public must be false. Anonymous API reads must be denied.

## 2. Authentication

Under **Authentication → Sign In / Providers**:

- Disable public signup; provision accounts through the administrator.
- Keep email/password enabled for both Admin and Staff sign-in and password recovery.
- Phone Auth and Twilio are not required. The current login screen has no SMS flow.
- Set minimum password length to 12, appropriate Auth rate limits, and CAPTCHA. Configure the Turnstile secret in Supabase and its public site key through PUBLIC_TURNSTILE_SITE_KEY.
- Enable and configure custom SMTP under **Authentication → Emails → SMTP Settings** for Admin and Staff password setup/recovery. The custom SMTP switch is currently off; Supabase's default sender has restrictions. Verify delivery to both Staff aliases before relying on email recovery.

Under **URL Configuration**, set the real HTTPS application URL and allow its exact password setup redirect, e.g. `https://YOUR-HOST/?setup=1`. Local testing uses `http://localhost:8080/?setup=1`. Avoid broad production wildcard redirects.

## 3. Admin and Staff accounts

Aditya Nahata's Admin account is active and remains linked to `adityanahata@oakgallerie.com`. Choose or verify the personal password through the recovery flow, then check normal sign-in. The registered Staff logins are:

| Staff member | Login email | Notification email |
|---|---|---|
| Rohit Ghosh | info+rohit@oakgallerie.com | info@oakgallerie.com |
| Shibani | info+shibani@oakgallerie.com | info@oakgallerie.com |

The domain's MX records point to Google, and Google Workspace supports plus-address variations. Delivery of these aliases into the info inbox has not yet been tested. The two Staff accounts retain their previous IDs, phone numbers and history. No Staff password has been set and no setup email or SMS has been sent. Do not share passwords or recovery links.

Both aliases are intended to deliver into the shared mailbox. Anyone who can read that mailbox can use password recovery for either Staff account. Separate accounts keep actions attributed to the account in use, but do not establish strong individual identity assurance against other shared-mailbox readers. Individually controlled recovery mailboxes are needed for that assurance.

Create a private copy of `staff-roster.example.csv`. Replace every placeholder with real names and verified E.164 phone numbers. Columns: name, phone_e164, email, auth_email, role, department, active. For Staff, email is the optional notification address, which may be shared; auth_email is the distinct login/recovery email. For Admin, email remains the login/recovery address and auth_email must be blank or identical. The importer rejects duplicate login emails and never infers a Staff login from the notification address. Only admin/staff roles are accepted, and an active Admin must remain. The private local roster already includes the two aliases above, department Team.

Keep the service-role key in local `.env` or a secure server process environment. Never paste it into chat or browser files:

```dotenv
SUPABASE_URL=https://ochtkcazmudyhtxjnjmf.supabase.co
SUPABASE_SERVICE_ROLE_KEY=YOUR_PRIVATE_SERVER_KEY
APP_URL=https://YOUR-HOST/
```

Validate without account changes:

```powershell
npm run import:staff -- staff-roster.csv --dry-run
```

Create/link accounts idempotently, without messages:

```powershell
npm run import:staff -- staff-roster.csv
```

To prepare Staff password setup locally without sending email, allow the exact local setup redirect in Supabase, start the app, then run:

```powershell
npm run setup:staff-passwords -- staff-roster.csv --app-url http://localhost:8080/
```

This verifies the registered Staff identities and generates recovery links in a private `backups/*.secret` file. Links for both registered Staff were generated successfully with the verified redirect `http://localhost:8080/?setup=1`. The links are credentials: open the appropriate link locally for password setup, keep the file off public hosting and do not paste its contents into chat. It sends no email and does not set a password. Use the deployed HTTPS URL instead of localhost for production setup.

When recipients, SMTP and redirect URL are ready and sending is explicitly authorized, request setup emails:

```powershell
npm run import:staff -- staff-roster.csv --send-password-links
```

New accounts with a login email receive an unpredictable initial password generated on the server, never printed or saved. The account holder chooses a password through a recovery/setup link. Updating an existing account preserves its current password and identity; adding an alias to a formerly phone-only account does not automatically set a usable password. The optional send-password-links flag requests recovery email for every active imported account with a login email, including Staff, and sends no SMS.

Staff chooses **Staff**, enters their alias and individual password. Admin chooses **Admin**, enters their registered email and password. Staff imports link by phone or the explicit auth_email, never by the notification email; conflicting identities are rejected. For legacy provisioning the importer still accepts Staff without auth_email, preserving phone-only identities, but those accounts cannot use the current email/password screen until a login email and password are configured.

Admin can deactivate staff after reassigning open work. RLS immediately denies data to existing tokens and push subscriptions are revoked. Import active=false to additionally ban the Auth account.

## 4. Start and verify

```powershell
npm ci
npm test
npm run validate
npm start
```

Open http://localhost:8080. Sign in as Admin, add a real client project, then test all four request types. Sign in separately as Staff to verify assigned work and urgent acknowledgement. See PROTOTYPE-TESTING.md for sample test notes.

Deploy only `dist`. Netlify builds with `npm run build`. Public deployment variables are PUBLIC_SUPABASE_URL, PUBLIC_SUPABASE_PUBLISHABLE_KEY, PUBLIC_VAPID_KEY and PUBLIC_TURNSTILE_SITE_KEY. Public Supabase keys are intentionally visible; RLS protects records. Privileged keys are never included.

## 5. Real notifications

The database outbox is connected. Actual push/email delivery requires deployment and configuration of the existing notification-worker, notification-scan and resend-webhook Edge Functions using `supabase/config.toml`.

Staff receives email fallback at notification_email when configured. Notification messages do not sign anyone in or acknowledge requests; the named recipient must authenticate to acknowledge an urgent message. The shared recovery mailbox limitation described above still applies. If neither notification_email nor an Auth email is available, missing fallback appears as a failed email-channel attempt without calling Resend. A successful push remains provider acceptance. There is no workflow SMS notification channel.

Set server secrets VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT, RESEND_API_KEY, RESEND_FROM_EMAIL, RESEND_WEBHOOK_SECRET and APP_URL. Verify the Resend sender domain. Set PUBLIC_VAPID_KEY in the frontend. Auth SMTP and workflow notification email are separate configurations.

Create Vault secrets project_url/service_role_key, then run `supabase/cron.sql`: worker every minute, scan every five minutes. Activate recurring jobs only when providers and staff recipients are ready. Test real provider delivery, private uploads, inactive-account denial, urgent reassignment, overdue reminders and device logout before rollout.

All 17 automated tests, validation and the build pass. The SQL tests use embedded PostgreSQL with Supabase Auth/Storage interfaces stubbed. They verify actual SQL permissions but do not replace hosted password sign-in, inbox delivery, actual Storage upload or device delivery tests.
