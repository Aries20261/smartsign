import { db, type Q } from '../db';
import { APP, DEFAULT_WS_SETTINGS, ENV, PLAN_LIMITS, PUBLIC_WS_ID, shortUrlOf, type WsSettings } from '../config';
import { AppError, vErr } from '../errors';
import { audit, securityEvent } from '../audit';
import { rateLimit, rateBump, rateCount } from '../ratelimit';
import { platformSettings, requireReauth, wsSettings, type Ctx } from '../session';
import { randomToken, bool, hashSecret, int, isPast, ms, paginate, parseDateInput, parseUa, randomSlug, sha256Hex, str, todayWib, verifySecret, addSecIso } from '../util';

export const RESERVED_SLUGS = ['admin', 'api', 'app', 'login', 'logout', 'masuk', 'daftar', 'verify', 'verifikasi', 'sign', 'ttd', 's', 'go', 'help', 'bantuan',
  'static', 'assets', 'vendor', 'js', 'dashboard', 'settings', 'reset', 'invite', 'report', 'auth', 'favicon.ico', 'robots.txt', 'sitemap.xml', '_next'];
const SHORTENERS = ['bit.ly', 'bitly.com', 'tinyurl.com', 't.co', 'goo.gl', 's.id', 'ow.ly', 'is.gd', 'buff.ly', 'cutt.ly', 'rebrand.ly', 'shorturl.at', 'rb.gy', 't.ly', 'tiny.cc', 'v.gd', 'lnkd.in'];
const RISKY_TLDS = ['zip', 'mov', 'xyz', 'top', 'click', 'gq', 'tk', 'ml', 'cf', 'ga', 'work', 'rest', 'kim', 'loan', 'buzz', 'cam', 'icu', 'cyou', 'sbs'];
const PHISH_WORDS = ['login', 'signin', 'verify', 'verifikasi', 'password', 'wallet', 'otp', 'akun-anda', 'update-account', 'secure-', 'bank', 'hadiah', 'undian', 'claim'];

