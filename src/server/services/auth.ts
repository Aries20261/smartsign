import { db } from '../db';
import { APP, ENV, ROLES } from '../config';
import { AppError, vErr } from '../errors';
import { authClient, adminClient, statelessClient } from '../supabase';
import { audit, securityEvent } from '../audit';
import { rateBump, rateCount, rateLimit, rateReset } from '../ratelimit';
import { sendMail } from '../mail';
import { currentClaims, ensureWorkspace, me, platformSettings, reqInfo, requireReauth, requireSession, type Ctx, type ReqInfo } from '../session';
import { isEmail, isPast, maskEmail, normEmail, parseUa, randomSlug, sha256Hex, str } from '../util';

const COMMON = ['password', 'password123', '1234567890', 'qwertyuiop', 'iloveyou', 'admin12345', 'bismillah', 'indonesia', 'sayang', 'rahasia', '12345678910', 'qwerty123'];

export function validatePassword(pw: unknown, email: string, field = 'password') {
  const s = String(pw || '');
  if (s.length < APP.PASSWORD_MIN) throw vErr(field, 'Password minimal ' + APP.PASSWORD_MIN + ' karakter.');
  if (s.length > 128) throw vErr(field, 'Password maksimal 128 karakter.');
  if (!/[A-Za-z]/.test(s) || !/\d/.test(s)) throw vErr(field, 'Gunakan kombinasi huruf dan angka.');
  const low = s.toLowerCase();
  if (COMMON.some((c) => low.includes(c))) throw vErr(field, 'Password terlalu umum. Pilih yang lebih unik.');
  const local = String(email || '').split('@')[0].toLowerCase();
  if (local.length >= 3 && low.includes(local)) throw vErr(field, 'Password tidak boleh memuat nama email Anda.');
}

function authErrorMessage(msg: string): string {
  if (/weak|pwned|leaked/i.test(msg)) return 'Password terlalu lemah atau pernah bocor. Pilih password lain.';
  if (/same.*password|different from the old/i.test(msg)) return 'Password baru harus berbeda dari yang lama.';
  return 'Permintaan tidak dapat diproses. Coba lagi.';
}

async function loginFail(email: string, info: ReqInfo) {
  const n = await rateBump('lf:' + email, APP.LOGIN_LOCK_SEC);
  await rateBump('lf:ip:' + info.ipHash, APP.LOGIN_LOCK_SEC);
  await rateBump('lf:all', 300);
  if (n === APP.LOGIN_MAX_FAIL) await securityEvent('akun_dikunci_sementara', 'sedang', null, maskEmail(email), { percobaan: n });
  else await securityEvent('login_gagal', 'rendah', null, maskEmail(email), { ip: info.ipHash });
  throw new AppError('VALIDATION', 'Email atau password salah.', { password: 'Email atau password salah.' });
}

/* ---------- Login & MFA ---------- */
export async function login(p: any) {
  const info = await reqInfo();
  const email = normEmail(p.email);
  const pw = String(p.password || '');
  if (!email || !pw) throw new AppError('VALIDATION', 'Email dan password wajib diisi.', { ...(email ? {} : { email: 'Wajib diisi.' }), ...(pw ? {} : { password: 'Wajib diisi.' }) });
  if ((await rateCount('lf:' + email, APP.LOGIN_LOCK_SEC)) >= APP.LOGIN_MAX_FAIL) throw new AppError('BUSY', 'Terlalu banyak percobaan masuk. Coba lagi dalam 15 menit atau atur ulang password.');
  if ((await rateCount('lf:ip:' + info.ipHash, APP.LOGIN_LOCK_SEC)) >= 30) throw new AppError('BUSY', 'Terlalu banyak percobaan dari jaringan ini. Coba lagi nanti.');
  if ((await rateCount('lf:all', 300)) > 500) throw new AppError('BUSY', 'Layanan masuk dibatasi sementara karena aktivitas tidak wajar. Coba lagi nanti.');
  const sb = await authClient();
  const { data, error } = await sb.auth.signInWithPassword({ email, password: pw });
  if (error || !data.user) {
    if (error && /not confirmed/i.test(error.message)) throw new AppError('FORBIDDEN', 'Email belum diverifikasi. Periksa kotak masuk Anda atau kirim ulang email verifikasi.');
    return loginFail(email, info);
  }
  const [prof] = await db()`select status, nama from profiles where id = ${data.user.id}`;
  if (prof && prof.status !== 'aktif') {
    await sb.auth.signOut({ scope: 'local' });
    throw new AppError('FORBIDDEN', 'Akun dinonaktifkan. Hubungi admin ruang kerja Anda.');
  }
  await rateReset('lf:' + email);
  await db()`update profiles set last_login_at = now() where id = ${data.user.id}`;
  await ensureWorkspace(data.user.id, prof?.nama || email.split('@')[0]);
  const verified = (data.user.factors || []).filter((f) => f.status === 'verified');
  await audit({ userId: data.user.id, email, ipHash: info.ipHash }, 'auth.login', 'Session', '', null, { perangkat: describeUa(info.ua), mfa: verified.length > 0 }, 'ui');
  if (verified.length) return { mfaRequired: true, ticket: 'session' };
  const u = await requireSession(sb, info);
  return { token: 'cookie', me: me(u) };
}

