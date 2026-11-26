import { spaPage } from '@/server/web/html';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
/** Verifikasi publik barcode TTD: /ttd/v/<kode> */
export async function GET(_req: Request, ctx: { params: Promise<{ code: string }> }) { return spaPage('qverify', (await ctx.params).code); }
