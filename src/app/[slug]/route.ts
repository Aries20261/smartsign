import { after } from 'next/server';
import { RESERVED_SLUGS, effectiveLinkState, linkBySlug, recordClick, invalidateLinkCache } from '@/server/services/links';
import { reqInfo } from '@/server/session';
import { NO_STORE } from '@/server/web/html';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function redirect(to: string, status = 302) {
  return new Response(null, { status, headers: { ...NO_STORE, location: to, 'referrer-policy': 'strict-origin-when-cross-origin' } });
}

/** Redirect shortlink: 302 langsung bila aman, selain itu ke halaman perantara /go/<slug>. */
async function handle(req: Request, ctx: { params: Promise<{ slug: string }> }, head: boolean) {
  const { slug } = await ctx.params;
  const url = new URL(req.url);
  if (RESERVED_SLUGS.includes(slug.toLowerCase())) return new Response('Tidak ditemukan', { status: 404, headers: NO_STORE });
  const q = url.searchParams.get('q') === '1';
  const go = '/go/' + encodeURIComponent(slug) + (q ? '?q=1' : '');
  const l = await linkBySlug(slug);
  if (!l) return redirect(go);
  if (effectiveLinkState(l) !== 'ok' || l.passwordHash || l.interstitial) return redirect(go);
  if (head) return redirect(l.destination);
  const info = await reqInfo();
  const meta = { source: q ? 'qr' : 'langsung', ua: info.ua, referrer: req.headers.get('referer') || '', country: info.country, ipHash: info.ipHash };
  if (l.maxClicks) {
    const ok = await recordClick(l, meta);
    if (!ok) { invalidateLinkCache(l.slug); return redirect(go); }
  } else {
    after(() => recordClick(l, meta).catch((e) => console.error(JSON.stringify({ at: 'click', msg: String(e?.message || e) }))));
  }
  return redirect(l.destination);
}
export function GET(req: Request, ctx: { params: Promise<{ slug: string }> }) { return handle(req, ctx, false); }
export function HEAD(req: Request, ctx: { params: Promise<{ slug: string }> }) { return handle(req, ctx, true); }