function describeUa(ua: string) { const i = parseUa(ua); return i.device === 'bot' ? 'otomatis' : i.browser + ' · ' + i.os + ' (' + i.device + ')'; }

async function totpFactor(sb: Awaited<ReturnType<typeof authClient>>, status: 'verified' | 'unverified') {
  const { data } = await sb.auth.mfa.listFactors();
  return (data?.all || []).filter((f) => f.factor_type === 'totp' && f.status === status);
}

/** Verifikasi TOTP dengan pencegahan pemakaian ulang kode yang sama. */
async function verifyTotp(u: { userId: string; sb: any }, code: string): Promise<boolean> {
  if (!/^\d{6}$/.test(code)) return false;
  const [f] = await totpFactor(u.sb, 'verified');
  if (!f) return false;
  const used = 'totp:' + u.userId + ':' + sha256Hex(code);
  if ((await rateCount(used, 120)) > 0) return false;
  const { error } = await u.sb.auth.mfa.challengeAndVerify({ factorId: f.id, code });
  if (error) return false;
  await rateBump(used, 120);
  return true;
}

export async function loginMfa(p: any) {
  const info = await reqInfo();
  const sb = await authClient();
  const claims = await currentClaims(sb);
  if (!claims) throw new AppError('UNAUTHORIZED', 'Sesi verifikasi berakhir. Silakan masuk ulang.');
  const userId = claims.sub;
  const email = String(claims.email || '');
  await rateLimit('mfa:' + userId, APP.OTP_MAX_ATTEMPTS, 300, 'Terlalu banyak percobaan. Silakan masuk ulang dalam 5 menit.');
  const code = str(p.code, 20).toUpperCase().replace(/\s/g, '');
  if (/^\d{6}$/.test(code)) {
    if (!(await verifyTotp({ userId, sb }, code))) {
      await securityEvent('mfa_gagal', 'rendah', { userId }, maskEmail(email));
      throw new AppError('VALIDATION', 'Kode tidak valid.', { code: 'Kode salah atau sudah dipakai.' });
    }
    await audit({ userId, email, ipHash: info.ipHash }, 'auth.mfaVerified', 'Session', '', null, { metode: 'totp' });
  } else if (/^[A-Z0-9]{4}-?[A-Z0-9]{4}$/.test(code)) {
    const h = sha256Hex(code.replace('-', ''));
    const [rc] = await db()`update recovery_codes set used_at = now() where user_id = ${userId} and code_hash = ${h} and used_at is null returning id`;
    if (!rc) throw new AppError('VALIDATION', 'Kode tidak valid.', { code: 'Kode pemulihan salah atau sudah dipakai.' });
    // Kode pemulihan = autentikator hilang: hapus faktor TOTP agar pengguna dapat masuk lalu mendaftarkan ulang.
    const factors = await totpFactor(sb, 'verified');
    for (const f of factors) await adminClient().auth.admin.mfa.deleteFactor({ id: f.id, userId });
    await db()`delete from recovery_codes where user_id = ${userId}`;
    await securityEvent('kode_pemulihan_dipakai', 'sedang', { userId }, maskEmail(email), { mfaDireset: true });
    await sendMail(email, 'Kode pemulihan dipakai', 'Kode pemulihan dipakai untuk masuk',
      ['Akun Anda baru saja masuk memakai kode pemulihan. Autentikator lama dinonaktifkan, silakan aktifkan MFA lagi di menu Keamanan Akun.', 'Jika ini bukan Anda, segera atur ulang password.']).catch(() => {});
    await sb.auth.refreshSession();
  } else throw new AppError('VALIDATION', 'Kode tidak valid.', { code: 'Masukkan 6 digit kode atau kode pemulihan.' });
  await rateReset('mfa:' + userId);
  const u = await requireSession(await authClient(), info);
  return { token: 'cookie', me: me(u) };
}

