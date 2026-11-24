import postgres from 'postgres';
import { ENV } from './config';

type Sql = postgres.Sql<Record<string, never>>;
const g = globalThis as unknown as { __smartsignSql?: Sql };

/**
 * Koneksi Postgres (Supabase). Di Vercel gunakan URL pooler mode transaksi (port 6543),
 * karena itu prepared statement dimatikan. Hasil kolom snake_case otomatis menjadi camelCase.
 */
export function db(): Sql {
  if (!g.__smartsignSql) {
    if (!ENV.databaseUrl) throw new Error('DATABASE_URL belum diatur');
    g.__smartsignSql = postgres(ENV.databaseUrl, {
      max: ENV.isProd ? 3 : 10,
      idle_timeout: 20,
      connect_timeout: 10,
      prepare: false,
      transform: postgres.camel,
      types: {
        // int8 → number (aman untuk hitungan/ID identity di aplikasi ini)
        int8: { to: 20, from: [20], serialize: (x: number) => String(x), parse: (x: string) => Number(x) },
        // timestamptz → string ISO dengan offset WIB, mis. 2026-11-24T21:40:46.123+07:00
        tstz: { to: 1184, from: [1184], serialize: (x: string | Date) => (x instanceof Date ? x.toISOString() : x), parse: isoOfPg },
        date: { to: 1082, from: [1082], serialize: (x: string) => x, parse: (x: string) => x }
      },
      connection: { application_name: 'smartsign', TimeZone: 'Asia/Jakarta' }
    }) as unknown as Sql;
  }
  return g.__smartsignSql;
}
function isoOfPg(x: string): string {
  // format Postgres: 2026-11-24 21:40:46.123456+07
  const m = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})(\.\d+)?([+-]\d{2})(?::?(\d{2}))?$/.exec(x);
  if (!m) return x;
  const frac = m[3] ? m[3].slice(0, 4) : '';
  return m[1] + 'T' + m[2] + frac + m[4] + ':' + (m[5] || '00');
}
export type Tx = postgres.TransactionSql<Record<string, never>>;
export type Q = Sql | Tx;
