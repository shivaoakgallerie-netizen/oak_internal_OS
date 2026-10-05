# Oak Gallerie internal workflow

The application now uses **Supabase Auth, PostgreSQL permissions and private file storage**, with exactly two roles: Admin and Staff. Hardcoded demo passwords and browser-only authentication have been removed.

The supplied public project settings are configured in config.js. The hosted workflow database, shared notification-email upgrade, Admin credential guard and manage-staff Edge Function are installed. One Admin and two separate Staff accounts are active. Rohit uses info+rohit@oakgallerie.com and Shibani uses info+shibani@oakgallerie.com; both keep info@oakgallerie.com for notifications. Their existing IDs, passwords, phones and history are preserved. On October 5, disposable hosted accounts verified Staff password login, rejection of Staff password/email/recovery changes, permitted Auth Admin resets and the endpoint's current-Admin-password check. The updated frontend is published at https://cerulean-youtiao-fd7466.netlify.app; its exact origin and localhost are allowed. Hosted preflight checks passed, unapproved origins and unauthenticated calls were rejected, and original record counts were reconciled after temporary-account cleanup. Follow [SUPABASE-SETUP.md](SUPABASE-SETUP.md).

## Run

Requires Node.js 22+.

```powershell
npm ci
npm test
npm run validate
npm start
```

Open http://localhost:8080. The local server serves only the built dist directory, keeping environment files private. Netlify uses npm run build and publishes dist.

There are no default passwords or demo bypass. Both Staff and Admin sign in with their registered email and an individual password. Staff roster auth_email is the unique login address; email is the notification address and may be shared. Admin email remains the login and recovery address. The chosen login does not require SMS, Twilio or Phone Auth. Verified sessions must match the active roster. Session tokens stay in the current tab across reloads and are removed on sign-out. Request records and media are not cached locally.

Only Admin sees **Change password** for their own account. **Staff directory → Create staff login / Manage account** lets Admin create Staff accounts, edit names, departments, login emails and phones, set passwords, and activate/deactivate accounts. Each change requires the current Admin password. Staff have no password-change or recovery form. Login continues to use email and password; OTP and setup/magic links have been removed from the app and provisioning scripts.

After installing `migrations/20261005_admin_managed_accounts.sql`, a database constraint trigger rejects Staff password, email, phone, role and recovery-token changes unless Supabase Auth writes trusted Admin API audit evidence in the same transaction. It does not trust browser metadata, old audit entries or an open authorization window. This custom guard depends on Auth database audit logging and must be verified against the project's Auth version before rollout. If logging is disabled or changes, it denies Staff credential mutations, including Admin resets, rather than allowing them. Existing sessions and workflow IDs are preserved; Auth's Admin password reset revokes the target's refresh sessions. Already-issued access tokens can last until their normal expiry; deactivation immediately blocks database access through RLS.

## Access

Admin sees all requests, staff contacts, reports and delivery health; creates urgent messages, assigns colleagues and adds client projects. Staff creates Service, Help and personal Follow-up requests; updates assigned work and sees own created, assigned and shared Service/Help requests. Only the named urgent recipient can acknowledge. Open-request attachments are allowed for Admin, creator or assignee.

PostgreSQL functions derive the actor from the verified Auth identity. RLS enforces permissions even when screens are bypassed. User-editable Auth metadata cannot grant Admin access. Deactivated staff immediately lose database access.

## Workflow

Service requires a project. Follow-up belongs to its creator and has a future reminder. Urgent requires an active recipient and explicit acknowledgement.

New → In Review → Scheduled → Resolved supports early resolution and explicit reopening to In Review. A recorded update requires an explanation and, for open work, an expected timeline. Only that action resets the 24-hour inactivity clock. Viewing, assignment, uploads and acknowledgement leave it unchanged. Resolution cancels outstanding reminders.

Uploads use reserved paths, verified Storage metadata and five-minute signed URLs. JPEG/PNG/WebP images: 10 MB; MP4/MOV/WebM videos: 50 MB. Each attachment commits separately; interrupted uploads report partial success. Browser users cannot edit or delete linked attachments or trail events.
Previously issued file links can remain usable until their five-minute expiry after sign-out or deactivation; new links and database reads are denied.

The old local trial data remains separate. Startup scrubs its legacy password fields without silently importing or deleting trial requests/media. The retired demo engine is excluded from deployment.

## Delivery and validation

Notification rows are real outbox jobs. Actual push/email requires Edge Functions, VAPID, Resend, Cron and provider setup. Staff receive device push and see the in-app inbox; a configured notification_email enables email fallback, including a shared team inbox. Email names the assigned recipient. Opening an email link does not acknowledge an urgent message: only the named recipient's verified account can do that. Missing fallback is recorded in delivery health without sending to a fake address. Workflow SMS notifications are not implemented. The UI never invents successful delivery. Provider acceptance does not prove human receipt.

npm test runs authorization and workflow checks against embedded PostgreSQL, plus client and server account-management tests with Auth/Storage interfaces stubbed. The custom credential guard has passed local transaction tests. Hosted guard enforcement, Admin account management, private uploads and notification delivery still require live verification. Details and rollout steps are in [SUPABASE-SETUP.md](SUPABASE-SETUP.md).