export async function getMe(_p: any, u: Ctx) { return { me: me(u) }; }

export async function logout(_p: any, u: Ctx) {
  await audit(u, 'auth.logout', 'Session', u.sessionId, null, null);
  await db()`delete from reauth where session_id = ${u.sessionId}`;
  await u.sb.auth.signOut({ scope: 'local' });
  return { ok: true };
}

export async function reauth(p: any, u: Ctx) {
  await rateLimit('reauth:' + u.userId, 8, 900, 'Terlalu banyak percobaan konfirmasi. Coba lagi nanti.');
  const tmp = statelessClient();
  const { data, error } = await tmp.auth.signInWithPassword({ email: u.email, password: String(p.password || '') });
  if (error || !data.session) {
    await securityEvent('reauth_gagal', 'rendah', u, maskEmail(u.email));
    throw new AppError('VALIDATION', 'Konfirmasi gagal.', { password: 'Password salah.' });
  }
  await tmp.auth.signOut({ scope: 'local' }); // tutup sesi sementara yang baru dibuat
  if (u.mfaEnabled && !(await verifyTotp(u, str(p.code, 10)))) throw new AppError('VALIDATION', 'Konfirmasi gagal.', { code: 'Kode autentikator salah.' });
  await db()`insert into reauth (session_id, user_id, at) values (${u.sessionId}, ${u.userId}, now()) on conflict (session_id) do update set at = now()`;
  return { ok: true, validSec: APP.REAUTH_WINDOW_SEC };
}

/* ---------- Sesi ---------- */
export async function listSessions(_p: any, u: Ctx) {
  const rows = await db()`select * from list_user_sessions(${u.userId})`;
  return rows.map((r) => ({ id: r.id, device: r.userAgent ? describeUa(r.userAgent) : 'Perangkat tidak dikenal', createdAt: r.createdAt, lastSeenAt: r.updatedAt, current: r.id === u.sessionId }));
}
export async function revokeSession(p: any, u: Ctx) {
  const id = str(p.id, 40);
  if (!/^[0-9a-f-]{36}$/.test(id) || id === u.sessionId) throw new AppError('NOT_FOUND', 'Sesi tidak ditemukan.');
  const [r] = await db()`select revoke_user_sessions(${u.userId}, ${id}, null) as n`;
  if (!r.n) throw new AppError('NOT_FOUND', 'Sesi tidak ditemukan.');
  await audit(u, 'auth.revokeSession', 'Session', id, null, null);
  return { ok: true };
}
export async function revokeOthers(_p: any, u: Ctx) {
  const [r] = await db()`select revoke_user_sessions(${u.userId}, null, ${u.sessionId || null}) as n`;
  await audit(u, 'auth.revokeAllSessions', 'User', u.userId, null, { jumlah: r.n });
  return { revoked: r.n };
}
export async function switchWorkspace(p: any, u: Ctx) {
  const wsId = str(p.workspaceId, 40);
  if (!u.workspaces.some((w) => w.workspaceId === wsId)) throw new AppError('FORBIDDEN', 'Anda bukan anggota ruang kerja tersebut.');
  await db()`update profiles set last_workspace_id = ${wsId} where id = ${u.userId}`;
  return { me: me(await requireSession(u.sb, u)) };
}

