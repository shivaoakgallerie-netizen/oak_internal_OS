# Activate the real Supabase workspace

Project: https://supabase.com/dashboard/project/ochtkcazmudyhtxjnjmf

The hosted workflow tables, shared notification-email upgrade, Admin and two distinct Staff accounts were previously verified. On October 5, the Admin account-management migration and manage-staff Edge Function were deployed, with database Auth audit logging enabled. Disposable hosted accounts verified Staff login, rejected self-service password/email/recovery changes, successful Auth Admin password reset, rejection of the previous password, and the endpoint's Admin role/current-password checks. Temporary accounts were removed and real employee passwords were unchanged. ACCOUNT_ALLOWED_ORIGINS allows http://localhost:8080 and https://cerulean-youtiao-fd7466.netlify.app. Staff login remains email and password. OTP, magic links and Staff password recovery are no longer offered by the app.

## 0. Deploy Admin account management

1. Take a database backup and test on a staging project first. Keep Supabase Auth database audit logging enabled. This custom guard uses the Auth service's `user_modified` Admin audit entry in the same database transaction; it fails closed if the entry is unavailable. It is a custom integration, not a native Supabase setting. Reverify it after Auth upgrades.
2. In Supabase SQL Editor, run `migrations/20261005_admin_managed_accounts.sql` after the existing secure and notification-email migrations. This adds the Staff credential guard, login synchronization and an immutable account-action trail. It preserves all account IDs and passwords.
3. Configure the Edge Function secret `ACCOUNT_ALLOWED_ORIGINS` with the exact deployment origin and, for local testing, `http://localhost:8080`, separated by commas. No wildcard origins. Standard SUPABASE_URL, SUPABASE_ANON_KEY and SUPABASE_SERVICE_ROLE_KEY are supplied by hosted Edge Functions and must never be copied into frontend files.
4. From an operator's authenticated Supabase CLI session, deploy both files under `supabase/functions/manage-staff` with `supabase functions deploy manage-staff --project-ref ochtkcazmudyhtxjnjmf --no-verify-jwt`. The function explicitly verifies the incoming user token against Auth, requires an active Admin roster entry, then checks the Admin's current password using a separate Auth client. The browser's role selection and user metadata do not authorize access.
5. Rebuild/redeploy the frontend with `npm run build`; publish `dist` only. Admin opens Staff directory → Manage account to set passwords directly, or Create staff login to add Staff. Staff never receive a setup link. Login email is the unique username; notification email may be shared.
6. Use a disposable account on staging to test password login, Staff API password/email/phone/recovery rejection, Admin API reset success, identity preservation and deactivation. Retest on hosted Auth before calling the server restriction enabled. Existing recovery links cannot change a Staff password once the guard is installed. Old issued JWTs may remain valid until expiry; inactive roster checks immediately deny data access.

Do not disable the guard to make a failing reset pass. Check that Auth database audit logging is enabled and that the installed Auth version still writes the documented Admin event. Rollback, if necessary, is to drop `admin_managed_staff_credentials` on auth.users; this restores Staff self-service and must not be presented as restricted access. See `PROTOTYPE-TESTING.md` for acceptance checks.

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
- Keep email/password enabled for Admin and Staff sign-in; disable public signup and external providers. Keep Phone Auth disabled.
- Phone Auth and Twilio are not required. The current login screen has no SMS flow.
- Set minimum password length to 12, appropriate Auth rate limits, and CAPTCHA. Configure the Turnstile secret in Supabase and its public site key through PUBLIC_TURNSTILE_SITE_KEY.
- Password creation/resets use the Admin screen and do not require SMTP. An operator can use the trusted Supabase Admin API or dashboard if the only Admin loses access.

Under **URL Configuration**, set the real HTTPS application URL. The app does not use password setup redirects or magic links. Avoid broad production wildcard redirects.

## 3. Admin and Staff accounts

Aditya Nahata's Admin account is linked to `aditya@oakgallerie.com`. Only Admin sees **Change password** for their own account. Admin creates/edits Staff passwords and login details from Staff directory. Staff who forget their password must contact Admin. The registered Staff logins are:

| Staff member | Login email | Notification email |
|---|---|---|
| Rohit Ghosh | info+rohit@oakgallerie.com | info@oakgallerie.com |
| Shibani | info+shibani@oakgallerie.com | info@oakgallerie.com |

The two Staff accounts retain their IDs, phone numbers and history. The aliases are login identifiers; notification delivery uses the configured notification address. Admin assigns passwords through Manage account. Existing private recovery-link files are obsolete and are never deployed.

After the credential guard is installed and verified, Staff recovery-token issuance and password changes are denied even when attempted through the Auth API. Before installing it, the old Supabase self-service behavior remains active.

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

The bulk importer is an operator tool for roster maintenance. New imported accounts get an unpredictable initial password that is never printed or stored; Admin must then set their usable password in Manage account. Existing accounts keep their password. Password-link generation and `--send-password-links` have been removed. For routine new staff, use Admin → Create staff login so Admin chooses the initial password directly.

Staff chooses **Staff**, enters their alias and individual password. Admin chooses **Admin**, enters their registered email and password. Staff imports link by phone or the explicit auth_email, never by the notification email; conflicting identities are rejected. For legacy provisioning the importer still accepts Staff without auth_email, preserving phone-only identities, but those accounts cannot use the current email/password screen until a login email and password are configured.

Admin can deactivate Staff after reassigning open work. The account-management endpoint removes roster access, revokes push subscriptions/cancels queued notifications, then bans the Auth account. If the provider call fails, database access stays blocked; retry the access action to synchronize the ban. Account-action events contain the actor, target and action, never a password.

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

Staff receives email fallback at notification_email when configured. Notification messages do not sign anyone in or acknowledge requests; the named recipient must authenticate to acknowledge an urgent message. If neither notification_email nor an Auth email is available, missing fallback appears as a failed email-channel attempt without calling Resend. A successful push remains provider acceptance. There is no workflow SMS notification channel.

Set server secrets VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT, RESEND_API_KEY, RESEND_FROM_EMAIL, RESEND_WEBHOOK_SECRET and APP_URL. Verify the Resend sender domain. Set PUBLIC_VAPID_KEY in the frontend. Auth SMTP and workflow notification email are separate configurations.

Create Vault secrets project_url/service_role_key, then run `supabase/cron.sql`: worker every minute, scan every five minutes. Activate recurring jobs only when providers and staff recipients are ready. Test real provider delivery, private uploads, inactive-account denial, urgent reassignment, overdue reminders and device logout before rollout.

The automated tests, validation and the build verify the application. The SQL tests use embedded PostgreSQL with Supabase Auth/Storage interfaces stubbed. They verify actual SQL permissions but do not replace hosted password sign-in, inbox delivery, actual Storage upload or device delivery tests.
