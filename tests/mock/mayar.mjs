// Server tiruan API Mayar.id untuk pengujian lokal (tidak dipakai di produksi).
// node tests/mock/mayar.mjs  → http://127.0.0.1:4010/hl/v1
// POST /__pay/<id> menandai tagihan lunas (simulasi pelanggan membayar).
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
const PORT = Number(process.env.PORT || 4010);
const store = new Map();
const send = (res, code, body) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
createServer(async (req, res) => {
  let raw = ''; for await (const c of req) raw += c;
  const url = new URL(req.url, 'http://x');
  if (url.pathname.startsWith('/__pay/')) { const p = store.get(url.pathname.slice(7)); if (!p) return send(res, 404, {}); p.status = 'paid'; return send(res, 200, { ok: true }); }
  if (url.pathname === '/__last') return send(res, 200, [...store.values()].slice(-1)[0] || null);
  if (req.headers.authorization !== 'Bearer test-mayar-key') return send(res, 401, { statusCode: 401, messages: 'unauthorized' });
  if (req.method === 'POST' && url.pathname === '/hl/v1/payment/create') {
    const b = JSON.parse(raw || '{}');
    for (const k of ['name', 'email', 'amount', 'mobile', 'description', 'expiredAt']) if (b[k] == null || b[k] === '') return send(res, 400, { statusCode: 400, messages: k + ' required' });
    const id = randomUUID(), tx = randomUUID();
    store.set(id, { id, transactionId: tx, status: 'unpaid', amount: b.amount, email: b.email, name: b.name, link: 'https://mock.mayar.local/pay/' + id, redirectUrl: b.redirectUrl });
    return send(res, 200, { statusCode: 200, messages: 'success', data: { id, transaction_id: tx, transactionId: tx, link: 'https://mock.mayar.local/pay/' + id } });
  }
  const m = url.pathname.match(/^\/hl\/v1\/payment\/([0-9a-f-]{36})$/);
  if (req.method === 'GET' && m) { const p = store.get(m[1]); if (!p) return send(res, 404, { statusCode: 404, messages: 'not found' }); return send(res, 200, { statusCode: 200, messages: 'success', data: { id: p.id, status: p.status, amount: p.amount, type: 'payment_request', name: p.name, link: p.link } }); }
  send(res, 404, { statusCode: 404, messages: 'not found' });
}).listen(PORT, '127.0.0.1', () => console.log('mock mayar :' + PORT));