/* ---------- Registrasi, verifikasi email, reset password ---------- */
export async function register(p: any) {
  const info = await reqInfo();
  const generic = { message: 'Pendaftaran diterima. Periksa email Anda untuk tautan verifikasi (berlaku 1 jam).' };
  if (p.website) return generic; // honeypot bot
  const plat = await platformSettings();
  if (!plat.allowRegistration) throw new AppError('FORBIDDEN', 'Pendaftaran mandiri sedang ditutup. Minta undangan dari admin ruang kerja.');
  const email = normEmail(p.email), nama = str(p.nama, 80);
  if (nama.length < 2) throw vErr('nama', 'Nama minimal 2 karakter.');
  if (!isEmail(email)) throw vErr('email', 'Format email tidak valid.');
  validatePassword(p.password, email);
  await rateLimit('reg:ip:' + info.ipHash, 10, 3600, 'Terlalu banyak pendaftaran dari jaringan ini. Coba lagi nanti.');
  await rateLimit('reg:' + email, 3, 3600, 'Terlalu sering. Coba lagi nanti.');
  const { error } = await statelessClient().auth.signUp({ email, password: String(p.password), options: { data: { nama }, emailRedirectTo: ENV.appUrl + '/auth/confirm' } });
  if (error) {
    if (/password/i.test(error.message)) throw vErr('password', authErrorMessage(error.message));
    console.warn(JSON.stringify({ register: 'error', msg: error.message }));
  }
  await securityEvent('registrasi', 'info', null, maskEmail(email));
  return generic;
}
export async function resendVerify(p: any) {
  const email = normEmail(p.email);
  if (!isEmail(email)) throw vErr('email', 'Format email tidak valid.');
  await rateLimit('rv:' + email, 3, 3600, 'Terlalu sering. Coba lagi nanti.');
  await statelessClient().auth.resend({ type: 'signup', email, options: { emailRedirectTo: ENV.appUrl + '/auth/confirm' } });
  return { message: 'Jika akun belum terverifikasi, email verifikasi baru telah dikirim.' };
}
export async function forgotPassword(p: any) {
  const email = normEmail(p.email);
  if (!isEmail(email)) throw vErr('email', 'Format email tidak valid.');
  await rateLimit('fp:' + email, 3, 3600, 'Permintaan reset terlalu sering. Coba lagi nanti.');
  const { error } = await statelessClient().auth.resetPasswordForEmail(email, { redirectTo: ENV.appUrl + '/auth/confirm' });
  if (error) console.warn(JSON.stringify({ forgot: 'error', msg: error.message }));
  await securityEvent('permintaan_reset_password', 'info', null, maskEmail(email));
  return { message: 'Jika email terdaftar, tautan untuk mengatur ulang password telah dikirim. Tautan berlaku 1 jam.' };
}
/** Dipanggil dari halaman /reset setelah tautan email memberi sesi pemulihan. */
export async function resetPassword(p: any) {
  const info = await reqInfo();
  const sb = await authClient();
  const claims = await currentClaims(sb);
  // Hanya sesi yang dibuat dari tautan pemulihan (bukan sesi login biasa) dalam 1 jam terakhir.
  const amr = Array.isArray((claims as any)?.amr) ? (claims as any).amr : [];
  const fromRecovery = amr.some((m: any) => ['recovery', 'otp', 'magiclink'].includes(m?.method) && Date.now() / 1000 - Number(m?.timestamp || 0) < 3600);
  if (!claims || !fromRecovery) throw new AppError('VALIDATION', 'Tautan reset tidak valid atau sudah kedaluwarsa. Minta tautan baru.');
  const email = String(claims.email || '');
  validatePassword(p.password, email);
  const { error } = await sb.auth.updateUser({ password: String(p.password) });
  if (error) throw vErr('password', authErrorMessage(error.message));
  await db()`update profiles set must_change_password = false where id = ${claims.sub}`;
  await db()`select revoke_user_sessions(${claims.sub}, null, null)`;
  await sb.auth.signOut({ scope: 'local' }).catch(() => {});
  await rateReset('lf:' + email);
  await audit({ userId: claims.sub, email, ipHash: info.ipHash }, 'auth.resetPassword', 'User', claims.sub, null, { semuaSesiDicabut: true }, 'publik');
  await securityEvent('password_direset', 'info', { userId: claims.sub }, maskEmail(email));
  return { message: 'Password berhasil diatur ulang. Silakan masuk dengan password baru.' };
}
export async function changePassword(p: any, u: Ctx) {
  const tmp = statelessClient();
  const { data, error } = await tmp.auth.signInWithPassword({ email: u.email, password: String(p.oldPassword || '') });
  if (error || !data.session) throw new AppError('VALIDATION', 'Periksa kembali isian Anda.', { oldPassword: 'Password lama salah.' });
  await tmp.auth.signOut({ scope: 'local' });
  validatePassword(p.newPassword, u.email, 'newPassword');
  if (String(p.newPassword) === String(p.oldPassword)) throw vErr('newPassword', 'Password baru harus berbeda.');
  const r = await u.sb.auth.updateUser({ password: String(p.newPassword) });
  if (r.error) throw vErr('newPassword', authErrorMessage(r.error.message));
  await db()`update profiles set must_change_password = false where id = ${u.userId}`;
  const [rv] = await db()`select revoke_user_sessions(${u.userId}, null, ${u.sessionId || null}) as n`;
  await audit(u, 'auth.changePassword', 'User', u.userId, null, { sesiLainDicabut: rv.n });
  await securityEvent('password_diubah', 'info', u, maskEmail(u.email));
  await sendMail(u.email, 'Password Anda telah diubah', 'Password diubah',
    ['Password akun ' + APP.NAME + ' Anda baru saja diubah. Semua sesi lain telah dikeluarkan.', 'Jika ini bukan Anda, segera atur ulang password dan hubungi admin.']).catch(() => {});
  return { ok: true, revoked: rv.n };
}
export async function updateProfile(p: any, u: Ctx) {
  const nama = str(p.nama, 80);
  if (nama.length < 2) throw vErr('nama', 'Nama minimal 2 karakter.');
  await db()`update profiles set nama = ${nama} where id = ${u.userId}`;
  await adminClient().auth.admin.updateUserById(u.userId, { user_metadata: { nama } });
  await audit(u, 'user.updateProfile', 'User', u.userId, { nama: u.nama }, { nama });
  return { me: me({ ...u, nama }) };
}

