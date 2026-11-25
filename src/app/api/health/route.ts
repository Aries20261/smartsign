import { ENV } from '@/server/config';
import { db } from '@/server/db';
import { adminClient, BUCKET } from '@/server/supabase';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Diagnosa konfigurasi tanpa membocorkan nilai rahasia: hanya ada/tidak dan hasil koneksi. */
export async function GET() {
  const env = {
    APP_URL: ENV.appUrl, NEXT_PUBLIC_SUPABASE_URL: ENV.supabaseUrl || 'BELUM DIISI',
    NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: !!ENV.supabasePublicKey, SUPABASE_SECRET_KEY: !!ENV.supabaseSecretKey,
    DATABASE_URL: !!ENV.databaseUrl, APP_SECRET: ENV.appSecret.length >= 32 ? true : ENV.appSecret ? 'terlalu pendek (min 32)' : false,
    SUPERADMIN_EMAILS: ENV.superadminEmails.length, SMTP_URL: !!ENV.smtpUrl, CRON_SECRET: !!ENV.cronSecret
  };
  const checks: Record<string, string> = {};
  const hint = (m: string) => {
    if (/password authentication failed/i.test(m)) return 'Password database di DATABASE_URL salah.';
    if (/ENOTFOUND|getaddrinfo/i.test(m)) return 'Host DATABASE_URL tidak ditemukan. Pakai string "Transaction pooler" (…pooler.supabase.com:6543), bukan "Direct connection".';
    if (/ECONNREFUSED|ENETUNREACH|EHOSTUNREACH|ETIMEDOUT|timeout/i.test(m)) return 'Database tidak terjangkau. Pakai string "Transaction pooler" port 6543 (Direct connection hanya IPv6).';
    if (/Tenant or user not found/i.test(m)) return 'Username pooler salah. Harus berbentuk postgres.<project-ref>.';
    if (/relation .* does not exist|platform_settings/i.test(m)) return 'Tabel belum dibuat. Jalankan init.sql di SQL Editor.';
    if (/Invalid API key|invalid.*key|JWT/i.test(m)) return 'Kunci Supabase salah. Periksa publishable/secret key.';
    return m.slice(0, 160);
  };
  try {
    await db()`select 1 from platform_settings limit 1`;
    checks.database = 'OK';
  } catch (e: any) { checks.database = 'GAGAL: ' + hint(String(e?.message || e)); }
  try {
    const r = await fetch(ENV.supabaseUrl + '/auth/v1/settings', { headers: { apikey: ENV.supabasePublicKey } });
    const j = r.ok ? await r.json() : null;
    checks.auth = r.ok ? 'OK' + (j && j.mailer_autoconfirm ? ' (konfirmasi email NONAKTIF)' : '') : 'GAGAL: HTTP ' + r.status + (r.status === 401 ? ' (publishable key salah)' : '');
  } catch (e: any) { checks.auth = 'GAGAL: ' + hint(String(e?.message || e)); }
  try {
    const { data, error } = await adminClient().storage.getBucket(BUCKET);
    checks.storage = error ? 'GAGAL: ' + hint(error.message) + (/not found/i.test(error.message) ? ' (jalankan init.sql untuk membuat bucket)' : '') : data ? 'OK' : 'GAGAL';
  } catch (e: any) { checks.storage = 'GAGAL: ' + hint(String(e?.message || e)); }
  const ok = Object.values(checks).every((v) => v.startsWith('OK'));
  return Response.json({ ok, checks, env }, { status: ok ? 200 : 500, headers: { 'cache-control': 'no-store', 'x-robots-tag': 'noindex' } });
}
