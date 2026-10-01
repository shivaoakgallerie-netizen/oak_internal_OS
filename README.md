# Oak Gallerie internal workflow

The application now uses **Supabase Auth, PostgreSQL permissions and private file storage**, with exactly two roles: Admin and Staff. Hardcoded demo passwords and browser-only authentication have been removed.

The supplied public project settings are configured in config.js. The hosted workflow database and shared notification-email upgrade are installed. One Admin and two separate Staff accounts are active, with email/password login available in the app. Rohit uses info+rohit@oakgallerie.com and Shibani uses info+shibani@oakgallerie.com; both keep info@oakgallerie.com for notifications. Their existing Auth IDs, roster IDs, phones and history were preserved and verified. Staff still need to choose their passwords; email delivery and normal password sign-in require live verification. Follow [SUPABASE-SETUP.md](SUPABASE-SETUP.md).

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

The Staff addresses use Google Workspace plus-address variations intended to reach the same info mailbox; actual inbox delivery has not yet been tested. Separate Auth accounts preserve attribution in the workflow, but anyone able to read the shared inbox can reset either Staff password. They do not provide strong individual identity assurance against other readers of that mailbox.

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

npm test executes permission and workflow tests against embedded PostgreSQL, with Supabase Auth/Storage interfaces stubbed, plus browser-client tests. All 17 tests, validation and the build pass. Hosted Admin identity, authenticated database access and the Staff alias registrations have been verified. Private Staff setup links were generated successfully, but no Staff password has been set and no setup email has been sent. Custom SMTP is currently disabled. Password setup/sign-in, alias inbox delivery, real upload, password email and device push still require live verification. Details and rollout steps are in [SUPABASE-SETUP.md](SUPABASE-SETUP.md).
