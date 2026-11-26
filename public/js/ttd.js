/* SmartSign: TTD Realtime (tautan tanda tangan berbatas waktu untuk pejabat, tanpa PDF) */
'use strict';

const QS_BADGE = { pending: ['sent', 'Menunggu'], signed: ['signed', 'Sudah ditandatangani'], expired: ['expired', 'Kedaluwarsa'], cancelled: ['voided', 'Dibatalkan'] };
const QS_HOURS = [['1', '1 jam'], ['2', '2 jam'], ['4', '4 jam'], ['8', '8 jam (disarankan)'], ['12', '12 jam'], ['24', '24 jam'], ['48', '2 hari'], ['72', '3 hari']];
const QS_POLL_MS = 5000;
function qsBadge(r) { const m = QS_BADGE[r.status] || ['info', r.statusLabel]; return badge(m[0], m[1]); }
function qsRemain(iso) {
  const left = new Date(iso).getTime() - Date.now();
  if (left <= 0) return 'waktu habis';
  const hh = Math.floor(left / 3600000), mm = Math.max(1, Math.floor((left % 3600000) / 60000));
  return 'sisa ' + (hh ? hh + ' jam ' : '') + mm + ' menit';
}
function qsWaUrl(r) {
  return 'https://wa.me/?text=' + encodeURIComponent('Yth. ' + r.signerName + ' (' + r.signerTitle + '),\nMohon kesediaannya menandatangani secara elektronik untuk keperluan: ' + r.purpose +
    '\n\n' + r.link + '\n\nTautan berlaku sampai ' + dt(r.expiresAt) + '.' + (r.hasPin ? ' PIN akan dikirim terpisah.' : ''));
}
function qsSafeName(s) { return String(s || 'ttd').replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '-').slice(0, 40) || 'ttd'; }
function qsLoadImg(src) { return new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => rej(new Error('Gambar gagal dimuat.')); i.src = src; }); }
function qsDownloadCanvas(cv, name) { cv.toBlob((b) => downloadBlob(b, name), 'image/png'); }
/** QR digambar langsung ke canvas (tanpa SVG) agar canvas tidak "tercemar" dan bisa diekspor. */
async function qsQrCanvas(text, size) {
  const m = await qrMatrix(text, 'M');
  const margin = 2, total = m.n + margin * 2, mod = Math.floor(size / total), px = mod * total;
  const cv = document.createElement('canvas'); cv.width = px; cv.height = px;
  const ctx = cv.getContext('2d');
  ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, px, px); ctx.fillStyle = '#000000';
  for (let r = 0; r < m.n; r++) for (let c = 0; c < m.n; c++) if (m.dark(r, c)) ctx.fillRect((c + margin) * mod, (r + margin) * mod, mod, mod);
  return cv;
}
function qsFitText(ctx, text, maxW, weight, size, minSize) {
  let s = size;
  ctx.font = weight + ' ' + s + 'px Inter, "Segoe UI", Arial, sans-serif';
  while (ctx.measureText(text).width > maxW && s > minSize) { s -= 1; ctx.font = weight + ' ' + s + 'px Inter, "Segoe UI", Arial, sans-serif'; }
  let t = text;
  while (ctx.measureText(t).width > maxW && t.length > 4) t = t.slice(0, -2);
  return t === text ? t : t.slice(0, -1) + '…';
}
/** Barcode TTD: QR verifikasi + keterangan penanda tangan, latar putih. */
async function qsBarcodeCanvas(r) {
  const qr = await qsQrCanvas(r.verifyUrl, 560);
  const W = 640, H = qr.height + 230;
  const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
  const ctx = cv.getContext('2d');
  ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, W, H);
  ctx.drawImage(qr, (W - qr.width) / 2, 20);
  ctx.fillStyle = '#111827'; ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
  let y = qr.height + 58;
  ctx.font = '400 20px Inter, "Segoe UI", Arial, sans-serif'; ctx.fillText('Ditandatangani secara elektronik oleh', W / 2, y);
  y += 40; ctx.fillText(qsFitText(ctx, r.signerName, W - 40, '700', 30, 18), W / 2, y);
  y += 34; ctx.fillText(qsFitText(ctx, r.signerTitle, W - 40, '400', 22, 14), W / 2, y);
  y += 34; ctx.fillStyle = '#4b5563'; ctx.font = '400 17px Inter, "Segoe UI", Arial, sans-serif'; ctx.fillText(dt(r.signedAt) + ' · ' + r.code, W / 2, y);
  return cv;
}
/** Spesimen: barcode + gambar tanda tangan + nama + jabatan (latar transparan, siap ditempel di surat). */
async function qsSpecimenCanvas(r) {
  const qr = await qsQrCanvas(r.verifyUrl, 300);
  const sig = await qsLoadImg(r.signatureImage);
  const W = 1100, H = 400, X = qr.width + 50, TW = W - X - 20;
  const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
  const ctx = cv.getContext('2d');
  ctx.drawImage(qr, 20, (H - qr.height) / 2);
  ctx.fillStyle = '#111827'; ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
  ctx.font = '400 20px Inter, "Segoe UI", Arial, sans-serif';
  ctx.fillText(qsFitText(ctx, 'Ditandatangani secara elektronik pada ' + dt(r.signedAt), TW, '400', 20, 14), X, 44);
  const boxW = Math.min(TW, 620), boxH = 170, sc = Math.min(boxW / sig.width, boxH / sig.height, 1.6);
  ctx.drawImage(sig, X, 60 + (boxH - sig.height * sc) / 2, sig.width * sc, sig.height * sc);
  const name = qsFitText(ctx, r.signerName, TW, '700', 34, 20);
  ctx.fillText(name, X, 285);
  const nw = ctx.measureText(name).width;
  ctx.fillRect(X, 293, nw, 2);
  ctx.fillText(qsFitText(ctx, r.signerTitle, TW, '400', 26, 15), X, 332);
  ctx.fillStyle = '#4b5563';
  ctx.fillText(qsFitText(ctx, 'Kode ' + r.code + ' · verifikasi: pindai barcode', TW, '400', 18, 12), X, 368);
  return cv;
}

