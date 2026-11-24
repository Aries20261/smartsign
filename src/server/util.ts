import crypto from 'node:crypto';
import { APP } from './config';
import { AppError, vErr } from './errors';

export const str = (v: unknown, max = 500): string => String(v == null ? '' : v).trim().slice(0, max);
export function int(v: unknown, def: number, min: number, max: number): number {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : def;
}
export const bool = (v: unknown): boolean => v === true || v === 'true' || v === 1 || v === '1' || v === 'on';
export const normEmail = (v: unknown): string => str(v, 160).toLowerCase();
export const isEmail = (s: string): boolean => /^[^\s@<>()[\]\\,;:"]{1,64}@[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}$/i.test(s) && s.length <= 160;
export function maskEmail(e: string): string {
  const [a, b] = String(e || '').split('@');
  if (!b) return '***';
  return a.slice(0, 2) + '***@' + b;
}
export function sha256Hex(data: string | Uint8Array | Buffer): string {
  return crypto.createHash('sha256').update(data).digest('hex');
}
export function hmacHex(key: string, data: string): string { return crypto.createHmac('sha256', key).update(data).digest('hex'); }
export const randomHex = (bytes: number): string => crypto.randomBytes(bytes).toString('hex');
export const randomToken = (): string => randomHex(32); // 64 hex
export function randomDigits(n: number): string {
  let s = '';
  for (let i = 0; i < n; i++) s += crypto.randomInt(0, 10);
  return s;
}
const SLUG_ALPHA = 'abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export function randomSlug(n: number): string {
  let s = '';
  for (let i = 0; i < n; i++) s += SLUG_ALPHA[crypto.randomInt(0, SLUG_ALPHA.length)];
  return s;
}
export function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  if (x.length !== y.length) { crypto.timingSafeEqual(x, x); return false; }
  return crypto.timingSafeEqual(x, y);
}
/** Hash password tautan (bukan password akun; akun memakai Supabase Auth/bcrypt). scrypt N=16384. */
export function hashSecret(pw: string): string {
  const salt = crypto.randomBytes(16);
  const dk = crypto.scryptSync(pw, salt, 32, { N: 16384, r: 8, p: 1 });
  return 'scrypt$' + salt.toString('base64') + '$' + dk.toString('base64');
}
export function verifySecret(pw: string, stored: string): boolean {
  const [alg, s, h] = String(stored || '').split('$');
  if (alg !== 'scrypt' || !s || !h) return false;
  const dk = crypto.scryptSync(pw, Buffer.from(s, 'base64'), 32, { N: 16384, r: 8, p: 1 });
  return crypto.timingSafeEqual(dk, Buffer.from(h, 'base64'));
}
export function nowIso(): string { return isoWib(new Date()); }
/** ISO dengan offset WIB. */
export function isoWib(d: Date): string {
  const t = new Date(d.getTime() + 7 * 3600000).toISOString();
  return t.slice(0, 23) + '+07:00';
}
export function todayWib(d = new Date()): string { return isoWib(d).slice(0, 10); }
export const ms = (iso: unknown): number => { const t = iso ? new Date(String(iso)).getTime() : NaN; return Number.isFinite(t) ? t : 0; };
export const isPast = (iso: unknown): boolean => !!iso && ms(iso) > 0 && ms(iso) <= Date.now();
const BULAN = ['Jan', 'Feb', 'Mar', 'Apr', 'Mei', 'Jun', 'Jul', 'Agu', 'Sep', 'Okt', 'Nov', 'Des'];
export function fmtIdDate(iso: unknown, withSec = false): string {
  const t = ms(iso);
  if (!t) return '-';
  const w = isoWib(new Date(t));
  return w.slice(8, 10) + ' ' + BULAN[Number(w.slice(5, 7)) - 1] + ' ' + w.slice(0, 4) + ' ' + w.slice(11, withSec ? 19 : 16) + ' WIB';
}
/** Tanggal input (yyyy-mm-dd atau ISO) → ISO; kosong → null. */
export function parseDateInput(v: unknown, field: string): string | null {
  const s = str(v, 40);
  if (!s) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}))?/.exec(s);
  if (!m) throw vErr(field, 'Format tanggal tidak valid.');
  const iso = m[1] + '-' + m[2] + '-' + m[3] + 'T' + (m[4] || '23') + ':' + (m[5] || '59') + ':00+07:00';
  if (!ms(iso)) throw vErr(field, 'Tanggal tidak valid.');
  return iso;
}
export function addSecIso(sec: number): string { return isoWib(new Date(Date.now() + sec * 1000)); }
export function paginate(p: { page?: unknown; pageSize?: unknown }) {
  const pageSize = int(p.pageSize, 20, 1, APP.PAGE_SIZE_MAX);
  const page = int(p.page, 1, 1, 100000);
  return { page, pageSize, offset: (page - 1) * pageSize };
}
export function parseUa(ua: unknown): { device: string; os: string; browser: string } {
  const s = String(ua || '');
  if (!s) return { device: '', os: '', browser: '' };
  if (/bot|crawl|spider|slurp|facebookexternalhit|whatsapp|telegrambot|preview|curl|wget|python-requests|headless/i.test(s)) return { device: 'bot', os: '', browser: '' };
  const device = /iPad|Tablet/i.test(s) ? 'tablet' : /Mobi|Android|iPhone/i.test(s) ? 'mobile' : 'desktop';
  const os = /Windows/i.test(s) ? 'Windows' : /iPhone|iPad|iOS/i.test(s) ? 'iOS' : /Android/i.test(s) ? 'Android' : /Mac OS|Macintosh/i.test(s) ? 'macOS' : /Linux/i.test(s) ? 'Linux' : 'Lainnya';
  const browser = /Edg\//i.test(s) ? 'Edge' : /OPR\/|Opera/i.test(s) ? 'Opera' : /SamsungBrowser/i.test(s) ? 'Samsung' : /Firefox\//i.test(s) ? 'Firefox' : /Chrome\//i.test(s) ? 'Chrome' : /Safari\//i.test(s) ? 'Safari' : 'Lainnya';
  return { device, os, browser };
}
export function safeJson<T>(v: unknown, def: T): T {
  if (v == null || v === '') return def;
  if (typeof v === 'object') return v as T;
  try { return JSON.parse(String(v)) as T; } catch { return def; }
}
export function assert(cond: unknown, code: ConstructorParameters<typeof AppError>[0], msg: string): asserts cond {
  if (!cond) throw new AppError(code, msg);
}
/** Netralkan formula spreadsheet untuk ekspor CSV. */
export function csvCell(v: unknown): string {
  let s = v == null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return '"' + s.replace(/"/g, '""') + '"';
}
