import { APP, ENV, shortBase } from '../config';
import { platformSettings } from '../session';

/** JSON yang aman disisipkan ke dalam <script type="application/json">. */
export function safeJsonForHtml(v: unknown): string {
  return JSON.stringify(v).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
}
export function esc(s: string): string {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));
}
export const NO_STORE = { 'cache-control': 'no-store', 'x-robots-tag': 'noindex, nofollow' };
export function pageCsp(): string {
  return ["default-src 'self'", "script-src 'self'", "style-src 'unsafe-inline'", "img-src 'self' data:", "connect-src 'self'",
    "base-uri 'none'", "form-action 'self'", "frame-ancestors 'none'", "object-src 'none'"].join('; ');
}
export const ASSET_V = APP.VERSION;


export function appCsp(): string {
  const sb = ENV.supabaseUrl;
  return ["default-src 'self'", "script-src 'self'", "style-src 'self' 'unsafe-inline'", "img-src 'self' blob: data:",
    "connect-src 'self'" + (sb ? ' ' + sb : ''), "worker-src 'self' blob:", "media-src 'self' blob:", "font-src 'self'",
    "base-uri 'none'", "form-action 'self'", "frame-ancestors 'none'", "object-src 'none'"].join('; ');
}

export type SpaMode = 'app' | 'sign' | 'verify' | 'reset' | 'invite';
/** Halaman SPA: kerangka HTML statis + data boot non-sensitif. Tidak ada skrip inline. */
export async function spaPage(mode: SpaMode, token = '', notice = ''): Promise<Response> {
  let allowRegistration = true;
  try { allowRegistration = !!(await platformSettings()).allowRegistration; } catch { /* DB belum siap: tampilkan default */ }
  const boot = {
    mode, token: String(token).slice(0, 200), appName: APP.NAME, tagline: APP.TAGLINE, version: APP.VERSION, webAppUrl: ENV.appUrl,
    shortBase: shortBase(), allowRegistration, assurance: APP.ASSURANCE_LABEL, maxPdfMb: Math.round(APP.MAX_PDF_BYTES / 1048576),
    passwordMin: APP.PASSWORD_MIN, demo: false, notice: String(notice).slice(0, 200)
  };
  const titles: Record<SpaMode, string> = { app: APP.NAME, sign: 'Tanda tangani dokumen', verify: 'Verifikasi dokumen', reset: 'Atur ulang password', invite: 'Undangan tim' };
  const js = ['core', 'codes', 'app', 'pages', 'public'].map((f) => `<script src="/js/${f}.js?v=${ASSET_V}" defer></script>`).join('');
  const html = `<!DOCTYPE html><html lang="id"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="strict-origin-when-cross-origin"><meta name="color-scheme" content="light dark"><meta name="description" content="${esc(APP.TAGLINE)}">
${mode === 'app' || mode === 'verify' ? '' : '<meta name="robots" content="noindex,nofollow">'}<title>${esc(titles[mode] + (mode === 'app' ? ' · ' + APP.TAGLINE : ' · ' + APP.NAME))}</title>
<link rel="icon" href="/icon.svg" type="image/svg+xml"><link rel="stylesheet" href="/css/app.css?v=${ASSET_V}"></head><body>
<a href="#content" class="sr-only">Lewati ke konten utama</a><div id="app" aria-live="off"></div>
<div id="toasts" class="toasts" aria-live="polite" aria-atomic="false"></div><div id="modals"></div>
<noscript><p style="padding:24px">Aplikasi ini membutuhkan JavaScript.</p></noscript>
<script id="boot" type="application/json">${safeJsonForHtml(boot)}</script>${js}</body></html>`;
  const headers: Record<string, string> = { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'content-security-policy': appCsp() };
  if (mode !== 'app' && mode !== 'verify') headers['x-robots-tag'] = 'noindex, nofollow';
  if (mode === 'sign' || mode === 'reset' || mode === 'invite') headers['referrer-policy'] = 'no-referrer';
  return new Response(html, { headers });
}
