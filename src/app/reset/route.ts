import { spaPage } from '@/server/web/html';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export function GET() { return spaPage('reset'); }