/* ================= Halaman aplikasi ================= */
Pages.ttd = (c, r) => (r.id ? qsDetail(c, r.id) : qsList(c, r));

function qsUpsell() {
  return h('div', { class: 'callout warn', style: 'margin-bottom:16px' }, h('b', null, 'Fitur berbayar. '),
    'Membuat link tanda tangan tersedia untuk paket Pro 3 Bulan dan Lifetime. ', h('a', { href: '#/billing' }, 'Lihat paket'));
}

function qsList(c, r) {
  const me = State.me;
  const canCreate = can.edit() && me.esignEnabled;
  const st = { status: (r.params && r.params.status) || '', page: 1, q: '' };
  const list = h('div', { 'aria-live': 'polite' });
  const summary = h('div', { class: 'small muted' });
  const reload = () => load(false);
  c.appendChild(pageHead('TTD Realtime', 'Buat link tanda tangan untuk pejabat. Begitu ditandatangani, hasilnya langsung muncul di sini dan bisa diunduh sebagai tanda tangan digital + barcode.',
    canCreate ? h('button', { class: 'btn primary', onclick: () => qsCreate(reload) }, icon('plus', 16), 'Buat link tanda tangan') : null));
  if (!me.esignEnabled) c.appendChild(qsUpsell());
  const tabs = h('div', { class: 'tabs', role: 'tablist' });
  const drawTabs = () => clear(tabs).append(...[['', 'Semua'], ['pending', 'Menunggu'], ['signed', 'Selesai'], ['expired', 'Kedaluwarsa'], ['cancelled', 'Dibatalkan']]
    .map((t) => h('button', { role: 'tab', 'aria-selected': String(st.status === t[0]), onclick: () => { st.status = t[0]; st.page = 1; drawTabs(); load(false); } }, t[1])));
  drawTabs();
  const q = h('input', { type: 'search', placeholder: 'Cari nama, jabatan, tujuan, atau kode…', 'aria-label': 'Cari permintaan tanda tangan' });
  q.addEventListener('input', debounce(() => { st.q = q.value.trim(); st.page = 1; load(false); }, 350));
  c.appendChild(h('div', { class: 'card' }, tabs, h('div', { class: 'toolbar' }, q), summary, list));

  let known = null, timer = null, sig = '';
  const render = (pg) => {
    const pend = pg.counts.pending, done = pg.counts.signed;
    summary.textContent = pend + ' menunggu · ' + done + ' selesai' + (pend ? ' · diperbarui otomatis tiap ' + QS_POLL_MS / 1000 + ' detik' : '');
    clear(list);
    if (!pg.rows.length) {
      return list.appendChild(emptyState('sign', st.status || st.q ? 'Tidak ada data' : 'Belum ada permintaan tanda tangan',
        st.status || st.q ? 'Ubah filter atau kata kunci pencarian.' : 'Buat link, kirim ke pejabat lewat WhatsApp atau email, lalu pantau hasilnya di sini.',
        canCreate && !st.status && !st.q ? h('button', { class: 'btn primary', onclick: () => qsCreate(reload) }, icon('plus', 16), 'Buat link tanda tangan') : null));
    }
    list.append(h('div', { class: 'table-wrap', style: 'margin-top:10px' }, h('table', { class: 'responsive' },
      h('thead', null, h('tr', null, ['Penanda tangan', 'Tujuan', 'Status', 'Dibuat', 'Aksi'].map((t) => h('th', { text: t })))),
      h('tbody', null, pg.rows.map((x) => h('tr', null,
        tdm('Penanda tangan', h('b', { text: x.signerName }), h('div', { class: 'small muted', text: x.signerTitle })),
        tdm('Tujuan', h('div', { class: 'small', style: 'max-width:280px', text: x.purpose })),
        tdm('Status', qsBadge(x), h('div', { class: 'small muted', text: x.status === 'pending' ? qsRemain(x.expiresAt) + (x.openedAt ? ' · sudah dibuka' : '') : x.status === 'signed' ? dt(x.signedAt) : '' })),
        tdm('Dibuat', h('div', { class: 'small', text: dt(x.createdAt) }), x.createdBy ? h('div', { class: 'small muted', text: 'oleh ' + x.createdBy }) : null),
        tdm('Aksi', h('div', { class: 'row', style: 'justify-content:flex-end;flex-wrap:wrap' },
          x.link ? h('button', { class: 'btn sm', onclick: () => copyText(x.link) }, icon('copy', 14), 'Salin link') : null,
          h('a', { class: 'btn sm' + (x.status === 'signed' ? ' primary' : ''), href: '#/ttd/' + x.id }, x.status === 'signed' ? 'Unduh' : 'Detail')))))))),
    pager(pg, (p) => { st.page = p; load(false); }));
  };
  const load = async (silent) => {
    if (!silent) clear(list).appendChild(skeleton(4));
    try {
      const pg = await callApi('qsign.list', { page: st.page, pageSize: 20, status: st.status, q: st.q });
      const s = JSON.stringify(pg.rows.map((x) => [x.id, x.status, x.openedAt])) + JSON.stringify(pg.counts);
      if (known) pg.rows.forEach((x) => { if (x.status === 'signed' && known[x.id] && known[x.id] !== 'signed') toast(x.signerName + ' sudah menandatangani.', 'ok'); });
      known = {}; pg.rows.forEach((x) => { known[x.id] = x.status; });
      if (!silent || s !== sig) render(pg); else summary.textContent = summary.textContent; // tidak ada perubahan
      sig = s;
      schedule(pg.counts.pending > 0);
    } catch (e) { if (!silent) clear(list).appendChild(errorState(e, () => load(false))); else schedule(true); }
  };
  const schedule = (on) => {
    clearTimeout(timer);
    if (!on) return;
    timer = setTimeout(() => { if (document.body.contains(list) && State.route === 'ttd') { if (!document.hidden) load(true); else schedule(true); } }, QS_POLL_MS);
  };
  load(false);
}

