import { ENV } from '@/server/config';
import { runDailyJob } from '@/server/services/admin';
import { safeEqual } from '@/server/util';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/** Dipanggil Vercel Cron (Authorization: Bearer CRON_SECRET). */
export async function GET(req: Request) {
  const want = 'Bearer ' + (ENV.cronSecret || '');
  const got = req.headers.get('authorization') || '';
  if (!ENV.cronSecret || !safeEqual(got, want)) return new Response('Unauthorized', { status: 401 });
  const res = await runDailyJob();
  return Response.json({ ok: true, res }, { headers: { 'cache-control': 'no-store' } });
}
