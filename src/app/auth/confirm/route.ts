import { NextResponse } from 'next/server';
import type { EmailOtpType } from '@supabase/supabase-js';
import { authClient } from '@/server/supabase';
import { ENV } from '@/server/config';
import { ASSET_V, pageCsp } from '@/server/web/html';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const TYPES: EmailOtpType[] = ['email', 'signup', 'recovery', 'email_change', 'invite', 'magiclink'];

/** Tautan dari email Supabase (verifikasi, reset password, ganti email). */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const tokenHash = url.searchParams.get('token_hash') || '';
  const type = url.searchParams.get('type') as EmailOtpType;
  const back = (path: string) => NextResponse.redirect(new URL(path, url.origin), { status: 303, headers: { 'cache-control': 'no-store' } });
  if (!tokenHash && !url.searchParams.get('error')) return fragmentPage();
  if (!tokenHash || !TYPES.includes(type)) return back('/?notice=' + encodeURIComponent('Tautan tidak valid atau sudah kedaluwarsa. Silakan minta tautan baru.'));
  const sb = await authClient();
  const { error } = await sb.auth.verifyOtp({ token_hash: tokenHash, type });
  if (error) return back('/?notice=' + encodeURIComponent('Tautan tidak valid atau sudah kedaluwarsa. Silakan minta tautan baru.'));
  if (type === 'recovery') return back('/reset');
  if (type === 'email_change') return back('/?notice=' + encodeURIComponent('Alamat email berhasil diperbarui.'));
  await sb.auth.signOut({ scope: 'local' });
  return back('/?notice=' + encodeURIComponent('Email terverifikasi. Silakan masuk.'));
}

/**
 * Template email bawaan Supabase ({{ .ConfirmationURL }}) mengarahkan kembali dengan token di fragmen URL (#...),
 * yang tidak terlihat oleh server. Halaman kecil ini membaca fragmen di browser lalu meneruskannya.
 */
function fragmentPage() {
  const html = `<!DOCTYPE html><html lang="id"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex"><title>Memproses…</title><link rel="icon" href="/icon.svg" type="image/svg+xml"></head><body style="font-family:system-ui,sans-serif;text-align:center;padding:15vh 16px">
<p id="m">Memproses tautan…</p><script src="/js/confirm.js?v=${ASSET_V}" defer></script></body></html>`;
  return new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer', 'content-security-policy': pageCsp() } });
}

/** Menerima token sesi pemulihan dari fragmen (alur template bawaan) dan menyimpannya sebagai cookie httpOnly. */
export async function POST(req: Request) {
  const origin = req.headers.get('origin') || '';
  let okOrigin = false;
  try { okOrigin = new URL(origin).host === new URL(ENV.appUrl).host || new URL(origin).host === req.headers.get('host'); } catch { /* tolak */ }
  if (!okOrigin || req.headers.get('x-requested-with') !== 'smartsign') return Response.json({ ok: false }, { status: 403 });
  const b = await req.json().catch(() => ({}));
  const access = String(b.access_token || ''), refresh = String(b.refresh_token || '');
  if (!access || !refresh || access.length > 4000 || refresh.length > 200) return Response.json({ ok: false }, { status: 400 });
  const sb = await authClient();
  const { error } = await sb.auth.setSession({ access_token: access, refresh_token: refresh }); // memvalidasi token ke Supabase Auth
  if (error) return Response.json({ ok: false }, { status: 400 });
  return Response.json({ ok: true }, { headers: { 'cache-control': 'no-store' } });
}