function qsCreate(onDone) {
  const form = h('form', { novalidate: true, class: 'stack' },
    field('signerName', 'Nama pejabat / penanda tangan', { required: true, maxlength: 120, autocomplete: 'off', placeholder: 'mis. Dr. Siti Rahmawati, M.Pd.' }),
    field('signerTitle', 'Jabatan', { required: true, maxlength: 160, autocomplete: 'off', placeholder: 'mis. Kepala Bagian Umum' }),
    field('purpose', 'Tujuan tanda tangan', { type: 'textarea', required: true, maxlength: 500, rows: 3, placeholder: 'mis. Pengesahan Berita Acara Serah Terima BMN No. 12/2026' }),
    h('div', { class: 'form-grid' },
      field('hours', 'Link berlaku selama', { type: 'select', options: QS_HOURS, value: '8' }, 'Dihitung sejak link dibuat.'),
      field('pin', 'PIN (opsional)', { inputmode: 'numeric', maxlength: 8, autocomplete: 'off', placeholder: '4–8 angka' }, 'Kirim PIN lewat jalur berbeda dari link.')));
  const ok = h('button', { class: 'btn primary', type: 'button' }, 'Buat link');
  const m = openModal({ title: 'Buat link tanda tangan', body: form, foot: [h('button', { class: 'btn', dataset: { close: '1' } }, 'Batal'), ok] });
  const submit = () => withBusy(ok, async () => {
    try {
      const res = await callApi('qsign.create', formData(form));
      m.close(true);
      if (onDone) onDone();
      qsShareModal(res.request);
    } catch (e) { showErrors(form, e); }
  });
  ok.addEventListener('click', submit);
  form.addEventListener('submit', (e) => { e.preventDefault(); submit(); });
}

