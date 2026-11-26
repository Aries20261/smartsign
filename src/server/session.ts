import type { SupabaseClient } from '@supabase/supabase-js';
import { headers } from 'next/headers';
import { db, type Q } from './db';
import { APP, DEFAULT_PLATFORM, DEFAULT_WS_SETTINGS, ENV, PLAN_LIMITS, ROLES, type PlatformSettings, type WsSettings } from './config';
import { AppError } from './errors';
import { hmacHex, ms, str, todayWib } from './util';

export type ReqInfo = { ip: string; ipHash: string; ua: string; country: string; origin: string };
export type Ctx = ReqInfo & {
  sb: SupabaseClient;
  userId: string;
  email: string;
  nama: string;
  workspaceId: string;
  workspaceName: string;
  plan: string;
  planExpiresAt: string | null;
  esignEnabled: boolean;
  settings: WsSettings;
  role: string;
  platformRole: 'user' | 'superadmin';
  mfaEnabled: boolean;
  mfaSetupRequired: boolean;
  mustChangePassword: boolean;
  sessionId: string;
  aal: string;
  workspaces: { workspaceId: string; nama: string; role: string }[];
};

export async function reqInfo(): Promise<ReqInfo> {
  const h = await headers();
  const ip = str((h.get('x-forwarded-for') || '').split(',')[0] || h.get('x-real-ip') || '', 64);
  return {
    ip,
    ipHash: ip ? hmacHex(ENV.appSecret || 'smartsign', 'ip:' + todayWib() + ':' + ip).slice(0, 32) : '',
    ua: str(h.get('user-agent'), 300),
    country: str(h.get('x-vercel-ip-country'), 2).toUpperCase(),
    origin: str(h.get('origin'), 200)
  };
}

export function wsSettings(raw: unknown): WsSettings {
  return Object.assign({}, DEFAULT_WS_SETTINGS, raw && typeof raw === 'object' ? raw : {});
}

let platformMemo: { at: number; v: PlatformSettings } | null = null;
export async function platformSettings(fresh = false): Promise<PlatformSettings> {
  if (!fresh && platformMemo && Date.now() - platformMemo.at < 30000) return platformMemo.v;
  const [r] = await db()`select settings from platform_settings where id = 1`;
  const v = Object.assign({}, DEFAULT_PLATFORM, r?.settings || {});
  platformMemo = { at: Date.now(), v };
  return v;
}
export function invalidatePlatformMemo() { platformMemo = null; }

/** Ruang kerja pribadi dibuat otomatis untuk pengguna yang belum tergabung di mana pun (setelah registrasi). */
export async function ensureWorkspace(userId: string, nama: string, q: Q = db()) {
  const [m] = await q`select 1 from memberships where user_id = ${userId} limit 1`;
  if (m) return;
  await q.begin(async (t) => {
    const [again] = await t`select 1 from memberships where user_id = ${userId} limit 1 for update`;
    if (again) return;
    const [ws] = await t`insert into workspaces (nama, owner_id) values (${('Ruang kerja ' + (nama || 'saya')).slice(0, 80)}, ${userId}) returning id`;
    await t`insert into memberships (workspace_id, user_id, role, created_by) values (${ws.id}, ${userId}, 'admin', ${userId})`;
    await t`update profiles set last_workspace_id = ${ws.id} where id = ${userId}`;
  });
}

type Claims = { sub: string; email?: string; session_id?: string; aal?: string };

/** Membaca klaim JWT sesi saat ini (diverifikasi oleh Supabase). Null bila tidak login. */
export async function currentClaims(sb: SupabaseClient): Promise<Claims | null> {
  const { data, error } = await sb.auth.getClaims();
  if (error || !data?.claims?.sub) return null;
  return data.claims as unknown as Claims;
}

/**
 * Sesi wajib: memvalidasi JWT, status akun, keanggotaan ruang kerja aktif, dan tingkat MFA.
 * opts.allowAal1: izinkan sesi yang belum menyelesaikan MFA (hanya untuk langkah verifikasi MFA).
 */
