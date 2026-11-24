import { createServerClient } from '@supabase/ssr';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { cookies } from 'next/headers';
import { ENV } from './config';

/** Klien Supabase Auth yang membaca/menulis cookie sesi (httpOnly) pada request saat ini. */
export async function authClient(): Promise<SupabaseClient> {
  const store = await cookies();
  return createServerClient(ENV.supabaseUrl, ENV.supabasePublicKey, {
    cookies: {
      getAll: () => store.getAll(),
      setAll: (list) => {
        for (const { name, value, options } of list) {
          try { store.set(name, value, { ...options, httpOnly: true, sameSite: 'lax', secure: ENV.isProd, path: '/' }); } catch { /* dipanggil dari konteks read-only */ }
        }
      }
    },
    auth: { flowType: 'pkce' }
  });
}

/** Klien tanpa cookie untuk memverifikasi password (re-autentikasi) tanpa mengganti sesi aktif. */
export function statelessClient(): SupabaseClient {
  return createClient(ENV.supabaseUrl, ENV.supabasePublicKey, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } });
}

let admin: SupabaseClient | null = null;
/** Klien server-only dengan kunci rahasia: Admin Auth API dan Storage privat. Jangan pernah dikirim ke browser. */
export function adminClient(): SupabaseClient {
  if (!admin) {
    if (!ENV.supabaseSecretKey) throw new Error('SUPABASE_SECRET_KEY belum diatur');
    admin = createClient(ENV.supabaseUrl, ENV.supabaseSecretKey, { auth: { persistSession: false, autoRefreshToken: false } });
  }
  return admin;
}

export const BUCKET = 'documents';