function qsShareBox(r) {
  const qrBox = h('div', { class: 'qr-stage', style: 'min-height:180px;background:#fff' });
  qsQrCanvas(r.link, 360).then((cv) => qrBox.replaceChildren(h('img', { src: cv.toDataURL('image/png'), alt: 'QR link tanda tangan', style: 'width:180px;height:180px' }))).catch(() => qrBox.remove());
  return h('div', { class: 'stack' },
    h('div', { class: 'field' }, h('label', { for: 'qs-link' }, 'Link untuk penanda tangan'),
      h('div', { class: 'row', style: 'flex-wrap:nowrap' }, h('input', { id: 'qs-link', value: r.link, readonly: true, onfocus: (e) => e.target.select() }),
        h('button', { class: 'btn', type: 'button', onclick: () => copyText(r.link) }, icon('copy', 16), 'Salin'))),
    h('div', { class: 'row', style: 'flex-wrap:wrap' },
      h('a', { class: 'btn primary', href: qsWaUrl(r), target: '_blank', rel: 'noopener noreferrer' }, 'Kirim lewat WhatsApp'),
      h('a', { class: 'btn', href: 'mailto:?subject=' + encodeURIComponent('Permohonan tanda tangan: ' + r.purpose) + '&body=' + encodeURIComponent('Yth. ' + r.signerName + ',\n\nMohon tanda tangan untuk: ' + r.purpose + '\n' + r.link + '\n\nBerlaku sampai ' + dt(r.expiresAt) + '.') }, 'Kirim lewat email')),
    h('div', { class: 'callout info' }, icon('clock', 16), ' Berlaku sampai ', h('b', { text: dt(r.expiresAt) }), ' (' + qsRemain(r.expiresAt) + '). Link hanya bisa dipakai sekali.' + (r.hasPin ? ' Jangan kirim PIN bersama link.' : '')),
    h('div', { style: 'text-align:center' }, qrBox, h('div', { class: 'small muted' }, 'Penanda tangan juga bisa memindai QR ini dari layar Anda.')));
}

function qsShareModal(r) {
  openModal({ title: 'Link tanda tangan siap dibagikan', body: qsShareBox(r), foot: [h('a', { class: 'btn', href: '#/ttd/' + r.id, dataset: { close: '1' } }, 'Lihat detail'), h('button', { class: 'btn primary', dataset: { close: '1' } }, 'Selesai')] });
}

