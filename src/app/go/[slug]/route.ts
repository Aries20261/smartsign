import { APP } from '@/server/config';
import { publicLinkView } from '@/server/services/links';
import { GO_CSS } from '@/server/web/goCss';
import { ASSET_V, NO_STORE, esc, pageCsp, safeJsonForHtml } from '@/server/web/html';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Halaman perantara: password, peringatan risiko, jadwal, kedaluwarsa, atau tidak ditemukan. */
export async function GET(req: Request, ctx: { params: Promise<{ slug: string }> }) {
  const { slug } = await ctx.params;
  const url = new URL(req.url);
  const view = await publicLinkView(slug);
  const boot = { view, src: url.searchParams.get('q') === '1' ? 'qr' : 'langsung', appName: APP.NAME };
  const html = `<!DOCTYPE html><html lang="id"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex,nofollow"><meta name="referrer" content="strict-origin-when-cross-origin"><title>${esc(APP.NAME)}</title><link rel="icon" href="/icon.svg" type="image/svg+xml">
<style>${GO_CSS}</style></head><body><main class="card" id="card" aria-live="polite"><p class="m">Memuat…</p></main>
<noscript><p style="text-align:center">Aktifkan JavaScript untuk melanjutkan.</p></noscript>
<script id="boot" type="application/json">${safeJsonForHtml(boot)}</script><script src="/js/go.js?v=${ASSET_V}" defer></script></body></html>`;
  const status = view.state === 'notfound' ? 404 : 200;
  return new Response(html, { status, headers: { ...NO_STORE, 'content-type': 'text/html; charset=utf-8', 'content-security-policy': pageCsp() } });
}