export async function requireSession(sb: SupabaseClient, info: ReqInfo, opts: { allowAal1?: boolean } = {}): Promise<Ctx> {
  const claims = await currentClaims(sb);
  if (!claims) throw new AppError('UNAUTHORIZED', 'Silakan masuk terlebih dahulu.');
  const userId = claims.sub;
  if (claims.session_id) {
    const [act] = await db()`select public.session_active(${userId}::uuid, ${claims.session_id}::uuid) as ok`;
    if (!act?.ok) throw new AppError('UNAUTHORIZED', 'Sesi Anda telah berakhir atau dicabut. Silakan masuk kembali.');
  }
  // AAL dari JWT yang sudah diverifikasi; status MFA dari database (bukan dari cookie yang bisa basi).
  const aal = String(claims.aal || 'aal1');
  const mfaEnabled = (await db()`select 1 from public.mfa_enabled_users(${[userId]}::uuid[])`).length > 0;
  if (mfaEnabled && aal !== 'aal2' && !opts.allowAal1) throw new AppError('MFA_REQUIRED', 'Masukkan kode autentikator untuk melanjutkan.');

  const sql = db();
  let [p] = await sql`select id, email, nama, platform_role, status, last_workspace_id, must_change_password from profiles where id = ${userId}`;
  if (!p) {
    // profil seharusnya dibuat trigger; buat ulang bila belum ada
    await sql`insert into profiles (id, email, nama) values (${userId}, ${String(claims.email || '').toLowerCase()}, ${String(claims.email || '').split('@')[0]}) on conflict do nothing`;
    [p] = await sql`select id, email, nama, platform_role, status, last_workspace_id, must_change_password from profiles where id = ${userId}`;
  }
  if (p.status !== 'aktif') throw new AppError('UNAUTHORIZED', 'Akun dinonaktifkan. Hubungi admin.');
  if (ENV.superadminEmails.includes(p.email) && p.platformRole !== 'superadmin') {
    await sql`update profiles set platform_role = 'superadmin' where id = ${userId}`;
    p.platformRole = 'superadmin';
  }
  await ensureWorkspace(userId, p.nama);
  const mems = await sql`
    select m.workspace_id, m.role, w.nama, w.settings, w.plan, w.plan_expires_at, w.esign_override, (select platform_role from profiles o where o.id = w.owner_id) as owner_role from memberships m join workspaces w on w.id = m.workspace_id
    where m.user_id = ${userId} and m.status = 'aktif' and w.status = 'aktif' order by m.created_at`;
  if (!mems.length) throw new AppError('FORBIDDEN', 'Akun Anda belum tergabung di ruang kerja aktif.');
  const cur = mems.find((m) => m.workspaceId === p.lastWorkspaceId) || mems[0];
  const settings = wsSettings(cur.settings);
  // Superadmin (atau anggota ruang kerja milik superadmin) tidak terkunci paywall: semua layanan terbuka untuk pengujian.
  const unlocked = p.platformRole === 'superadmin' || cur.ownerRole === 'superadmin';
  const plan = unlocked ? 'lifetime' : effectivePlan(cur.plan, cur.planExpiresAt);
  return {
    ...info,
    sb,
    userId,
    email: p.email,
    nama: p.nama,
    workspaceId: cur.workspaceId,
    workspaceName: cur.nama,
    plan,
    planExpiresAt: plan === 'pro' ? cur.planExpiresAt : null,
    esignEnabled: unlocked ? true : cur.esignOverride == null ? !!PLAN_LIMITS[plan]?.esign : !!cur.esignOverride,
    settings,
    role: cur.role,
    platformRole: p.platformRole === 'superadmin' ? 'superadmin' : 'user',
    mfaEnabled,
    mfaSetupRequired: cur.role === 'admin' && settings.requireMfaAdmin && !mfaEnabled,
    mustChangePassword: !!p.mustChangePassword,
    sessionId: claims.session_id || '',
    aal,
    workspaces: mems.map((m) => ({ workspaceId: m.workspaceId, nama: m.nama, role: m.role }))
  };
}

/** Paket efektif: paket 'pro' yang sudah lewat masa aktifnya dianggap 'free'. */
export function effectivePlan(plan: string, expiresAt: string | null | undefined): string {
  if (plan === 'pro' && (!expiresAt || Date.parse(expiresAt) <= Date.now())) return 'free';
  return PLAN_LIMITS[plan] ? plan : 'free';
}

export function me(u: Ctx) {
  return {
    userId: u.userId, email: u.email, nama: u.nama, role: u.role, roleLabel: ROLES[u.role] || u.role, platformRole: u.platformRole,
    workspaceId: u.workspaceId, workspaceName: u.workspaceName, workspaces: u.workspaces, mfaEnabled: u.mfaEnabled,
    mfaSetupRequired: u.mfaSetupRequired, mustChangePassword: u.mustChangePassword,
    plan: u.plan, planLabel: PLAN_LIMITS[u.plan]?.label || u.plan, planExpiresAt: u.planExpiresAt, esignEnabled: u.esignEnabled
  };
}

/** Aksi sensitif: wajib konfirmasi password (dan kode MFA) dalam 5 menit terakhir pada sesi ini. */
export async function requireReauth(u: Ctx) {
  if (!u.sessionId) throw new AppError('REAUTH_REQUIRED', 'Konfirmasi password diperlukan untuk tindakan ini.');
  const [r] = await db()`select at from reauth where session_id = ${u.sessionId} and user_id = ${u.userId}`;
  if (!r || Date.now() - ms(r.at) > APP.REAUTH_WINDOW_SEC * 1000) throw new AppError('REAUTH_REQUIRED', 'Konfirmasi password diperlukan untuk tindakan ini.');
}

export function authorize(u: Ctx, roles: string[] | '*') {
  if (roles === '*') return;
  if (roles.includes('superadmin') && u.platformRole === 'superadmin') return;
  if (!roles.includes(u.role)) throw new AppError('FORBIDDEN', 'Anda tidak memiliki akses untuk tindakan ini.');
}
