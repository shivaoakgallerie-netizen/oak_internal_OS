# Oak Gallerie Internal Workflow

The current release is a **browser-only working prototype** for the Oak Gallerie team. Choose one of six demo people to try role-specific work queues, four request types, photo/video attachments, the documented activity trail, reports, staff directory, reminders, and simulated delivery health. No real phone OTP, push message, SMS, or email is sent.

Requests, the demo clock, history, and uploaded files are kept in IndexedDB in the current browser. Switching accounts or refreshing preserves that workspace. Another browser, device, or site address has a separate demo. Reset restores the sample requests and removes locally uploaded files. Browser data removal also removes the saved prototype. If storage is unavailable, the app reports that changes are temporary.

## Start and test the prototype

Serve the folder over HTTP; do not open `index.html` directly. From this folder, use an available static server, for example:

```powershell
python -m http.server 4173 --bind 127.0.0.1
```

Open `http://127.0.0.1:4173/` and choose a demo person. These accounts do not require passwords or OTP. See [PROTOTYPE-TESTING.md](PROTOTYPE-TESTING.md) for a guided demonstration with dummy requests.

Run checks and produce the static output with:

```powershell
npm test
npm run validate
npm run build
```

Node.js 22 or newer is required for all validation checks. No provider keys or npm dependency installation are needed to use or build this prototype. Netlify uses `npm run build` and publishes `dist`. Public provider variables are optional; `config.js` is retained for future integration but is not loaded by the prototype. Adding credentials does not activate real login or delivery.

## Demo roles

| Demo login | What this person can do |
|---|---|
| Admin / Owner | Create every request type, see and manage all work, assign people, resolve/reopen requests, view staff directory, reports, and delivery health |
| Manager / Team Lead | Create every request type, see and manage all work, assign people, resolve/reopen requests, view reports and delivery health |
| General Staff | Create Service, Help ticket, and personal Follow-up requests; update assigned work; upload attachments; acknowledge their own urgent messages |
| Service Technician 1 and 2 | Create Service and personal Follow-up requests; update/resolve assigned Service work and their own Follow-ups; upload attachments; acknowledge their own urgent messages |
| Support / Back-office | Create Help tickets and personal Follow-ups; update/resolve assigned Help tickets and their own Follow-ups; upload attachments; acknowledge their own urgent messages |

Only Admin and Manager can create Urgent messages or assign requests to another person. The staff directory is Admin-only. Staff, technicians, and support see requests they created, requests assigned to them, and shared work relevant to their role. Seeing a request does not automatically grant permission to update it. A personal Follow-up always belongs to its creator; every role can manage its own Follow-ups, including technicians. Only the named recipient can acknowledge an urgent message.

Role checks are applied to both the interface and prototype actions. These local demo accounts are for demonstration, not a security boundary. Server-side role enforcement is part of future integration.

## Request behavior

| Type | Required fields | Simulated delivery |
|---|---|---|
| Service | Project and description | Notify the owner when assigned |
| Help ticket | Description; owner optional | Notify the owner when assigned |
| Follow-up | Description and future reminder | Notify the creator at 12h, 24h, or the selected date |
| Urgent message | Description and recipient | Push immediately; email on push failure and again if unacknowledged after 15 minutes |

All requests use `New -> In Review -> Scheduled -> Resolved`; early resolution is allowed, and reopening returns to `In Review`. A recorded workflow update is the only action that resets the 24-hour clock. Assignment, viewing, acknowledgement, attachment upload, and delivery do not reset it. The 24-hour reminder goes to the assignee, or to the creator if the request is unassigned. Resolution stops pending reminders.

Admin and Manager can advance the demo clock by 15 minutes or 24 hours to demonstrate urgent repeats, overdue requests, and personal reminders. These controls change prototype time, not the computer's clock. Delivery health shows simulated results, not evidence that anyone received a real message. Urgent acknowledgement records the recipient's explicit action.

Photo/video selection accepts JPEG, PNG, WebP, MP4, QuickTime, and WebM, with 10 MB per image and 50 MB per video. Files remain in this browser; whether a video plays depends on the browser's codec support. Seeded media placeholders are labelled examples. The service worker stores only allowlisted static app files, while IndexedDB stores demo records and selected media separately.