function qsRenew(r, after) {
  const form = h('form', { novalidate: true }, field('hours', 'Link baru berlaku selama', { type: 'select', options: QS_HOURS, value: String(r.validHours || 8) }));
  const ok = h('button', { class: 'btn primary', type: 'button' }, 'Buat link baru');
  const m = openModal({ title: 'Buat ulang link', body: h('div', null, h('p', { class: 'muted' }, 'Link lama langsung tidak berlaku. Kirim link baru ke penanda tangan.'), form),
    foot: [h('button', { class: 'btn', dataset: { close: '1' } }, 'Batal'), ok] });
  ok.addEventListener('click', () => withBusy(ok, async () => {
    try { const res = await callApi('qsign.renew', { id: r.id, hours: formData(form).hours }); m.close(true); after(); qsShareModal(res.request); } catch (e) { showErrors(form, e); }
  }));
}

function qsDetail(c, id) {
  const box = h('div');
  c.appendChild(box);
  let timer = null;
  const load = (silent) => {
    const run = async () => {
      const res = await callApi('qsign.get', { id: id });
      return res.request;
    };
    if (!silent) return loadInto(box, run, render);
    run().then((r) => { if (r.status !== 'pending') { clear(box); render(r); if (r.status === 'signed') toast(r.signerName + ' sudah menandatangani.', 'ok'); } else poll(); }).catch(() => poll());
  };
  const poll = () => { clearTimeout(timer); timer = setTimeout(() => { if (document.body.contains(box) && State.route === 'ttd' && State.params.id === id) { if (!document.hidden) load(true); else poll(); } }, QS_POLL_MS); };
  const render = (r) => {
    box.appendChild(pageHead(r.signerName, r.signerTitle, h('a', { class: 'btn', href: '#/ttd' }, '‹ Kembali')));
    const info = h('div', { class: 'card' }, h('dl', { class: 'kv' },
      h('dt', null, 'Status'), h('dd', null, qsBadge(r), r.status === 'pending' ? h('span', { class: 'small muted', style: 'margin-left:8px', text: qsRemain(r.expiresAt) + (r.openedAt ? ' · dibuka ' + rel(r.openedAt) : ' · belum dibuka') }) : null),
      h('dt', null, 'Tujuan'), h('dd', { text: r.purpose }),
      h('dt', null, 'Dibuat'), h('dd', { text: dt(r.createdAt) + (r.createdBy ? ' oleh ' + r.createdBy : '') }),
      r.status === 'signed' ? [h('dt', null, 'Ditandatangani'), h('dd', { text: dt(r.signedAt) }), h('dt', null, 'Perangkat'), h('dd', { text: r.signerDevice || '–' }),
        h('dt', null, 'Kode verifikasi'), h('dd', null, h('code', { text: r.code })), h('dt', null, 'Sidik jari (SHA-256)'), h('dd', null, h('code', { class: 'small', style: 'word-break:break-all', text: r.recordHash }))]
        : [h('dt', null, 'Berlaku sampai'), h('dd', { text: dt(r.expiresAt) }), h('dt', null, 'PIN'), h('dd', { text: r.hasPin ? 'Ya' : 'Tidak' })]));
    box.appendChild(info);
    if (r.status === 'pending') {
      box.appendChild(h('div', { class: 'card' }, h('h2', null, 'Bagikan link'), qsShareBox(r)));
      if (can.edit()) box.appendChild(h('div', { class: 'row', style: 'margin-top:16px;flex-wrap:wrap' },
        h('button', { class: 'btn', onclick: () => qsRenew(r, () => { clear(box); load(false); }) }, 'Buat ulang link'),
        h('button', { class: 'btn danger', onclick: async (e) => {
          const b = e.currentTarget;
          if (!(await confirmDialog('Batalkan permintaan?', 'Link untuk ' + r.signerName + ' langsung tidak berlaku.', 'Batalkan', true))) return;
          withBusy(b, async () => { try { await callApi('qsign.cancel', { id: r.id }); toast('Permintaan dibatalkan.', 'ok'); clear(box); load(false); } catch (er) { toastErr(er); } });
        } }, 'Batalkan')));
      poll();
    } else if (r.status !== 'signed') {
      box.appendChild(h('div', { class: 'callout warn', style: 'margin-top:16px' }, r.status === 'expired' ? 'Link sudah kedaluwarsa sebelum ditandatangani.' : 'Permintaan ini dibatalkan.',
        can.edit() && State.me.esignEnabled ? h('div', { style: 'margin-top:8px' }, h('button', { class: 'btn sm primary', onclick: () => qsRenew(r, () => { clear(box); load(false); }) }, 'Buat link baru')) : null));
    } else {
      const prevSig = h('div', { class: 'qs-sig' }, h('img', { src: r.signatureImage, alt: 'Tanda tangan ' + r.signerName }));
      const prevSpec = h('div', { class: 'qs-spec' }, skeleton(2));
      const prevBar = h('div', { class: 'qs-bar' }, skeleton(2));
      qsSpecimenCanvas(r).then((cv) => prevSpec.replaceChildren(h('img', { src: cv.toDataURL('image/png'), alt: 'Spesimen tanda tangan dengan barcode' }))).catch((e) => prevSpec.replaceChildren(errorState(e)));
      qsBarcodeCanvas(r).then((cv) => prevBar.replaceChildren(h('img', { src: cv.toDataURL('image/png'), alt: 'Barcode TTD digital' }))).catch((e) => prevBar.replaceChildren(errorState(e)));
      const base = qsSafeName(r.signerName) + '-' + r.code;
      const dl = (fn, name) => async (e) => withBusy(e.currentTarget, async () => { try { qsDownloadCanvas(await fn(r), name); } catch (er) { toastErr(er); } });
      box.appendChild(h('div', { class: 'card' }, h('h2', null, 'Unduh tanda tangan digital'),
        h('div', { class: 'qs-grid' },
          h('div', { class: 'stack' }, h('b', null, 'Spesimen (tanda tangan + barcode)'), prevSpec,
            h('button', { class: 'btn primary', onclick: dl(qsSpecimenCanvas, 'spesimen-' + base + '.png') }, icon('download', 16), 'Unduh spesimen PNG')),
          h('div', { class: 'stack' }, h('b', null, 'Barcode TTD'), prevBar,
            h('button', { class: 'btn', onclick: dl(qsBarcodeCanvas, 'barcode-' + base + '.png') }, icon('download', 16), 'Unduh barcode PNG')),
          h('div', { class: 'stack' }, h('b', null, 'Gambar tanda tangan'), prevSig,
            h('button', { class: 'btn', onclick: () => downloadBlob(dataUrlBlob(r.signatureImage), 'ttd-' + base + '.png') }, icon('download', 16), 'Unduh tanda tangan PNG'))),
        h('div', { class: 'row', style: 'margin-top:14px;flex-wrap:wrap' },
          h('button', { class: 'btn sm', onclick: () => copyText(r.verifyUrl) }, icon('copy', 14), 'Salin link verifikasi'),
          h('a', { class: 'btn sm', href: r.verifyUrl, target: '_blank', rel: 'noopener' }, icon('ext', 14), 'Buka halaman verifikasi')),
        h('p', { class: 'small muted', style: 'margin-top:10px' }, 'Barcode berisi link verifikasi publik. Siapa pun yang memindainya melihat nama, jabatan, tujuan, dan waktu tanda tangan (tanpa gambar tanda tangan). Gambar PNG berlatar transparan, siap ditempel di Word atau PDF.')));
    }
  };
  load(false);
}
function dataUrlBlob(u) {
  const [head, b64] = u.split(',');
  const bin = atob(b64); const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return new Blob([arr], { type: (head.match(/data:([^;]+)/) || [])[1] || 'image/png' });
}

