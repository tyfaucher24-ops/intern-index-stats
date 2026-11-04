/* Intern Index stats — Supabase connection.
   The publishable (anon) key is public by design: every read goes through SECURITY DEFINER
   RPCs that check the caller against public.admins, and Row Level Security guards the tables.
   NEVER put the service_role key here or anywhere in this repo. */
window.STATS_CONFIG = {
  url: 'https://jsmhrhniqxohsalbejuw.supabase.co',
  anonKey: 'sb_publishable_59cFpjnYQoxlJVtlXxnAYw_V8GTebnr',
  google: true
};
