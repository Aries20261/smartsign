import { NextResponse } from 'next/server';
import type { EmailOtpType } from '@supabase/supabase-js';
import { authClient } from '@/server/supabase';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const TYPES: EmailOtpType[] = ['email', 'signup', 'recovery', 'email_change', 'invite', 'magiclink'];

/** Tautan dari email Supabase (verifikasi, reset password, ganti email). */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const tokenHash = url.searchParams.get('token_hash') || '';
  const type = url.searchParams.get('type') as EmailOtpType;
  const back = (path: string) => NextResponse.redirect(new URL(path, url.origin), { status: 303, headers: { 'cache-control': 'no-store' } });
  if (!tokenHash || !TYPES.includes(type)) return back('/?notice=' + encodeURIComponent('Tautan tidak valid.'));
  const sb = await authClient();
  const { error } = await sb.auth.verifyOtp({ token_hash: tokenHash, type });
  if (error) return back('/?notice=' + encodeURIComponent('Tautan tidak valid atau sudah kedaluwarsa. Silakan minta tautan baru.'));
  if (type === 'recovery') return back('/reset');
  if (type === 'email_change') return back('/?notice=' + encodeURIComponent('Alamat email berhasil diperbarui.'));
  await sb.auth.signOut({ scope: 'local' });
  return back('/?notice=' + encodeURIComponent('Email terverifikasi. Silakan masuk.'));
}