/* ---------- MFA (TOTP Supabase Auth) ---------- */
function newRecoveryCodes() {
  const plain: string[] = [];
  for (let i = 0; i < 10; i++) {
    const c = randomSlug(8).toUpperCase().replace(/[^A-Z0-9]/g, 'X');
    plain.push(c.slice(0, 4) + '-' + c.slice(4));
  }
  return plain;
}
async function storeRecoveryCodes(userId: string, plain: string[]) {
  await db().begin(async (t) => {
    await t`delete from recovery_codes where user_id = ${userId}`;
    for (const c of plain) await t`insert into recovery_codes (user_id, code_hash) values (${userId}, ${sha256Hex(c.replace('-', ''))})`;
  });
}
export async function mfaStart(_p: any, u: Ctx) {
  if (u.mfaEnabled) throw new AppError('CONFLICT', 'MFA sudah aktif.');
  for (const f of await totpFactor(u.sb, 'unverified')) await u.sb.auth.mfa.unenroll({ factorId: f.id });
  const { data, error } = await u.sb.auth.mfa.enroll({ factorType: 'totp', issuer: APP.NAME, friendlyName: 'Autentikator ' + new Date().toISOString().slice(0, 10) });
  if (error || !data) throw new AppError('SERVER_ERROR', 'Gagal memulai aktivasi MFA. Coba lagi.');
  return { secret: data.totp.secret, otpauth: data.totp.uri };
}
export async function mfaConfirm(p: any, u: Ctx) {
  const [f] = await totpFactor(u.sb, 'unverified');
  if (!f) throw new AppError('VALIDATION', 'Proses aktivasi berakhir. Mulai ulang aktivasi MFA.');
  const code = str(p.code, 10);
  const { error } = await u.sb.auth.mfa.challengeAndVerify({ factorId: f.id, code });
  if (error) throw new AppError('VALIDATION', 'Kode tidak valid.', { code: 'Kode salah. Pastikan jam ponsel Anda akurat.' });
  await rateBump('totp:' + u.userId + ':' + sha256Hex(code), 120);
  const plain = newRecoveryCodes();
  await storeRecoveryCodes(u.userId, plain);
  await audit(u, 'auth.mfaEnabled', 'User', u.userId, null, { mfa: true });
  await securityEvent('mfa_diaktifkan', 'info', u, maskEmail(u.email));
  const fresh = await requireSession(await authClient(), u);
  return { recoveryCodes: plain, me: me(fresh) };
}
export async function mfaDisable(_p: any, u: Ctx) {
  await requireReauth(u);
  if (u.role === 'admin' && u.settings.requireMfaAdmin) throw new AppError('FORBIDDEN', 'Kebijakan ruang kerja mewajibkan admin memakai MFA.');
  for (const f of await totpFactor(u.sb, 'verified')) await adminClient().auth.admin.mfa.deleteFactor({ id: f.id, userId: u.userId });
  await db()`delete from recovery_codes where user_id = ${u.userId}`;
  await audit(u, 'auth.mfaDisabled', 'User', u.userId, { mfa: true }, { mfa: false });
  await securityEvent('mfa_dinonaktifkan', 'sedang', u, maskEmail(u.email));
  await sendMail(u.email, 'MFA dinonaktifkan', 'MFA dinonaktifkan', ['Autentikasi dua langkah pada akun Anda baru saja dinonaktifkan. Jika ini bukan Anda, segera ganti password.']).catch(() => {});
  await u.sb.auth.refreshSession();
  return { me: me({ ...u, mfaEnabled: false }) };
}
export async function mfaRegen(_p: any, u: Ctx) {
  await requireReauth(u);
  if (!u.mfaEnabled) throw new AppError('CONFLICT', 'MFA belum aktif.');
  const plain = newRecoveryCodes();
  await storeRecoveryCodes(u.userId, plain);
  await audit(u, 'auth.recoveryCodesRegenerated', 'User', u.userId, null, null);
  return { recoveryCodes: plain };
}
export async function securityMine(p: any, u: Ctx) {
  const rows = await db()`select id, at, event_type, severity, subject, metadata from security_events where user_id = ${u.userId} order by at desc limit 30`;
  const [rc] = await db()`select count(*)::int as n from recovery_codes where user_id = ${u.userId} and used_at is null`;
  return { rows: rows.map((e) => ({ id: e.id, waktu: e.at, eventType: e.eventType, severity: e.severity, subject: e.subject, metadata: e.metadata })), recoveryLeft: rc.n };
}

