// Replace these public values during deployment. Never place service-role,
// Twilio, Resend, or VAPID private keys in this browser file.
window.OAK_CONFIG = {
  supabaseUrl: '__SUPABASE_URL__',
  publishableKey: '__SUPABASE_PUBLISHABLE_KEY__',
  vapidPublicKey: '__VAPID_PUBLIC_KEY__',
  captchaSiteKey: '__TURNSTILE_SITE_KEY__'
};