/* ================= Halaman publik: penanda tangan ================= */
PublicPages.qsign = (root) => {
  const card = publicFrame(root, 'Permintaan tanda tangan', false);
  const body = h('div');
  card.appendChild(body);
  if (!BOOT.token) return body.appendChild(h('div', { class: 'callout bad' }, 'Link tidak valid. Buka kembali link yang Anda terima.'));
  const done = (info) => {
    clear(body).append(h('div', { class: 'callout ok' }, h('b', null, 'Terima kasih. '), 'Tanda tangan Anda sudah diterima' + (info.signedAt ? ' pada ' + dt(info.signedAt) : '') + '.'),
      info.verifyUrl ? h('p', { class: 'small', style: 'margin-top:12px' }, 'Kode verifikasi ', h('code', { text: info.code }), '. ', h('a', { href: info.verifyUrl, text: 'Lihat bukti verifikasi' })) : null,
      h('p', { class: 'small muted', style: 'margin-top:12px' }, 'Halaman ini boleh ditutup.'));
  };
  loadInto(body, () => rawApi('qsign.open', { token: BOOT.token }), (info) => {
    body.append(h('dl', { class: 'kv' },
      h('dt', null, 'Diminta oleh'), h('dd', { text: info.organization + (info.requester ? ' · ' + info.requester : '') }),
      h('dt', null, 'Nama'), h('dd', null, h('b', { text: info.signerName })),
      h('dt', null, 'Jabatan'), h('dd', { text: info.signerTitle }),
      h('dt', null, 'Tujuan'), h('dd', { text: info.purpose }),
      info.status === 'pending' ? [h('dt', null, 'Berlaku sampai'), h('dd', { text: dt(info.expiresAt) + ' (' + qsRemain(info.expiresAt) + ')' })] : null));
    if (info.status === 'signed') return done(info);
    if (info.status !== 'pending') return body.appendChild(h('div', { class: 'callout bad', style: 'margin-top:12px' },
      info.status === 'expired' ? 'Link ini sudah kedaluwarsa. Minta link baru kepada pengirim.' : 'Permintaan tanda tangan ini sudah dibatalkan pengirim.'));

    let mode = 'draw', pad = null, typed = null;
    const tabs = h('div', { class: 'tabs', role: 'tablist' });
    const pane = h('div');
    const drawPane = (k) => {
      mode = k; clear(tabs); clear(pane);
      [['draw', 'Gambar'], ['type', 'Ketik']].forEach((t) => tabs.appendChild(h('button', { type: 'button', role: 'tab', 'aria-selected': String(t[0] === k), onclick: () => drawPane(t[0]) }, t[1])));
      if (k === 'draw') {
        const cv = h('canvas', { class: 'sig-pad', 'aria-label': 'Area menggambar tanda tangan. Gunakan jari, stylus, atau mouse.' });
        pane.append(cv, h('div', { class: 'row', style: 'margin-top:8px' }, h('button', { class: 'btn sm', type: 'button', onclick: () => pad && pad.clear() }, 'Hapus'),
          h('span', { class: 'small muted' }, 'Gambar tanda tangan Anda di kotak di atas.')));
        setTimeout(() => { pad = signaturePad(cv); }, 30);
      } else {
        const style = h('select', { id: 'qs-style', 'aria-label': 'Gaya huruf' }, h('option', { value: 'a' }, 'Tulisan tangan'), h('option', { value: 'b' }, 'Serif miring'), h('option', { value: 'c' }, 'Santai'));
        const prev = h('div', { class: 'qr-stage', style: 'min-height:110px;background:#fff' });
        const upd = () => { typed = typedSignaturePng(info.signerName, style.value); clear(prev); if (typed) prev.appendChild(h('img', { src: typed, alt: 'Pratinjau tanda tangan', style: 'max-height:90px' })); };
        style.addEventListener('change', upd);
        pane.append(h('div', { class: 'field' }, h('label', { for: 'qs-style' }, 'Gaya tulisan untuk "' + info.signerName + '"'), style), prev);
        upd();
      }
    };
    const form = h('form', { novalidate: true, class: 'stack', style: 'margin-top:16px' },
      info.needPin ? field('pin', 'PIN dari pengirim', { inputmode: 'numeric', maxlength: 8, autocomplete: 'one-time-code', required: true }) : null,
      h('div', { class: 'field' }, h('label', null, 'Tanda tangan'), tabs, pane, h('div', { class: 'err', id: 'e-signature', 'aria-live': 'polite' })),
      checkField('consent', info.consentText, false));
    const btn = h('button', { class: 'btn primary', type: 'submit', style: 'width:100%' }, 'Kirim tanda tangan');
    form.appendChild(btn);
    body.appendChild(form);
    drawPane('draw');
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      withBusy(btn, async () => {
        const f = formData(form);
        const png = mode === 'draw' ? (pad && !pad.isEmpty() ? pad.toPng() : null) : typed;
        if (!png) return showErrors(form, { fields: { signature: 'Tanda tangan masih kosong.' } });
        if (!f.consent) return showErrors(form, { fields: { consent: 'Centang pernyataan untuk melanjutkan.' } });
        try { done(await rawApi('qsign.submit', { token: BOOT.token, pin: f.pin || '', consent: true, signatureImage: png, signatureType: mode })); }
        catch (er) { showErrors(form, er); }
      });
    });
  });
};

