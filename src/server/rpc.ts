import { ENV } from './config';
import { resetDb } from './db';
import { AppError } from './errors';
import { rateBump } from './ratelimit';
import { authorize, reqInfo, requireSession } from './session';
import { authClient } from './supabase';
import { ROUTES } from './routes';

export type Envelope = { ok: true; data: unknown } | { ok: false; code: string; message: string; fields?: Record<string, string> };

function sameOrigin(origin: string, host: string | null): boolean {
  if (!origin) return false;
  try {
    const o = new URL(origin);
    const allowed = [ENV.appUrl, ENV.shortDomain].filter(Boolean).map((u) => new URL(u).host);
    return allowed.includes(o.host) || (!!host && o.host === host);
  } catch { return false; }
}

const DEADLINE_MS = 25_000;
/** Pengaman: bila satu aksi macet (mis. koneksi database menggantung), jawab dengan error yang jelas dan buang pool koneksi. */
export async function handleRpc(req: Request): Promise<Response> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<Response>((resolve) => {
    timer = setTimeout(() => {
      console.error(JSON.stringify({ rpc: 'deadline', ms: DEADLINE_MS, path: new URL(req.url).pathname }));
      resetDb();
      resolve(new Response(JSON.stringify({ ok: false, code: 'BUSY', message: 'Server sedang sibuk atau koneksi database terputus. Silakan coba lagi.' }),
        { status: 503, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } }));
    }, DEADLINE_MS);
  });
  try { return await Promise.race([handleRpcInner(req), deadline]); } finally { clearTimeout(timer); }
}

/** Gerbang tunggal API: CSRF, rate limit, sesi, otorisasi peran, dan amplop error yang aman. */
async function handleRpcInner(req: Request): Promise<Response> {
  const started = Date.now();
  let action = '';
  const json = (body: Envelope, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });
  try {
    const origin = req.headers.get('origin') || '';
    if (req.headers.get('x-requested-with') !== 'smartsign' || !sameOrigin(origin, req.headers.get('host')))
      throw new AppError('FORBIDDEN', 'Permintaan ditolak (asal tidak sah).');
    const len = Number(req.headers.get('content-length') || 0);
    if (len > 1_000_000) throw new AppError('VALIDATION', 'Permintaan terlalu besar.');
    const body = await req.json().catch(() => null);
    action = String(body?.action || '');
    const route = Object.prototype.hasOwnProperty.call(ROUTES, action) ? ROUTES[action] : null;
    if (!route) throw new AppError('NOT_FOUND', 'Aksi tidak dikenal.');
    const payload = body?.payload && typeof body.payload === 'object' ? body.payload : {};
    const info = await reqInfo();
    if (route.roles === null) {
      const n = await rateBump('pub:' + action + ':' + (info.ipHash || 'x'), 300);
      if (n > (route.limit || 120)) throw new AppError('RATE_LIMIT', 'Terlalu banyak permintaan. Coba lagi beberapa menit lagi.');
      return json({ ok: true, data: await route.fn(payload, null, info) });
    }
    const sb = await authClient();
    const u = await requireSession(sb, info);
    if (u.mustChangePassword && !['auth.me', 'auth.logout', 'auth.changePassword', 'auth.reauth'].includes(action))
      throw new AppError('PASSWORD_CHANGE_REQUIRED', 'Anda harus mengganti password sementara terlebih dahulu.');
    if (u.mfaSetupRequired && !route.mfaSetupOk) throw new AppError('MFA_REQUIRED', 'Kebijakan ruang kerja mewajibkan admin mengaktifkan MFA terlebih dahulu.');
    authorize(u, route.roles);
    return json({ ok: true, data: await route.fn(payload, u, info) });
  } catch (err: any) {
    if (err instanceof AppError) {
      const status = err.code === 'UNAUTHORIZED' ? 401 : err.code === 'FORBIDDEN' ? 403 : err.code === 'RATE_LIMIT' ? 429 : err.code === 'PAYMENT_REQUIRED' ? 402 : 200;
      return json({ ok: false, code: err.code, message: err.message, ...(err.fields ? { fields: err.fields } : {}) }, status);
    }
    console.error(JSON.stringify({ rpc: action, ms: Date.now() - started, msg: err?.message, stack: String(err?.stack || '').split('\n').slice(0, 6).join(' | ') }));
    // Tabel/kolom/fungsi belum ada = migrasi database terbaru belum dijalankan; beri petunjuk yang bisa ditindaklanjuti.
    const pgCode = String(err?.code || '');
    if (/^[0-9A-Z]{5}$/.test(pgCode) || /CONNECTION|ECONN|timeout/i.test(String(err?.message || '') + pgCode)) resetDb(); // koneksi mungkin rusak setelah error
    if (pgCode === '42P01' || pgCode === '42703' || pgCode === '42883')
      return json({ ok: false, code: 'SERVER_ERROR', message: 'Database belum diperbarui. Admin perlu menjalankan file migrasi terbaru di Supabase SQL Editor (cek /api/health).' }, 500);
    return json({ ok: false, code: 'SERVER_ERROR', message: 'Terjadi kesalahan di server. Silakan coba lagi.' }, 500);
  }
}