## Future Supabase integration — retained backend groundwork

The SQL schema, migration, staff import script, and Edge Functions below are retained from the earlier backend implementation. The current demo frontend does not call them. Before a live release, reconnect authenticated UI actions to the server, add the agreed role matrix to database authorization, and complete end-to-end tests. The existing database's active-staff access model does not enforce the new demo role restrictions.

The following setup is a future integration checklist, not a way to switch the current demo into production:

1. Create a staging Supabase project and take a production backup before changing an existing database.
2. For a new project, apply `schema.sql`. For a V1 database, apply `migrations/20260923_internal_workflow_upgrade.sql` instead.
3. Enable Phone Auth and configure Twilio Verify. Disable public phone signup; the future login flow must use `shouldCreateUser:false`, verify the active roster, restore valid sessions, and reject deactivated staff. Configure Cloudflare Turnstile CAPTCHA and OTP rate limits in Supabase.
4. Install dependencies locally and import the approved roster:

   ```powershell
   $env:SUPABASE_URL='https://project.supabase.co'
   $env:SUPABASE_SERVICE_ROLE_KEY='service-role-key'
   npm run import:staff -- .\staff-roster.csv
   ```

   Start from `staff-roster.example.csv`. Keep the service-role key out of files and shell history used by shared machines.

5. Deploy the three Edge Functions:

   ```powershell
   supabase functions deploy notification-worker
   supabase functions deploy notification-scan
   supabase functions deploy resend-webhook --no-verify-jwt
   ```

6. Set Edge Function secrets: `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT`, `RESEND_API_KEY`, `RESEND_FROM_EMAIL`, `RESEND_WEBHOOK_SECRET`, and `APP_URL`. Supabase supplies `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` to hosted functions.
7. In Resend, verify the sender domain and point its webhook to `/functions/v1/resend-webhook` for delivered, bounced, and failed events.
8. Store `project_url` and `service_role_key` in Supabase Vault, then apply `supabase/cron.sql`. The service key remains encrypted in Vault and is sent only to authenticated Edge Functions.
9. Once real frontend integration is restored, set `PUBLIC_SUPABASE_URL`, `PUBLIC_SUPABASE_PUBLISHABLE_KEY`, `PUBLIC_VAPID_KEY`, and `PUBLIC_TURNSTILE_SITE_KEY`. The build can inject these into `dist/config.js`, but the current prototype does not load that file. Restore a live-mode configuration check as part of that integration.
10. Deploy to Netlify over HTTPS. `netlify.toml` builds only the static PWA into `dist`, so migrations, scripts, tests, and roster files are never published.

For an upgraded V1 database, import the roster before validating `active_staff_requires_email`. Existing attachment byte sizes are intentionally marked unvalidated because V1 did not store object sizes; new uploads are checked strictly.

After starting a disposable local Supabase database, run `supabase test db --file tests/workflow.sql`. This retained database suite covers required fields, type persistence, scheduled follow-ups, clock reset, notification creation, and recipient-only acknowledgement; it does not yet verify the new role matrix.

## Future operational checks before go-live

- Sign in every pilot user by phone OTP and confirm inactive/unlisted numbers cannot enter.
- Install the PWA and enable alerts on each pilot device.
- Create all four request types, including shared and assigned help tickets.
- Upload and reopen JPEG, WebP, MP4, QuickTime, and WebM attachments through signed URLs.
- Confirm an open update resets the clock, assignment does not, and resolution cancels pending reminders.
- Confirm the urgent recipient can acknowledge, another staff member cannot, and the 15-minute retry sends email.
- Inspect Delivery health after forced push failure and a Resend bounce.
- Review `cron.job_run_details`, Edge Function logs, and the request timeline during the one-week pilot.

## Retained backend security model

In the retained schema, authenticated active staff may read the shared workspace. Ticket changes run through security-definer RPCs that derive the actor from `auth.uid()`. Request events are append-only, attachments are immutable from the browser, media uses the private `service-photos` bucket, and the former live frontend requested five-minute signed URLs. The prototype uses local browser data instead; do not mistake demo restrictions for database authorization.
