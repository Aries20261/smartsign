import { spaPage } from '@/server/web/html';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export async function GET(_req: Request, ctx: { params: Promise<{ token: string }> }) { return spaPage('invite', (await ctx.params).token); }