/* ---------- Analisis URL ---------- */
export type ParsedUrl = { scheme: string; host: string; port: number | null; path: string; query: string; url: string } | { error: string } | null;
export function parseUrl(raw: unknown): ParsedUrl {
  const s = String(raw || '').trim();
  // eslint-disable-next-line no-control-regex
  if (!s || s.length > 2000 || /[\s\u0000-\u001f\u007f<>"`]/.test(s)) return null;
  const m = /^(https?):\/\/([^/?#]+)([^?#]*)(\?[^#]*)?(#.*)?$/i.exec(s);
  if (!m) return null;
  const authority = m[2];
  if (authority.includes('@')) return { error: 'URL dengan kredensial (user@host) tidak diizinkan.' };
  const hp = /^(\[[0-9a-f:.]+\]|[^:]+)(?::(\d{1,5}))?$/i.exec(authority);
  if (!hp) return null;
  const host = hp[1].toLowerCase().replace(/\.$/, '');
  if (!/^(\[[0-9a-f:.]+\]|[a-z0-9.-]+)$/.test(host) || host.includes('..')) return null;
  return { scheme: m[1].toLowerCase(), host, port: hp[2] ? Number(hp[2]) : null, path: m[3] || '/', query: m[4] || '', url: s };
}
export function hostOf(url: unknown): string { const u = parseUrl(url); return u && 'host' in u ? u.host : ''; }
export function isPrivateHost(h: string): boolean {
  if (h === 'localhost' || /\.(local|localhost|internal|lan|home|corp)$/.test(h) || h.startsWith('[')) return true;
  const ip = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (!ip) return false;
  const a = Number(ip[1]), b = Number(ip[2]);
  return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
}
export const hostMatches = (host: string, domain: string) => { const d = String(domain || '').toLowerCase().trim(); return !!d && (host === d || host.endsWith('.' + d)); };

async function blockedDomains(workspaceId: string | null): Promise<string[]> {
  const rows = await db()`select domain from blocklist where status = 'aktif' and (workspace_id is null or workspace_id = ${workspaceId})`;
  const plat = await platformSettings();
  return rows.map((r) => r.domain as string).concat(String(plat.globalBlocklist || '').split(/[\s,]+/).filter(Boolean));
}
const sbMemo = new Map<string, { at: number; hit: boolean }>();
async function safeBrowsing(url: string): Promise<boolean | null> {
  const key = ENV.safeBrowsingKey;
  if (!key) return null;
  const k = sha256Hex(url);
  const c = sbMemo.get(k);
  if (c && Date.now() - c.at < 6 * 3600000) return c.hit;
  try {
    const res = await fetch('https://safebrowsing.googleapis.com/v4/threatMatches:find?key=' + encodeURIComponent(key), {
      method: 'POST', headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(2500),
      body: JSON.stringify({ client: { clientId: 'smartsign', clientVersion: APP.VERSION }, threatInfo: {
        threatTypes: ['MALWARE', 'SOCIAL_ENGINEERING', 'UNWANTED_SOFTWARE', 'POTENTIALLY_HARMFUL_APPLICATION'],
        platformTypes: ['ANY_PLATFORM'], threatEntryTypes: ['URL'], threatEntries: [{ url }] } })
    });
    if (!res.ok) return null;
    const j = await res.json();
    const hit = !!(j.matches || []).length;
    sbMemo.set(k, { at: Date.now(), hit });
    return hit;
  } catch { return null; }
}
export type Analysis = { ok: true; url: string; host: string; score: number; flags: string[]; risky: boolean; safeBrowsingChecked: boolean } | { ok: false; error: string; blocked?: boolean };
export async function analyzeUrl(raw: string, workspaceId: string | null, settings: Partial<WsSettings>): Promise<Analysis> {
  const u = parseUrl(raw);
  if (!u) return { ok: false, error: 'URL tidak valid. Gunakan format lengkap, misalnya https://contoh.id/halaman.' };
  if ('error' in u) return { ok: false, error: u.error };
  if (isPrivateHost(u.host)) return { ok: false, error: 'Alamat jaringan lokal/privat tidak diizinkan.' };
  const self = [hostOf(ENV.appUrl), hostOf(ENV.shortDomain)].filter(Boolean);
  if (self.some((h) => hostMatches(u.host, h))) return { ok: false, error: 'Tujuan tidak boleh mengarah ke shortlink/aplikasi ini (mencegah redirect berulang).' };
  const flags: string[] = [];
  let score = 0;
  const add = (pts: number, msg: string) => { score += pts; flags.push(msg); };
  if (u.scheme !== 'https') add(20, 'Tidak memakai HTTPS (koneksi tidak terenkripsi)');
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(u.host)) add(40, 'Tujuan berupa alamat IP, bukan nama domain');
  if (u.host.split('.').some((l) => l.startsWith('xn--'))) add(30, 'Domain internasional (punycode), waspadai penyamaran huruf');
  if (u.host.split('.').length > 5 || u.host.length > 60) add(15, 'Nama domain sangat panjang/bersubdomain banyak');
  if (RISKY_TLDS.includes(u.host.split('.').pop() || '')) add(15, 'Ekstensi domain sering disalahgunakan');
  if (SHORTENERS.some((d) => hostMatches(u.host, d))) add(25, 'Mengarah ke pemendek tautan lain (tujuan akhir tersembunyi)');
  if (u.port && u.port !== 80 && u.port !== 443) add(15, 'Memakai port tidak standar');
  const low = (u.host + u.path).toLowerCase();
  if (PHISH_WORDS.some((w) => low.includes(w))) add(15, 'Memuat kata yang lazim dipakai halaman phishing');
  if (settings.allowedDomains) {
    const allow = String(settings.allowedDomains).split(/[\s,]+/).filter(Boolean);
    if (allow.length && !allow.some((d) => hostMatches(u.host, d))) return { ok: false, error: 'Domain tujuan tidak termasuk daftar domain yang diizinkan ruang kerja.' };
  }
  if ((await blockedDomains(workspaceId)).some((d) => hostMatches(u.host, d))) return { ok: false, blocked: true, error: 'Domain tujuan masuk daftar blokir.' };
  const sb = await safeBrowsing(u.url);
  if (sb === true) return { ok: false, blocked: true, error: 'Domain tujuan terdeteksi berbahaya oleh Google Safe Browsing.' };
  return { ok: true, url: u.url, host: u.host, score: Math.min(score, 99), flags, risky: score >= 40, safeBrowsingChecked: sb !== null };
}

/* ---------- Tampilan & status ---------- */
export function effectiveLinkState(l: any): string {
  if (!l || l.status === 'dihapus') return 'notfound';
  if (l.status === 'diblokir') return 'blocked';
  if (l.status !== 'aktif') return 'inactive';
  if (isPast(l.expiresAt)) return 'expired';
  if (l.activeFrom && !isPast(l.activeFrom)) return 'scheduled';
  if (l.maxClicks && Number(l.clickCount) >= Number(l.maxClicks)) return 'limit';
  return 'ok';
}
const canEditLink = (l: any, u: Ctx) => u.role === 'admin' || (u.role === 'editor' && l.ownerId === u.userId);
function linkView(l: any, u?: Ctx) {
  return {
    id: l.id, slug: l.slug, title: l.title, destination: l.destination, domain: hostOf(l.destination), status: l.status,
    effectiveStatus: effectiveLinkState(l), expiresAt: l.expiresAt, activeFrom: l.activeFrom, hasPassword: !!l.passwordHash,
    maxClicks: l.maxClicks || 0, campaign: l.campaign, tags: l.tags, interstitial: l.interstitial, riskScore: l.riskScore || 0,
    riskFlags: l.riskFlags || [], notes: l.notes, ownerId: l.ownerId, clicks: Number(l.clickCount) || 0, shortUrl: shortUrlOf(l.slug),
    createdAt: l.createdAt, updatedAt: l.updatedAt, ...(u ? { canEdit: canEditLink(l, u) } : {})
  };
}
async function getWsLink(id: unknown, u: Ctx, q: Q = db(), lock = false) {
  const lid = str(id, 40);
  if (!/^[0-9a-f-]{36}$/.test(lid)) throw new AppError('NOT_FOUND', 'Shortlink tidak ditemukan.');
  const [l] = lock
    ? await q`select * from links where id = ${lid} and workspace_id = ${u.workspaceId} and status <> 'dihapus' for update`
    : await q`select * from links where id = ${lid} and workspace_id = ${u.workspaceId} and status <> 'dihapus'`;
  if (!l) throw new AppError('NOT_FOUND', 'Shortlink tidak ditemukan.');
  return l;
}
function assertEdit(l: any, u: Ctx) { if (!canEditLink(l, u)) throw new AppError('FORBIDDEN', 'Hanya pemilik tautan atau admin yang dapat mengubah tautan ini.'); }

/* ---------- Slug ---------- */
async function validateSlug(slug: string, selfId: string | null, q: Q = db()) {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{2,49}$/.test(slug)) throw vErr('slug', '3–50 karakter: huruf, angka, "-" atau "_", diawali huruf/angka.');
  if (RESERVED_SLUGS.includes(slug.toLowerCase())) throw vErr('slug', 'Slug ini dicadangkan sistem.');
  const [x] = await q`select id from links where lower(slug) = ${slug.toLowerCase()} and id is distinct from ${selfId}
    union all select link_id from retired_slugs where slug = ${slug.toLowerCase()} and link_id is distinct from ${selfId} limit 1`;
  if (x) throw new AppError('CONFLICT', 'Slug sudah dipakai.', { slug: 'Slug sudah dipakai (slug lama tidak dapat dipakai ulang), coba yang lain.' });
}
export async function checkSlug(p: any) {
  const slug = str(p.slug, 60);
  try { await validateSlug(slug, str(p.id, 40) || null); return { available: true }; }
  catch (e: any) { return { available: false, reason: (e.fields && e.fields.slug) || e.message }; }
}
async function generateSlug(q: Q) {
  for (let i = 0; i < 10; i++) {
    const s = randomSlug(7);
    const [x] = await q`select 1 from links where lower(slug) = ${s.toLowerCase()} union all select 1 from retired_slugs where slug = ${s.toLowerCase()}`;
    if (!x) return s;
  }
  throw new AppError('BUSY', 'Gagal membuat slug unik, coba lagi.');
}
export function applyUtm(url: string, utm: any): string {
  if (!utm) return url;
  const parts: string[] = [];
  for (const k of ['source', 'medium', 'campaign', 'term', 'content']) { const v = str(utm[k], 80); if (v) parts.push('utm_' + k + '=' + encodeURIComponent(v)); }
  if (!parts.length) return url;
  const i = url.indexOf('#');
  const base = i >= 0 ? url.slice(0, i) : url, hash = i >= 0 ? url.slice(i) : '';
  return base + (base.includes('?') ? '&' : '?') + parts.join('&') + hash;
}

/* ---------- CRUD ---------- */
async function buildLinkFields(p: any, u: Ctx, settings: WsSettings, existing: any | null) {
  const out: Record<string, any> = {};
  if (!existing || 'title' in p) {
    out.title = str(p.title, 120);
    if (out.title.length < 2) throw vErr('title', 'Judul internal minimal 2 karakter.');
  }
  if (!existing || 'destination' in p) {
    const dest = applyUtm(str(p.destination, 2000), p.utm);
    const a = await analyzeUrl(dest, u.workspaceId, settings);
    if (!a.ok) {
      if (a.blocked) await securityEvent('tautan_berbahaya_ditolak', 'sedang', u, a.error, { host: hostOf(dest) });
      throw vErr('destination', a.error);
    }
    out.destination = a.url; out.riskScore = a.score; out.riskFlags = a.flags;
  }
  if ('expiresAt' in p) {
    out.expiresAt = parseDateInput(p.expiresAt, 'expiresAt');
    if (out.expiresAt && isPast(out.expiresAt)) throw vErr('expiresAt', 'Tanggal kedaluwarsa harus di masa depan.');
  } else if (!existing && settings.defaultLinkDays > 0) out.expiresAt = addSecIso(settings.defaultLinkDays * 86400);
  if ('activeFrom' in p) out.activeFrom = parseDateInput(p.activeFrom, 'activeFrom');
  const exp = 'expiresAt' in out ? out.expiresAt : existing?.expiresAt, act = 'activeFrom' in out ? out.activeFrom : existing?.activeFrom;
  if (exp && act && ms(act) >= ms(exp)) throw vErr('activeFrom', 'Jadwal aktif harus sebelum tanggal kedaluwarsa.');
  if ('maxClicks' in p) out.maxClicks = p.maxClicks === '' || p.maxClicks == null ? null : int(p.maxClicks, 0, 0, 1000000) || null;
  for (const k of ['campaign', 'tags', 'notes']) if (k in p) out[k] = str(p[k], k === 'notes' ? 500 : k === 'tags' ? 200 : 80);
  if ('tags' in out) out.tags = String(out.tags).split(',').map((t) => t.trim().toLowerCase()).filter(Boolean).slice(0, 10).join(', ');
  if ('interstitial' in p) out.interstitial = p.interstitial === 'always' ? 'always' : 'auto';
  if (p.password) {
    const pw = String(p.password);
    if (pw.length < 4 || pw.length > 64) throw vErr('password', 'Password tautan 4–64 karakter.');
    out.passwordHash = hashSecret(pw);
  } else if (existing && bool(p.removePassword)) out.passwordHash = null;
  return out;
}

async function createLinkCore(p: any, u: Ctx, settings: WsSettings, q: Q) {
  const plan = PLAN_LIMITS[u.plan] || PLAN_LIMITS.free;
  const [c] = await q`select count(*)::int as n from links where workspace_id = ${u.workspaceId} and status <> 'dihapus'`;
  if (c.n >= plan.links) throw new AppError('FORBIDDEN', 'Kuota shortlink paket ' + plan.label + ' (' + plan.links + ') sudah penuh.');
  const fields = await buildLinkFields(p, u, settings, null);
  let slug = str(p.slug, 60);
  if (slug) await validateSlug(slug, null, q); else slug = await generateSlug(q);
  let l;
  try {
    [l] = await q`insert into links ${q({ workspaceId: u.workspaceId, slug, ownerId: u.userId, createdBy: u.userId, updatedBy: u.userId, interstitial: 'auto', ...fields } as never)} returning *`;
  } catch (e: any) {
    if (e.code === '23505') throw new AppError('CONFLICT', 'Slug sudah dipakai.', { slug: 'Slug sudah dipakai, coba yang lain.' });
    throw e;
  }
  await q`insert into link_versions ${q({ linkId: l.id, workspaceId: u.workspaceId, field: 'dibuat', oldValue: '', newValue: l.destination, source: p._source || 'ui', createdBy: u.userId } as never)}`;
  await audit(u, 'link.create', 'Link', l.id, null, linkView(l), p._source || 'ui', q);
  return l;
}
export async function createLink(p: any, u: Ctx) {
  const l = await db().begin((t) => createLinkCore(p, u, u.settings, t));
  invalidateLinkCache(l.slug);
  return { link: linkView(l, u) };
}
export async function bulkCreateLinks(p: any, u: Ctx) {
  const lines = String(p.lines || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (!lines.length) throw vErr('lines', 'Masukkan minimal satu baris.');
  if (lines.length > 100) throw vErr('lines', 'Maksimal 100 baris per impor.');
  const results: any[] = [];
  for (let i = 0; i < lines.length; i++) {
    const parts = lines[i].split(/\t|\s*[,;|]\s*/);
    try {
      const l = await db().begin((t) => createLinkCore({ destination: parts[0], slug: parts[1] || '', title: parts[2] || 'Impor ' + (i + 1), _source: 'impor' }, u, u.settings, t));
      results.push({ line: i + 1, ok: true, slug: l.slug, shortUrl: shortUrlOf(l.slug) });
    } catch (e: any) {
      if (!(e instanceof AppError)) throw e;
      results.push({ line: i + 1, ok: false, error: e.fields ? Object.values(e.fields).join('; ') : e.message });
    }
  }
  return { results, created: results.filter((r) => r.ok).length };
}
export async function updateLink(p: any, u: Ctx) {
  const pre = await getWsLink(p.id, u);
  assertEdit(pre, u);
  if (pre.status === 'diblokir') throw new AppError('FORBIDDEN', 'Tautan diblokir karena laporan penyalahgunaan dan tidak dapat diubah.');
  const newSlug = 'slug' in p ? str(p.slug, 60) : pre.slug;
  const sensitive = ('destination' in p && applyUtm(str(p.destination, 2000), p.utm) !== pre.destination) || newSlug !== pre.slug || !!p.password || bool(p.removePassword);
  if (sensitive) await requireReauth(u);
  const patch = await buildLinkFields(p, u, u.settings, pre);
  if (newSlug !== pre.slug) { await validateSlug(newSlug, pre.id); patch.slug = newSlug; }
  const after = await db().begin(async (t) => {
    const before = await getWsLink(p.id, u, t, true);
    const [a] = await t`update links set ${t({ ...patch, updatedBy: u.userId } as never)} where id = ${before.id} returning *`;
    if (a.slug !== before.slug) await t`insert into retired_slugs (slug, link_id) values (${String(before.slug).toLowerCase()}, ${a.id}) on conflict (slug) do nothing`;
    for (const f of ['destination', 'slug', 'title', 'expiresAt', 'activeFrom', 'maxClicks', 'campaign', 'tags', 'interstitial', 'notes']) {
      const o = before[f] == null ? '' : String(before[f]), n = a[f] == null ? '' : String(a[f]);
      if (o !== n) await t`insert into link_versions ${t({ linkId: a.id, workspaceId: u.workspaceId, field: f, oldValue: o, newValue: n, source: 'ui', createdBy: u.userId } as never)}`;
    }
    if (!!before.passwordHash !== !!a.passwordHash || p.password)
      await t`insert into link_versions ${t({ linkId: a.id, workspaceId: u.workspaceId, field: 'password', oldValue: before.passwordHash ? 'ada' : 'tidak', newValue: a.passwordHash ? 'ada (diperbarui)' : 'tidak', source: 'ui', createdBy: u.userId } as never)}`;
    await audit(u, 'link.update', 'Link', a.id, linkView(before), linkView(a), 'ui', t);
    return a;
  });
  invalidateLinkCache(pre.slug); invalidateLinkCache(after.slug);
  return { link: linkView(after, u) };
}
export async function setLinkStatus(p: any, u: Ctx) {
  const status = str(p.status, 20);
  if (!['aktif', 'nonaktif', 'arsip', 'dihapus'].includes(status)) throw vErr('status', 'Status tidak dikenal.');
  const l = await db().begin(async (t) => {
    const l0 = await getWsLink(p.id, u, t, true);
    assertEdit(l0, u);
    if (l0.status === 'diblokir') throw new AppError('FORBIDDEN', 'Tautan diblokir. Hanya superadmin yang dapat membuka blokir.');
    await t`update links set status = ${status}, updated_by = ${u.userId} where id = ${l0.id}`;
    await t`insert into link_versions ${t({ linkId: l0.id, workspaceId: u.workspaceId, field: 'status', oldValue: l0.status, newValue: status, source: 'ui', createdBy: u.userId } as never)}`;
    await audit(u, status === 'dihapus' ? 'link.delete' : 'link.status', 'Link', l0.id, { status: l0.status }, { status }, 'ui', t);
    return l0;
  });
  invalidateLinkCache(l.slug);
  return { ok: true, status };
}
export async function listLinks(p: any, u: Ctx) {
  const q = str(p.q, 100).toLowerCase(), status = str(p.status, 20), tag = str(p.tag, 40).toLowerCase();
  const { page, pageSize, offset } = paginate(p);
  const sql = db();
  const where = sql`workspace_id = ${u.workspaceId} and status <> 'dihapus'
    ${status === 'expired' ? sql`and status = 'aktif' and expires_at <= now()` : status ? sql`and status = ${status}` : sql``}
    ${tag ? sql`and (', ' || lower(tags) || ',') like ${'%, ' + tag + ',%'}` : sql``}
    ${bool(p.mine) ? sql`and owner_id = ${u.userId}` : sql``}
    ${q ? sql`and lower(title || ' ' || slug || ' ' || destination || ' ' || campaign || ' ' || tags) like ${'%' + q.replace(/[%_\\]/g, '\\$&') + '%'}` : sql``}`;
  const [c] = await sql`select count(*)::int as n from links where ${where}`;
  const rows = await sql`select * from links where ${where} order by ${str(p.sort, 20) === 'clicks' ? sql`click_count desc, created_at desc` : sql`created_at desc`} limit ${pageSize} offset ${offset}`;
  return { rows: rows.map((l) => linkView(l, u)), total: c.n, page, pageSize };
}
export async function getLink(p: any, u: Ctx) {
  const l = await getWsLink(p.id, u);
  const sql = db();
  const versions = await sql`select v.field, v.old_value, v.new_value, v.source, v.created_at, coalesce(pr.nama, 'sistem') as by
    from link_versions v left join profiles pr on pr.id = v.created_by where v.link_id = ${l.id} order by v.id desc limit 50`;
  const codes = await sql`select id, format, version, design, created_at from code_assets where link_id = ${l.id} and status = 'aktif' order by version desc`;
  return {
    link: linkView(l, u),
    versions: versions.map((v) => ({ field: v.field, oldValue: v.oldValue, newValue: v.newValue, source: v.source, at: v.createdAt, by: v.by })),
    codes: codes.map((c) => ({ id: c.id, format: c.format, version: c.version, design: c.design, createdAt: c.createdAt })),
    stats: await linkStats({ linkId: l.id, days: 30 }, u)
  };
}
export async function exportLinks(_p: any, u: Ctx) {
  const rows = await db()`select * from links where workspace_id = ${u.workspaceId} and status <> 'dihapus' order by created_at desc limit ${APP.EXPORT_MAX_ROWS}`;
  await audit(u, 'link.export', 'Link', '', null, { jumlah: rows.length });
  return { header: ['Judul', 'URL Pendek', 'Tujuan', 'Status', 'Status Efektif', 'Klik', 'Kedaluwarsa', 'Kampanye', 'Tag', 'Dibuat'],
    rows: rows.map((l) => { const v = linkView(l); return [v.title, v.shortUrl, v.destination, v.status, v.effectiveStatus, v.clicks, v.expiresAt, v.campaign, v.tags, v.createdAt]; }) };
}

/* ---------- Statistik (agregasi di database) ---------- */
export async function linkStats(p: any, u: Ctx) {
  const days = int(p.days, 30, 1, 365);
  const linkId = str(p.linkId, 40);
  if (linkId) await getWsLink(linkId, u);
  const sql = db();
  const lf = linkId ? sql`and link_id = ${linkId}` : sql``;
  const base = sql`workspace_id = ${u.workspaceId} and result = 'redirect' and at >= now() - make_interval(days => ${days}) ${lf}`;
  const [series, tot, dev, os, br, ref, src, ctry, camp, top] = await Promise.all([
    sql`select d::date::text as date, coalesce(c.total, 0)::int as total, coalesce(c.qr, 0)::int as qr
        from generate_series((now() at time zone 'Asia/Jakarta')::date - ${days - 1}::int, (now() at time zone 'Asia/Jakarta')::date, interval '1 day') d
        left join (select day, count(*) as total, count(*) filter (where source = 'qr') as qr from click_events where ${base} group by day) c on c.day = d::date order by d`,
    sql`select count(*)::int as total, count(*) filter (where source = 'qr')::int as qr, count(distinct nullif(visitor_hash, ''))::int as uniq from click_events where ${base}`,
    sql`select coalesce(nullif(device, ''), 'tidak diketahui') as key, count(*)::int as count from click_events where ${base} group by 1 order by 2 desc limit 8`,
    sql`select coalesce(nullif(os, ''), 'tidak diketahui') as key, count(*)::int as count from click_events where ${base} group by 1 order by 2 desc limit 8`,
    sql`select coalesce(nullif(browser, ''), 'tidak diketahui') as key, count(*)::int as count from click_events where ${base} group by 1 order by 2 desc limit 8`,
    sql`select coalesce(nullif(referrer, ''), 'langsung / tidak diketahui') as key, count(*)::int as count from click_events where ${base} group by 1 order by 2 desc limit 8`,
    sql`select source as key, count(*)::int as count from click_events where ${base} group by 1 order by 2 desc limit 8`,
    sql`select coalesce(nullif(country, ''), 'tidak diketahui') as key, count(*)::int as count from click_events where ${base} group by 1 order by 2 desc limit 8`,
    sql`select coalesce(nullif(l.campaign, ''), '(tanpa kampanye)') as key, count(*)::int as count from click_events c join links l on l.id = c.link_id
        where c.workspace_id = ${u.workspaceId} and c.result = 'redirect' and c.at >= now() - make_interval(days => ${days}) ${linkId ? sql`and c.link_id = ${linkId}` : sql``} group by 1 order by 2 desc limit 8`,
    linkId ? Promise.resolve([]) : sql`select c.link_id as id, l.title, l.slug, count(*)::int as count from click_events c join links l on l.id = c.link_id
        where c.workspace_id = ${u.workspaceId} and c.result = 'redirect' and c.at >= now() - make_interval(days => ${days}) group by 1, 2, 3 order by 4 desc limit 10`
  ]);
  return {
    days, total: tot[0].total, totalQr: tot[0].qr, unique: tot[0].uniq, series: series.map((s) => ({ date: s.date, total: s.total, qr: s.qr })),
    devices: [...dev], os: [...os], browsers: [...br], referrers: [...ref], sources: [...src], countries: [...ctry], campaigns: [...camp],
    topLinks: [...top].map((x: any) => ({ id: x.id, title: x.title, slug: x.slug, count: x.count })), analyticsMode: u.settings.analyticsMode
  };
}
export async function exportClicks(p: any, u: Ctx) {
  const days = int(p.days, 30, 1, 365);
  const linkId = str(p.linkId, 40);
  const sql = db();
  const rows = await sql`select c.at, l.slug, c.source, c.device, c.os, c.browser, c.referrer, c.country, c.result from click_events c join links l on l.id = c.link_id
    where c.workspace_id = ${u.workspaceId} and c.at >= now() - make_interval(days => ${days}) ${linkId ? sql`and c.link_id = ${linkId}` : sql``}
    order by c.at desc limit ${APP.EXPORT_MAX_ROWS}`;
  await audit(u, 'analytics.export', 'ClickEvents', '', null, { jumlah: rows.length, hari: days });
  return { header: ['Waktu', 'Slug', 'Sumber', 'Perangkat', 'OS', 'Browser', 'Referrer', 'Negara', 'Hasil'],
    rows: rows.map((c) => [c.at, c.slug, c.source, c.device, c.os, c.browser, c.referrer, c.country, c.result]) };
}

/* ---------- Resolusi publik (redirect) ---------- */
type PublicLink = { id: string; workspaceId: string; slug: string; status: string; destination: string; expiresAt: string | null; activeFrom: string | null;
  passwordHash: string | null; maxClicks: number | null; clickCount: number; riskScore: number; riskFlags: string[]; interstitial: boolean; analyticsMode: string };
const linkCache = new Map<string, { at: number; v: PublicLink | null }>();
const LINK_TTL = 15000;
export function invalidateLinkCache(slug: string) { linkCache.delete(String(slug).toLowerCase()); }

/** Cache singkat per instance agar redirect cepat; perubahan link membersihkan cache instance yang sama, instance lain paling lama 15 detik. */
export async function linkBySlug(slug: string, fresh = false): Promise<PublicLink | null> {
  const key = slug.toLowerCase();
  const c = linkCache.get(key);
  if (!fresh && c && Date.now() - c.at < LINK_TTL) return c.v;
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{2,49}$/.test(slug)) return null;
  const [l] = await db()`select l.id, l.workspace_id, l.slug, case when w.status = 'aktif' then l.status else 'nonaktif' end as status, l.destination, l.expires_at,
      l.active_from, l.password_hash, l.max_clicks, l.click_count, l.risk_score, l.risk_flags, l.interstitial, w.settings
    from links l join workspaces w on w.id = l.workspace_id where lower(l.slug) = ${key} and l.status <> 'dihapus'`;
  let v: PublicLink | null = null;
  if (l) {
    const st = wsSettings(l.settings);
    v = { id: l.id, workspaceId: l.workspaceId, slug: l.slug, status: l.status, destination: l.destination, expiresAt: l.expiresAt, activeFrom: l.activeFrom,
      passwordHash: l.passwordHash, maxClicks: l.maxClicks, clickCount: Number(l.clickCount), riskScore: l.riskScore, riskFlags: l.riskFlags || [],
      interstitial: st.interstitialMode === 'always' || l.interstitial === 'always' || l.riskScore >= 40, analyticsMode: st.analyticsMode };
  }
  if (linkCache.size > 5000) linkCache.clear();
  linkCache.set(key, { at: Date.now(), v });
  return v;
}
export async function publicLinkView(slug: string) {
  const l = slug ? await linkBySlug(str(slug, 60)) : null;
  if (!l) return { state: 'notfound', slug: str(slug, 60) };
  const state = effectiveLinkState(l);
  return { state, slug: l.slug, domain: state === 'ok' && !l.passwordHash ? hostOf(l.destination) : '', hasPassword: !!l.passwordHash, interstitial: l.interstitial,
    risky: l.riskScore >= 40, flags: state === 'ok' ? l.riskFlags : [], activeFrom: state === 'scheduled' ? l.activeFrom : '' };
}
export type ClickMeta = { source: string; ua: string; referrer: string; country: string; ipHash: string };
/**
 * Mencatat klik secara atomik; untuk link dengan batas klik, penghitung dinaikkan dengan syarat
 * sehingga batas tidak terlewati walau ada klik bersamaan. Mengembalikan false bila batas tercapai.
 */
export async function recordClick(l: PublicLink, m: ClickMeta): Promise<boolean> {
  const info = parseUa(m.ua);
  if (info.device === 'bot') return true; // pratinjau tautan / crawler tidak dihitung
  const sql = db();
  if (l.maxClicks) {
    const [r] = await sql`update links set click_count = click_count + 1 where id = ${l.id} and (max_clicks is null or click_count < max_clicks) returning click_count`;
    if (!r) return false;
  } else {
    await sql`update links set click_count = click_count + 1 where id = ${l.id}`;
  }
  if (l.analyticsMode === 'off') return true;
  const full = l.analyticsMode === 'full';
  await sql`insert into click_events ${sql({ linkId: l.id, workspaceId: l.workspaceId, day: todayWib(), source: m.source,
    device: full ? info.device : '', os: full ? info.os : '', browser: full ? info.browser : '', referrer: full ? hostOf(m.referrer).slice(0, 120) : '',
    country: full ? m.country : '', visitorHash: full ? m.ipHash.slice(0, 16) : '', result: 'redirect' } as never)}`;
  return true;
}
export async function openLinkPublic(p: any, meta: Omit<ClickMeta, 'source'>) {
  const slug = str(p.slug, 60);
  const l = await linkBySlug(slug, true);
  if (!l) return { state: 'notfound' };
  const state = effectiveLinkState(l);
  if (state !== 'ok') return { state };
  if (l.passwordHash) {
    const pw = String(p.password || '');
    if (!pw) return { state: 'password' };
    if ((await rateCount('lp:' + l.id + ':' + meta.ipHash, 900)) >= 10) return { state: 'password', error: 'Terlalu banyak percobaan. Coba lagi dalam 15 menit.' };
    if (!verifySecret(pw, l.passwordHash)) { await rateBump('lp:' + l.id + ':' + meta.ipHash, 900); return { state: 'password', error: 'Password tautan salah.' }; }
  }
  const ok = await recordClick(l, { ...meta, source: p.src === 'qr' ? 'qr' : 'langsung' });
  if (!ok) { invalidateLinkCache(l.slug); return { state: 'limit' }; }
  return { state: 'ok', url: l.destination };
}
export async function reportAbuse(p: any, ipHash: string) {
  const slug = str(p.slug, 60);
  const reason = ['phishing', 'malware', 'spam', 'penipuan', 'lainnya'].includes(p.reason) ? p.reason : 'lainnya';
  await rateLimit('abuse:' + slug.toLowerCase() + ':' + ipHash, 3, 3600, 'Laporan untuk tautan ini sudah diterima. Terima kasih.');
  await rateLimit('abuse:all', 300, 3600);
  const [l] = await db()`select id, workspace_id from links where lower(slug) = ${slug.toLowerCase()}`;
  await db()`insert into abuse_reports ${db()({ linkId: l?.id || null, workspaceId: l?.workspaceId || null, slug, reason, detail: str(p.detail, 500) } as never)}`;
  await securityEvent('laporan_penyalahgunaan', reason === 'phishing' || reason === 'malware' ? 'tinggi' : 'sedang', l ? { workspaceId: l.workspaceId } : null, slug, { reason });
  return { message: 'Terima kasih. Laporan Anda akan ditinjau oleh tim kami.' };
}

/* ---------- Aset QR/barcode ---------- */
export async function saveCodeAsset(p: any, u: Ctx) {
  const l = await getWsLink(p.linkId, u);
  const format = p.format === 'code128' ? 'code128' : 'qr';
  const d = p.design || {};
  const design = {
    size: int(d.size, 512, 128, 2048), margin: int(d.margin, 4, 0, 16),
    fg: /^#[0-9a-f]{6}$/i.test(d.fg) ? d.fg : '#000000', bg: /^#[0-9a-f]{6}$/i.test(d.bg) ? d.bg : '#ffffff',
    ecl: ['L', 'M', 'Q', 'H'].includes(d.ecl) ? d.ecl : 'M', logo: !!d.logo, content: d.content === 'slug' ? 'slug' : 'short', label: str(d.label, 60)
  };
  const asset = await db().begin(async (t) => {
    await t`select pg_advisory_xact_lock(hashtextextended(${'code:' + l.id}, 0))`;
    const [v] = await t`select coalesce(max(version), 0)::int + 1 as v from code_assets where link_id = ${l.id} and format = ${format}`;
    const [a] = await t`insert into code_assets ${t({ linkId: l.id, workspaceId: u.workspaceId, format, design: design as never, version: v.v, createdBy: u.userId } as never)} returning id, version`;
    await audit(u, 'code.save', 'CodeAsset', a.id, null, { linkId: l.id, format, version: a.version }, 'ui', t);
    return a;
  });
  return { id: asset.id, version: asset.version, design };
}

/* ---------- Shortlink publik tanpa login ---------- */
/**
 * Siapa pun dapat membuat shortlink acak tanpa login (dibatasi per IP). Tautan disimpan di ruang kerja sistem
 * dengan analitik minimal. Pembuat menerima "claim token" untuk memindahkan tautan ke ruang kerjanya setelah login,
 * lalu dapat mengganti slug, tujuan, password, dsb.
 */
export async function shortenPublic(p: any, ipHash: string) {
  if (p.website) return { link: null }; // honeypot bot
  await rateLimit('anon:' + (ipHash || 'x'), 10, 3600, 'Batas 10 shortlink per jam tanpa login tercapai. Masuk atau daftar gratis untuk membuat lebih banyak.');
  await rateLimit('anon-d:' + (ipHash || 'x'), 30, 86400, 'Batas harian shortlink tanpa login tercapai. Masuk atau daftar gratis untuk melanjutkan.');
  await rateLimit('anon:all', 2000, 3600, 'Layanan sedang ramai. Coba lagi beberapa menit lagi.');
  const dest = str(p.destination, 2000);
  const a = await analyzeUrl(dest, null, DEFAULT_WS_SETTINGS);
  if (!a.ok) throw vErr('destination', a.error);
  if (a.score >= 40) {
    await securityEvent('tautan_anonim_berisiko_ditolak', 'sedang', null, hostOf(a.url), { flags: a.flags });
    throw vErr('destination', 'Tautan ini terdeteksi berisiko sehingga tidak dapat dipendekkan tanpa login.');
  }
  const claim = randomToken();
  const l = await db().begin(async (t) => {
    const slug = await generateSlug(t);
    const [row] = await t`insert into links ${t({ workspaceId: PUBLIC_WS_ID, slug, title: ('Publik: ' + hostOf(a.url)).slice(0, 120), destination: a.url,
      riskScore: a.score, riskFlags: a.flags as never, interstitial: 'auto', claimHash: sha256Hex(claim) } as never)} returning *`;
    await t`insert into link_versions ${t({ linkId: row.id, workspaceId: PUBLIC_WS_ID, field: 'dibuat', oldValue: '', newValue: row.destination, source: 'publik' } as never)}`;
    await audit({ workspaceId: PUBLIC_WS_ID, ipHash }, 'link.create', 'Link', row.id, null, { slug: row.slug, host: hostOf(row.destination) }, 'publik', t);
    return row;
  });
  return { link: { slug: l.slug, shortUrl: shortUrlOf(l.slug), destination: l.destination, createdAt: l.createdAt }, claim };
}

/** Memindahkan shortlink anonim (dengan claim token yang valid) ke ruang kerja pengguna yang sedang login. */
export async function claimLinks(p: any, u: Ctx) {
  const tokens: string[] = (Array.isArray(p.claims) ? p.claims : []).filter((x: unknown) => typeof x === 'string' && /^[a-f0-9]{64}$/.test(x)).slice(0, 50);
  if (!tokens.length) return { claimed: 0 };
  const plan = PLAN_LIMITS[u.plan] || PLAN_LIMITS.free;
  const claimed = await db().begin(async (t) => {
    const [c] = await t`select count(*)::int as n from links where workspace_id = ${u.workspaceId} and status <> 'dihapus'`;
    const room = Math.max(0, plan.links - c.n);
    if (!room) return [];
    const rows = await t`update links set workspace_id = ${u.workspaceId}, owner_id = ${u.userId}, created_by = ${u.userId}, updated_by = ${u.userId}, claim_hash = null,
        title = ${'Shortlink'} || ' ' || slug
      where id in (select id from links where workspace_id = ${PUBLIC_WS_ID} and claim_hash = any(${tokens.map((x) => sha256Hex(x))}) and status <> 'dihapus' limit ${room})
      returning id, slug`;
    if (rows.length) await t`update click_events set workspace_id = ${u.workspaceId} where link_id = any(${rows.map((r: any) => r.id)})`;
    for (const r of rows) await audit(u, 'link.claim', 'Link', r.id, null, { slug: r.slug }, 'ui', t);
    return rows;
  });
  claimed.forEach((r: any) => invalidateLinkCache(r.slug));
  return { claimed: claimed.length, slugs: claimed.map((r: any) => r.slug) };
}
