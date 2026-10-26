# Oak Gallerie security audit — 9 October 2026

Scope: local repository, local PGlite tests, static build, and npm registry audit. No production endpoint, live data, Supabase dashboard setting, or destructive migration was tested or changed. This is a security baseline, not a certification that the application is fully secure.

## Architecture and existing controls

Static JavaScript frontend on Netlify; Supabase Auth, PostgreSQL with RLS and security-definer RPCs, private Storage, and Deno Edge Functions for account management, notifications and a signed Resend webhook. The browser build rejects service-role credentials. Admin/Staff authorization is enforced by database functions and RLS, not only by UI controls. Request text is HTML-escaped when rendered. Storage uploads use reserved paths and ownership checks. Netlify config provides CSP, `nosniff`, and frame restrictions.

## Files changed by this audit

- `supabase/functions/_shared/response.ts`: streaming request-size limit.
- `supabase/functions/_shared/provider.js`: safe provider-error classification.
- `supabase/functions/manage-staff/index.ts` and `handler.js`: bounded input, sanitized responses and pinned Supabase client.
- `supabase/functions/resend-webhook/index.ts`: POST-only, bounded signed payload, sanitized errors and pinned client.
- `supabase/functions/notification-worker/index.ts` and `notification-scan/index.ts`: provider timeouts, safer error records/responses and pinned client.
- `tests/security.test.mjs`: security regression tests for the new boundary controls.
- `SECURITY-AUDIT.md`: audit evidence, limitations and deployment checklist.

Unrelated pre-existing workspace changes were preserved.

## Findings

| Severity | Finding | Status and evidence |
| --- | --- | --- |
| Critical / High | No verified issue in the inspected local code. | Existing PGlite tests exercise cross-user access, role forgery, deactivation, immutable events and private upload ownership. This does not establish safety of the hosted configuration. |
| Medium | Account-management endpoint returned raw Auth/database exception text to callers. | Fixed: `safeAccountFailure` allowlists user-facing messages and maps unexpected errors to a generic response; unit test checks that backend text is not returned. |
| Medium | Account-management and Resend webhook handlers read whole request bodies before rejecting oversize input; webhook also accepted other methods. | Fixed: streaming byte limits (8 KiB / 64 KiB) and POST-only webhook; tests cover byte limits, declared length and invalid UTF-8. |
| Medium | Push/email sends had no explicit network timeout and provider exception text could be persisted in delivery records. | Fixed: 10-second timeouts; persisted provider errors contain only a safe category or HTTP status. Unit test checks redaction. |
| Low | Edge Functions used a floating major-version Supabase client import. | Fixed: pinned to the repository's installed `@supabase/supabase-js` version, 2.117.2. |
| Medium | Tracked `artifacts/` screenshots contain employee names, email addresses, phone numbers and Auth user IDs. | Open: these existing user files were preserved. Restrict repository access; review removal/redaction and Git history with the owner before changing them. The screenshots need an owner-led sensitive-data review before wider sharing. |
| Low | CSP permits inline styles. | Open: current UI uses inline styles. A later markup refactor could remove `unsafe-inline`; this is not evidence of an XSS exploit. |

## Tests and limits

- Baseline: `npm test` 27/27, `npm run validate` passed.
- After hardening: `npm test` 29/29, `npm run validate` passed, `npm run build` passed, `git diff --check` passed.
- `npm audit --omit=dev --json` and `npm audit --json`: zero advisories reported for dependencies in `package-lock.json` on this date. This does not audit Deno's separate `web-push` and `svix` imports or unknown future advisories.
- Deno is not installed locally; Edge Function runtime, live provider delivery, hosted RLS configuration and Auth dashboard settings were not verified in this audit. Existing tests mock the account-management Auth/Storage interfaces and run SQL in embedded PostgreSQL.
- No secret values were printed. `.env` is ignored by Git; `.env.example` uses placeholders. Public Supabase publishable keys are intentionally browser-visible.

## Production configuration and deployment checklist

1. Review this diff and deploy the changed Edge Functions (`manage-staff`, `resend-webhook`, `notification-worker`, `notification-scan`) to an authorized staging project first. Verify valid Admin actions, invalid/oversize requests, signed webhook delivery and notification retries. Do not run the existing hosted test script against production without explicit approval; it creates and removes disposable Auth users.
2. In Supabase Auth, verify password minimum length (12+), rate limits, CAPTCHA/Turnstile on password sign-in, recovery and signup policy, email confirmation as applicable, audit logging for the custom Staff credential guard, and session/token lifetime. These are dashboard controls and cannot be inferred from this repository. See [Supabase rate-limit documentation](https://supabase.com/docs/guides/auth/rate-limits) and [CAPTCHA documentation](https://supabase.com/docs/guides/auth/auth-captcha).
3. Keep `SUPABASE_SERVICE_ROLE_KEY`, `RESEND_API_KEY`, `RESEND_WEBHOOK_SECRET`, and `VAPID_PRIVATE_KEY` only in server-side Edge secrets or Vault. Keep `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `APP_URL`, `ACCOUNT_ALLOWED_ORIGINS`, `RESEND_FROM_EMAIL`, `VAPID_PUBLIC_KEY`, and `VAPID_SUBJECT` configured for the deployment. Frontend build uses only `PUBLIC_SUPABASE_URL`, `PUBLIC_SUPABASE_PUBLISHABLE_KEY`, `PUBLIC_VAPID_KEY`, and `PUBLIC_TURNSTILE_SITE_KEY`.
4. Confirm private Storage bucket/policies, HTTPS, Netlify headers, backups and restore procedure, worker schedules, and Resend webhook signature secret on the hosted project. Rotate any credential only if exposure is confirmed and with an operator-approved plan; this audit found no private key in tracked source.
5. Review/redact tracked screenshots containing employee data and limit repository access. Re-run `npm test`, `npm run validate`, `npm run build`, and `npm audit` on each release.

No database migration, credential rotation, data deletion, production deployment, or infrastructure change was performed by this audit.