/* ================= Halaman publik: verifikasi barcode ================= */
PublicPages.qverify = (root) => {
  const card = publicFrame(root, 'Verifikasi tanda tangan', false);
  const result = h('div', { 'aria-live': 'polite' });
  const form = h('form', { novalidate: true, class: 'row', style: 'flex-wrap:nowrap;align-items:flex-end;margin-bottom:14px' },
    h('div', { class: 'field', style: 'margin:0;flex:1;min-width:0' }, h('label', { for: 'qv-code' }, 'Kode tanda tangan'), h('input', { id: 'qv-code', name: 'code', value: BOOT.token || '', placeholder: 'TTD-XXXXXXXXXX', maxlength: 30 })),
    h('button', { class: 'btn primary', type: 'submit' }, 'Periksa'));
  const run = (code) => loadInto(result, () => rawApi('qsign.verify', { code: code }), (r) => {
    if (!r.valid) return result.appendChild(h('div', { class: 'callout bad' }, h('b', null, 'Belum sah. '), 'Kode ' + r.code + ' terdaftar tetapi statusnya: ' + r.statusLabel + '.'));
    result.append(h('div', { class: 'callout ok' }, icon('check', 18), h('b', null, ' Tanda tangan elektronik tercatat dan sah'), ' di ' + BOOT.appName + '.'),
      h('dl', { class: 'kv', style: 'margin-top:12px' },
        h('dt', null, 'Nama'), h('dd', null, h('b', { text: r.signerName })), h('dt', null, 'Jabatan'), h('dd', { text: r.signerTitle }),
        h('dt', null, 'Tujuan'), h('dd', { text: r.purpose }), h('dt', null, 'Instansi / pengirim'), h('dd', { text: r.organization }),
        h('dt', null, 'Waktu tanda tangan'), h('dd', { text: dt(r.signedAt) }), h('dt', null, 'Kode'), h('dd', null, h('code', { text: r.code })),
        h('dt', null, 'Sidik jari (SHA-256)'), h('dd', null, h('code', { class: 'small', style: 'word-break:break-all', text: r.recordHash }))),
      h('p', { class: 'small muted', style: 'margin-top:12px' }, 'Tanda tangan elektronik tidak tersertifikasi (bukan PSrE), dibuat lewat link sekali pakai yang berbatas waktu. Pastikan nama dan tujuan di atas sesuai dengan dokumen yang Anda pegang.'));
  });
  form.addEventListener('submit', (e) => { e.preventDefault(); const v = $('#qv-code', form).value.trim(); if (v) run(v); });
  card.append(form, result, h('div', { class: 'divider' }), h('button', { class: 'btn ghost', onclick: goLogin }, 'Masuk ke aplikasi'));
  if (BOOT.token) run(BOOT.token);
};