/* ---------- Undangan anggota ---------- */
async function inviteByToken(token: unknown) {
  const t = String(token || '');
  const bad = new AppError('VALIDATION', 'Undangan tidak valid, sudah dipakai, atau kedaluwarsa.');
  if (!/^[a-f0-9]{64}$/.test(t)) throw bad;
  const [inv] = await db()`select i.*, w.nama as ws_nama from invitations i join workspaces w on w.id = i.workspace_id where i.token_hash = ${sha256Hex(t)}`;
  if (!inv || inv.status !== 'aktif' || isPast(inv.expiresAt)) throw bad;
  return inv;
}
export async function invitePeek(p: any) {
  const inv = await inviteByToken(p.token);
  const [ex] = await db()`select 1 from profiles where email = ${inv.email}`;
  return { email: maskEmail(inv.email), workspace: inv.wsNama, role: ROLES[inv.role] || inv.role, accountExists: !!ex };
}
async function acceptInto(inv: any, userId: string) {
  await db().begin(async (t) => {
    await t`insert into memberships (workspace_id, user_id, role, created_by) values (${inv.workspaceId}, ${userId}, ${inv.role}, ${inv.createdBy})
      on conflict (workspace_id, user_id) do update set status = 'aktif', role = excluded.role`;
    await t`update invitations set status = 'dipakai', used_at = now() where id = ${inv.id}`;
    await t`update profiles set last_workspace_id = ${inv.workspaceId} where id = ${userId}`;
  });
}
export async function inviteAcceptNew(p: any) {
  const info = await reqInfo();
  const inv = await inviteByToken(p.token);
  const nama = str(p.nama, 80);
  if (nama.length < 2) throw vErr('nama', 'Nama minimal 2 karakter.');
  validatePassword(p.password, inv.email);
  const [ex] = await db()`select 1 from profiles where email = ${inv.email}`;
  if (ex) throw new AppError('CONFLICT', 'Email ini sudah memiliki akun. Silakan masuk lalu terima undangan.');
  // undangan lewat email membuktikan kepemilikan alamat, sehingga email langsung terverifikasi
  const { data, error } = await adminClient().auth.admin.createUser({ email: inv.email, password: String(p.password), email_confirm: true, user_metadata: { nama } });
  if (error || !data.user) throw vErr('password', authErrorMessage(error?.message || ''));
  await acceptInto(inv, data.user.id);
  await audit({ userId: data.user.id, email: inv.email, workspaceId: inv.workspaceId, ipHash: info.ipHash }, 'member.inviteAccepted', 'User', data.user.id, null, { role: inv.role }, 'publik');
  const sb = await authClient();
  await sb.auth.signInWithPassword({ email: inv.email, password: String(p.password) });
  return { token: 'cookie', me: me(await requireSession(sb, info)) };
}
export async function inviteAccept(p: any, u: Ctx) {
  const inv = await inviteByToken(p.token);
  if (inv.email !== u.email) throw new AppError('FORBIDDEN', 'Undangan ini ditujukan untuk email lain.');
  await acceptInto(inv, u.userId);
  await audit({ ...u, workspaceId: inv.workspaceId }, 'member.inviteAccepted', 'User', u.userId, null, { role: inv.role });
  return { me: me(await requireSession(u.sb, u)) };
}


