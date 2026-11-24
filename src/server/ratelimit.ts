import { db } from './db';
import { AppError } from './errors';

/** Naikkan penghitung; lempar RATE_LIMIT bila melewati batas dalam jendela waktu. */
export async function rateLimit(key: string, limit: number, windowSec: number, msg?: string) {
  const [r] = await db()`select rate_hit(${key}, ${windowSec}) as n`;
  if (Number(r.n) > limit) throw new AppError('RATE_LIMIT', msg || 'Terlalu banyak permintaan. Coba lagi beberapa saat lagi.');
}
export async function rateCount(key: string, windowSec: number): Promise<number> {
  const [r] = await db()`select rate_peek(${key}, ${windowSec}) as n`;
  return Number(r.n);
}
export async function rateBump(key: string, windowSec: number): Promise<number> {
  const [r] = await db()`select rate_hit(${key}, ${windowSec}) as n`;
  return Number(r.n);
}
export async function rateReset(key: string) { await db()`delete from rate_limits where key = ${key}`; }
