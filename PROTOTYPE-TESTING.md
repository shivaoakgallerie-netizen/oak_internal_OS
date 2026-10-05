# Test the real Admin/Staff workspace

Complete SUPABASE-SETUP.md first. Former demo passwords no longer work. Use clearly labelled TEST requests and harmless sample photos.

Staff selects Staff and signs in with their alias and Admin-assigned password: Rohit uses info+rohit@oakgallerie.com; Shibani uses info+shibani@oakgallerie.com. Admin selects Admin and signs in with aditya@oakgallerie.com. Apply the account-management migration and deploy manage-staff before testing new Admin controls.

Check that incorrect passwords are denied and unlisted/inactive accounts cannot load requests. Admin should create a disposable Staff account, change its login email and password, then test the new login. Confirm the old password and email no longer sign in and the existing request history remains linked. Staff must see no password-change/recovery/account-management controls. Direct Staff calls to Auth updateUser and password recovery must fail after migration. Test forged role metadata, inactive Admin, wrong current Admin password and login-email/phone conflicts. Phone OTP and magic links are not used.

Both Staff keep info@oakgallerie.com for notifications. A notification link alone must not sign in or acknowledge an urgent request; check that only the assigned account can acknowledge it. Enable device push and check My reminders plus Admin delivery health after providers are configured.

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

Automated permission and clock tests: npm test. The account-management migration, Edge Function and updated Netlify frontend are deployed. Disposable hosted accounts verified Staff password login, rejected password/email/recovery changes, allowed Auth Admin reset and the endpoint's Admin role/current-password checks. Existing passwords were unchanged and temporary accounts removed; original record counts matched the backup. Both allowed origins passed preflight checks; unauthenticated calls and unapproved origins were rejected. Verify Admin account creation/edit/access using the following acceptance steps in the published frontend; actual Storage uploads and device push remain rollout checks.
