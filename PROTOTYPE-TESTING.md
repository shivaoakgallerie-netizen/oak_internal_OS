# Test the real Admin/Staff workspace

Complete SUPABASE-SETUP.md first. Former demo passwords no longer work. Use clearly labelled TEST requests and harmless sample photos.

Staff selects Staff and signs in with their alias and individual password: Rohit uses info+rohit@oakgallerie.com; Shibani uses info+shibani@oakgallerie.com. Admin selects Admin and signs in with aditya@oakgallerie.com and the Admin password. Private local setup links have been generated, but Staff passwords have not yet been set. Follow SUPABASE-SETUP.md to use or regenerate the links without sending email, or request setup emails only when sending is authorized and SMTP is ready. Custom SMTP is currently disabled.

Check that incorrect passwords are denied, unlisted/inactive accounts cannot load requests, the selected role matches the authenticated account, and password recovery works for both roles. Test expired or reused recovery links. Verify each account shows the correct name and retains its existing Auth ID, roster ID, phone and request history. Phone Auth, Twilio and SMS are not needed for these tests.

Both Staff keep info@oakgallerie.com for notifications. Confirm real delivery to each alias reaches this mailbox before relying on email recovery. Shared-mailbox readers can reset either Staff password, so this arrangement does not strongly distinguish people who have access to the same inbox. A notification link alone must not sign in or acknowledge an urgent request; check that only the assigned account can acknowledge it. Enable device push and check My reminders plus Admin delivery health after providers are configured.

1. Admin: add a test client project. Create Service: “TEST — Inspect dining-chair alignment.” Assign it to a test Staff account.
2. Staff: open the assignment, upload a sample photo, record In Review with note “TEST — Inspection booked” and timeline “Tomorrow at 3 PM.”
3. Staff: create shared Help ticket: “TEST — Confirm ivory fabric swatch availability.” Staff may choose themselves, but cannot assign colleagues.
4. Staff: create Follow-up: “TEST — Call client about fabric selection.” Choose 12 hours or a custom future date in India time.
5. Admin: create Urgent: “TEST — Confirm dispatch hold.” Select a test Staff recipient. That person can tap Acknowledge; other people cannot.
6. Admin: resolve early, then reopen to In Review. Verify each action appears in the documented trail.
7. Check reports and delivery health. Outbox jobs are real; provider delivery needs separate configuration. No demo success is generated.
8. Verify deadlines stay unchanged after reading, assigning, uploading and acknowledging. A recorded workflow update alone resets the 24-hour clock.
9. Once workers are configured, wait for real reminder boundaries. The live app has no clock-advance controls.
10. On another browser/device, verify data is shared after Refresh or the 30-second background refresh.

Automated permission and clock tests: npm test. All 17 tests, validation and the build pass. Hosted alias registration and identity preservation have been verified. Staff password setup/sign-in, actual alias inbox delivery, hosted password email, Storage upload and push still need testing on your project. No setup email has been sent.
