/* SmartSign: dokumen & tanda tangan, scanner, tim, keamanan, audit, pengaturan, platform */
'use strict';
/* ============ E-Signature, Scanner, Tim, Keamanan, Audit, Pengaturan, Platform ============ */
const AUTH_LABEL = { otp: 'OTP email', otp_code: 'OTP email + kode akses' };
const EVENT_LABEL = { uploaded: 'Dokumen diunggah', sent: 'Dokumen dikirim', invited: 'Undangan dikirim', reminder_sent: 'Pengingat dikirim', otp_sent: 'Kode OTP dikirim',
  otp_locked: 'OTP dikunci (terlalu banyak salah)', authenticated: 'Penanda tangan terautentikasi', viewed: 'Dokumen dilihat', signed: 'Ditandatangani', declined: 'Ditolak',
  voided: 'Dibatalkan', expired: 'Kedaluwarsa', completed: 'Selesai — sertifikat diterbitkan', finalized: 'PDF final dibuat', certificate_downloaded: 'Sertifikat diunduh' };
const FIELD_LABEL = { signature: 'Tanda tangan', initial: 'Paraf', name: 'Nama', date: 'Tanggal', text: 'Teks' };
const FIELD_SIZE = { signature: [0.26, 0.07], initial: [0.1, 0.05], name: [0.24, 0.03], date: [0.16, 0.03], text: [0.24, 0.03] };

/* ================= Daftar dokumen ================= */
Pages.docs = (c, r) => {
  if (r.id === 'new' && !(State.me && State.me.esignEnabled)) { location.hash = '#/billing'; return; }
  if (r.id === 'new') return docNew(c);
  if (r.id && r.sub === 'edit') return docEdit(c, r.id);
  if (r.id) return docDetail(c, r.id);
  const st = { page: 1, q: '', status: r.params.status || '' };
  const esign = !!(State.me && State.me.esignEnabled);
  c.appendChild(pageHead('E-Signature', 'Kirim PDF untuk ditandatangani dengan OTP email, persetujuan eksplisit, dan jejak audit berantai.',
    can.edit() && esign ? [h('a', { class: 'btn primary', href: '#/docs/new' }, icon('plus', 16), 'Dokumen baru')] : null));
  if (!esign) c.appendChild(h('div', { class: 'callout warn', style: 'margin-bottom:16px' }, h('b', null, 'Fitur berbayar. '),
    'Mengirim dokumen untuk ditandatangani klien tersedia di paket Pro 3 Bulan (Rp50.000) dan Lifetime (Rp100.000). ',
    h('a', { href: '#/billing' }, 'Lihat paket')));
  c.appendChild(h('div', { class: 'callout info', style: 'margin-bottom:16px' }, h('b', null, 'Jenis tanda tangan: '), BOOT.assurance + '. ',
    'Bukan tanda tangan digital tersertifikasi PSrE. Untuk dokumen bernilai hukum tinggi, gunakan penyelenggara sertifikasi elektronik resmi.'));
  const q = h('input', { type: 'search', placeholder: 'Cari judul, kode, atau penanda tangan…', 'aria-label': 'Cari dokumen' });
  const status = h('select', { 'aria-label': 'Filter status' }, [['', 'Semua status'], ['waiting', 'Menunggu tanda tangan'], ['draft', 'Draf'], ['completed', 'Selesai'], ['declined', 'Ditolak'], ['expired', 'Kedaluwarsa'], ['voided', 'Dibatalkan']]
    .map((o) => h('option', { value: o[0], selected: o[0] === st.status ? true : null }, o[1])));
  const list = h('div');
  c.appendChild(h('div', { class: 'card' }, h('div', { class: 'toolbar' }, q, status), list));
  const reload = () => loadInto(list, () => callApi('doc.list', { page: st.page, pageSize: 20, q: st.q, status: st.status }), (pg) => {
    if (!pg.rows.length) return list.appendChild(emptyState('sign', st.q || st.status ? 'Tidak ada hasil' : 'Belum ada dokumen', st.q || st.status ? 'Ubah kata kunci atau filter.' : 'Unggah PDF dan tentukan penanda tangan untuk memulai.',
      can.edit() && !st.q ? h('a', { class: 'btn primary', href: '#/docs/new' }, 'Dokumen baru') : null));
    list.appendChild(h('div', { class: 'table-wrap' }, h('table', { class: 'responsive' }, h('thead', null, h('tr', null, ['Dokumen', 'Status', 'Progres', 'Penanda tangan', 'Dibuat', ''].map((t) => h('th', { text: t })))),
      h('tbody', null, pg.rows.map((dd) => h('tr', null,
        h('td', { dataset: { label: 'Dokumen' } }, h('div', null, h('a', { class: 'title', href: '#/docs/' + dd.id + (dd.status === 'draft' ? '/edit' : ''), text: dd.title }), h('div', { class: 'small mono muted', text: dd.code }))),
        h('td', { dataset: { label: 'Status' } }, badge(dd.status, dd.statusLabel)),
        h('td', { dataset: { label: 'Progres' } }, h('span', { text: dd.progress.signed + '/' + dd.progress.total })),
        h('td', { dataset: { label: 'Penanda tangan' } }, h('span', { class: 'small', text: dd.signers.map((s) => s.nama).join(', ') || '–' })),
        h('td', { dataset: { label: 'Dibuat' } }, h('span', { class: 'small', text: d(dd.createdAt) })),
        h('td', { dataset: { label: 'Aksi' } }, h('a', { class: 'btn sm', href: '#/docs/' + dd.id + (dd.status === 'draft' ? '/edit' : '') }, dd.status === 'draft' ? 'Lanjutkan' : 'Detail'))))))));
    list.appendChild(pager(pg, (p) => { st.page = p; reload(); }));
  });
  q.addEventListener('input', debounce(() => { st.q = q.value.trim(); st.page = 1; reload(); }, 350));
  status.addEventListener('change', () => { st.status = status.value; st.page = 1; reload(); });
  reload();
};
function docSteps(active) {
  return h('ol', { class: 'steps', 'aria-label': 'Langkah' }, ['1. Unggah PDF', '2. Penanda tangan & field', '3. Tinjau & kirim'].map((t, i) => h('li', { 'aria-current': i === active ? 'step' : null, class: i < active ? 'done' : '' }, (i < active ? '✓ ' : '') + t)));
}
function docNew(c) {
  if (!can.edit()) return Pages.notFound(c);
  c.appendChild(h('a', { href: '#/docs', class: 'small' }, '‹ Kembali'));
  c.appendChild(pageHead('Dokumen baru', 'Unggah PDF (maksimal ' + BOOT.maxPdfMb + ' MB). Berkas diperiksa tipe, ukuran, enkripsi, dan konten aktifnya.'));
  c.appendChild(docSteps(0));
  const info = h('div', { 'aria-live': 'polite' });
  const form = h('form', { novalidate: true },
    h('div', { class: 'field' }, h('label', { for: 'f-file' }, 'Berkas PDF *'), h('input', { id: 'f-file', name: 'file', type: 'file', accept: 'application/pdf,.pdf', required: true, 'aria-describedby': 'e-file' }), h('div', { class: 'err', id: 'e-file' })),
    field('title', 'Judul dokumen', { maxlength: 150, placeholder: 'Otomatis dari nama berkas' }), info);
  const btn = h('button', { class: 'btn primary', type: 'submit' }, icon('upload', 16), 'Unggah & lanjutkan');
  form.appendChild(btn);
  let prepared = null;
  $('#f-file', form).addEventListener('change', async (e) => {
    prepared = null; clear(info); clearErrors(form);
    const f = e.target.files[0];
    if (!f) return;
    if (!/\.pdf$/i.test(f.name) || (f.type && f.type !== 'application/pdf')) return showErrors(form, { fields: { file: 'Pilih berkas berformat PDF.' } });
    if (f.size > BOOT.maxPdfMb * 1048576) return showErrors(form, { fields: { file: 'Ukuran maksimal ' + BOOT.maxPdfMb + ' MB.' } });
    info.appendChild(skeleton(2));
    try {
      const buf = await readFileBuf(f);
      const bytesArr = new Uint8Array(buf);
      const hash = await sha256Hex(buf);
      let pages = 0, rotated = false;
      try { const pdf = await pdfOpen(bytesArr.slice()); pages = pdf.numPages; for (let i = 1; i <= Math.min(pages, 50); i++) { const pg = await pdf.getPage(i); if (pg.rotate) rotated = true; } }
      catch (er) { clear(info); return showErrors(form, { fields: { file: er && er.name === 'PasswordException' ? 'PDF berpassword tidak didukung.' : 'PDF rusak atau tidak dapat dibaca.' } }); }
      prepared = { file: f, fileName: f.name, size: f.size, clientHash: hash, pageCount: pages };
      clear(info).append(h('dl', { class: 'kv', style: 'margin-bottom:12px' }, h('dt', null, 'Berkas'), h('dd', { text: f.name + ' · ' + bytes(f.size) }), h('dt', null, 'Halaman'), h('dd', { text: String(pages) }),
        h('dt', null, 'SHA-256'), h('dd', null, h('code', { text: hash }))),
        rotated ? h('div', { class: 'callout warn' }, 'Sebagian halaman berotasi. Posisi visual tanda tangan pada PDF final bisa bergeser; bukti hash tetap berlaku.') : null);
      if (!$('#f-title', form).value) $('#f-title', form).value = f.name.replace(/\.pdf$/i, '').slice(0, 150);
    } catch (er) { clear(info); toastErr(er); }
  });
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    if (!prepared) return showErrors(form, { fields: { file: 'Pilih berkas PDF terlebih dahulu.' } });
    withBusy(btn, async () => {
      try {
        const up = await callApi('doc.uploadUrl', { fileName: prepared.fileName, size: prepared.size });
        await putUpload(up.url, prepared.file, 'application/pdf');
        const r = await callApi('doc.upload', { path: up.path, fileName: prepared.fileName, title: $('#f-title', form).value.trim(), clientHash: prepared.clientHash, pageCount: prepared.pageCount });
        toast('Dokumen diunggah.', 'ok'); App.go('docs/' + r.doc.id + '/edit');
      }
      catch (err) { showErrors(form, err); }
    });
  });
  c.appendChild(h('section', { class: 'card' }, form));
}

/* ---------- Penyiapan penanda tangan & penempatan field ---------- */
function docEdit(c, id) {
  c.appendChild(h('a', { href: '#/docs', class: 'small' }, '‹ Kembali'));
  const body = h('div');
  c.appendChild(body);
  loadInto(body, () => callApi('doc.get', { id: id }), async (dta) => {
    const doc = dta.doc;
    if (doc.status !== 'draft') { App.go('docs/' + id); return; }
    const S = { signers: doc.signers.map((s) => ({ id: s.id, nama: s.nama, email: s.email, authMethod: s.authMethod, accessCode: '', fields: s.fields })), active: 0, tool: 'signature', order: doc.signingOrder };
    if (!S.signers.length) S.signers.push({ nama: '', email: '', authMethod: 'otp', accessCode: '', fields: [] });
    body.append(pageHead(doc.title, 'Kode ' + doc.code + ' · ' + doc.pageCount + ' halaman · SHA-256 ' + maskHash(doc.originalHash)), docSteps(1));
    const meta = h('form', { novalidate: true, class: 'form-grid' },
      field('title', 'Judul', { required: true, maxlength: 150, value: doc.title }),
      field('expiresInDays', 'Berlaku (hari)', { type: 'number', min: 1, max: 90, value: Math.max(1, Math.round((new Date(doc.expiresAt) - Date.now()) / 86400000)) }),
      field('signingOrder', 'Urutan tanda tangan', { type: 'select', value: S.order, options: [['sequential', 'Berurutan (sesuai nomor)'], ['parallel', 'Bersamaan (semua sekaligus)']] }),
      field('message', 'Pesan untuk penanda tangan', { type: 'textarea', maxlength: 1000, value: doc.message || '', span: true }));
    const signerBox = h('div');
    const toolBar = h('div', { class: 'row', role: 'toolbar', 'aria-label': 'Jenis field' });
    const pagesBox = h('div', { class: 'pdf-pages' }, skeleton(6));
    const errBox = h('div', { class: 'err', id: 'e-signers', 'aria-live': 'polite' });
    body.append(h('div', { class: 'grid', style: 'grid-template-columns:minmax(0,380px) minmax(0,1fr);align-items:start' },
      h('div', { class: 'stack' }, h('section', { class: 'card' }, h('h2', null, 'Detail'), meta),
        h('section', { class: 'card' }, h('div', { class: 'card-head' }, h('h2', null, 'Penanda tangan'), h('button', { class: 'btn sm', type: 'button', onclick: () => { if (S.signers.length >= 10) return toast('Maksimal 10 penanda tangan.', 'bad'); S.signers.push({ nama: '', email: '', authMethod: 'otp', accessCode: '', fields: [] }); S.active = S.signers.length - 1; drawSigners(); drawFields(); } }, icon('plus', 14), 'Tambah')), signerBox, errBox),
        h('section', { class: 'card' }, h('h2', null, 'Tempatkan field'), h('p', { class: 'small muted' }, 'Pilih penanda tangan aktif dan jenis field, lalu klik/ketuk posisi pada halaman. Seret untuk memindahkan.'), toolBar)),
      h('section', { class: 'card', style: 'background:var(--surface-2)' }, pagesBox)));
    const actions = h('div', { class: 'row', style: 'justify-content:flex-end;margin-top:16px' },
      h('button', { class: 'btn danger', onclick: async (e) => { if (await confirmDialog('Hapus draf?', 'Draf dan berkasnya akan dihapus.', 'Hapus', true)) withBusy(e.currentTarget, async () => { try { await callApi('doc.delete', { id: id }); App.go('docs'); } catch (er) { toastErr(er); } }); } }, 'Hapus draf'),
      h('button', { class: 'btn', onclick: (e) => withBusy(e.currentTarget, () => save(false)) }, 'Simpan draf'),
      h('button', { class: 'btn primary', onclick: (e) => withBusy(e.currentTarget, () => save(true)) }, icon('sign', 16), 'Simpan & kirim'));
    body.appendChild(actions);
    if (window.matchMedia('(max-width:960px)').matches) body.querySelector('.grid').style.gridTemplateColumns = 'minmax(0,1fr)';

    function drawSigners() {
      clear(signerBox);
      S.signers.forEach((s, i) => {
        const row = h('fieldset', { style: 'border:2px solid ' + (i === S.active ? 'var(--primary)' : 'var(--border)') + ';border-radius:10px;padding:10px;margin:0 0 10px' },
          h('legend', { class: 'small' }, h('label', { class: 'check' }, h('input', { type: 'radio', name: 'activeSigner', checked: i === S.active ? true : null, onchange: () => { S.active = i; drawSigners(); drawFields(); } }), 'Penanda tangan ' + (i + 1) + (i === S.active ? ' (aktif)' : ''))),
          h('div', { class: 'field' }, h('label', { for: 'sn' + i }, 'Nama'), h('input', { id: 'sn' + i, value: s.nama, maxlength: 80, oninput: (e) => { s.nama = e.target.value; drawFields(); } })),
          h('div', { class: 'field' }, h('label', { for: 'se' + i }, 'Email'), h('input', { id: 'se' + i, type: 'email', value: s.email, maxlength: 120, oninput: (e) => { s.email = e.target.value; } })),
          h('div', { class: 'field' }, h('label', { for: 'sa' + i }, 'Autentikasi'), h('select', { id: 'sa' + i, onchange: (e) => { s.authMethod = e.target.value; drawSigners(); } },
            h('option', { value: 'otp', selected: s.authMethod === 'otp' ? true : null }, 'OTP email'), h('option', { value: 'otp_code', selected: s.authMethod === 'otp_code' ? true : null }, 'OTP email + kode akses (lebih kuat)'))),
          s.authMethod === 'otp_code' ? h('div', { class: 'field' }, h('label', { for: 'sc' + i }, 'Kode akses'), h('input', { id: 'sc' + i, value: s.accessCode, maxlength: 20, placeholder: s.id ? '(tetap, isi untuk mengganti)' : '', oninput: (e) => { s.accessCode = e.target.value; } }),
            h('div', { class: 'hint' }, 'Sampaikan kode ini lewat kanal lain (telepon/WA), bukan email.')) : null,
          h('div', { class: 'row small' }, h('span', { class: 'muted' }, s.fields.length + ' field'),
            h('button', { class: 'btn sm', type: 'button', disabled: i === 0 ? true : null, 'aria-label': 'Naikkan urutan', onclick: () => { [S.signers[i - 1], S.signers[i]] = [S.signers[i], S.signers[i - 1]]; S.active = i - 1; drawSigners(); drawFields(); } }, '↑'),
            h('button', { class: 'btn sm', type: 'button', disabled: i === S.signers.length - 1 ? true : null, 'aria-label': 'Turunkan urutan', onclick: () => { [S.signers[i + 1], S.signers[i]] = [S.signers[i], S.signers[i + 1]]; S.active = i + 1; drawSigners(); drawFields(); } }, '↓'),
            h('button', { class: 'btn sm danger', type: 'button', onclick: () => { S.signers.splice(i, 1); if (!S.signers.length) S.signers.push({ nama: '', email: '', authMethod: 'otp', accessCode: '', fields: [] }); S.active = 0; drawSigners(); drawFields(); } }, 'Hapus')));
        signerBox.appendChild(row);
      });
    }
    function drawTools() {
      clear(toolBar);
      Object.keys(FIELD_LABEL).forEach((t) => toolBar.appendChild(h('button', { class: 'btn sm' + (S.tool === t ? ' primary' : ''), type: 'button', 'aria-pressed': String(S.tool === t), onclick: () => { S.tool = t; drawTools(); } }, FIELD_LABEL[t])));
    }
    const pageEls = [];
    function drawFields() {
      pageEls.forEach((pe) => $all('.pdf-field', pe).forEach((x) => x.remove()));
      S.signers.forEach((s, si) => s.fields.forEach((f) => {
        const pe = pageEls[f.page - 1];
        if (!pe) return;
        const el = h('div', { class: 'pdf-field' + (si === S.active ? '' : ''), style: 'left:' + f.x * 100 + '%;top:' + f.y * 100 + '%;width:' + f.w * 100 + '%;height:' + f.h * 100 + '%;' + (si !== S.active ? 'opacity:.55;border-color:#64748b;color:#334155;background:rgba(100,116,139,.12)' : ''),
          role: 'img', 'aria-label': FIELD_LABEL[f.type] + ' untuk ' + (s.nama || 'penanda tangan ' + (si + 1)) + ', halaman ' + f.page },
          FIELD_LABEL[f.type] + ' · ' + (s.nama || '#' + (si + 1)),
          si === S.active ? h('button', { class: 'x', type: 'button', 'aria-label': 'Hapus field', onclick: (e) => { e.stopPropagation(); s.fields.splice(s.fields.indexOf(f), 1); drawFields(); drawSigners(); } }, '×') : null);
        if (si === S.active) dragify(el, pe, f);
        pe.appendChild(el);
      }));
    }
    function dragify(el, pe, f) {
      el.addEventListener('pointerdown', (e) => {
        if (e.target.classList.contains('x')) return;
        e.preventDefault(); e.stopPropagation();
        const rect = pe.getBoundingClientRect();
        const sx = e.clientX, sy = e.clientY, ox = f.x, oy = f.y;
        el.setPointerCapture(e.pointerId);
        const move = (ev) => { f.x = Math.min(1 - f.w, Math.max(0, ox + (ev.clientX - sx) / rect.width)); f.y = Math.min(1 - f.h, Math.max(0, oy + (ev.clientY - sy) / rect.height)); el.style.left = f.x * 100 + '%'; el.style.top = f.y * 100 + '%'; };
        const up = () => { el.removeEventListener('pointermove', move); el.removeEventListener('pointerup', up); };
        el.addEventListener('pointermove', move); el.addEventListener('pointerup', up);
      });
    }
    drawSigners(); drawTools();
    try {
      const res = await callApi('doc.pdf', { id: id });
      const pdf = await pdfOpen(await fetchBytes(res.url));
      clear(pagesBox);
      const width = Math.min(900, pagesBox.clientWidth - 8 || 700);
      for (let n = 1; n <= pdf.numPages; n++) {
        const pg = await renderPdfPage(pdf, n, width);
        const pe = h('div', { class: 'pdf-page', style: 'width:' + width + 'px' }, pg.canvas);
        pe.addEventListener('click', (e) => {
          if (e.target.closest('.pdf-field')) return;
          const s = S.signers[S.active];
          if (s.fields.length >= 30) return toast('Maksimal 30 field per penanda tangan.', 'bad');
          const rect = pe.getBoundingClientRect();
          const [w, hh] = FIELD_SIZE[S.tool];
          const f = { id: Math.random().toString(36).slice(2, 10), type: S.tool, page: n, w: w, h: hh, required: true,
            x: Math.min(1 - w, Math.max(0, (e.clientX - rect.left) / rect.width - w / 2)), y: Math.min(1 - hh, Math.max(0, (e.clientY - rect.top) / rect.height - hh / 2)), label: S.tool === 'text' ? 'Isian' : '' };
          if (S.tool === 'text') promptDialog('Label isian teks', 'Contoh: Jabatan, NIK, Nomor kontrak', { max: 40, okLabel: 'Tambah' }).then((v) => { if (v === null) return; f.label = v || 'Isian'; s.fields.push(f); drawFields(); drawSigners(); });
          else { s.fields.push(f); drawFields(); drawSigners(); }
        });
        pageEls.push(pe);
        pagesBox.append(h('div', { class: 'small muted' }, 'Halaman ' + n + ' dari ' + pdf.numPages), pe);
      }
      drawFields();
    } catch (e) { clear(pagesBox).appendChild(errorState(e)); }

    async function save(andSend) {
      const m = formData(meta);
      errBox.textContent = '';
      const payload = { id: id, title: m.title, message: m.message, signingOrder: m.signingOrder, expiresInDays: m.expiresInDays,
        signers: S.signers.map((s) => ({ id: s.id, nama: s.nama.trim(), email: s.email.trim(), authMethod: s.authMethod, accessCode: s.accessCode, fields: s.fields })) };
      if (andSend) {
        const missing = payload.signers.find((s) => !s.fields.some((f) => f.type === 'signature' || f.type === 'initial'));
        if (missing) { errBox.textContent = 'Penanda tangan "' + (missing.nama || '?') + '" belum memiliki field tanda tangan/paraf.'; return; }
      }
      try {
        const r = await callApi('doc.setup', payload);
        r.doc.signers.forEach((s, i) => { if (S.signers[i]) S.signers[i].id = s.id; });
        if (!andSend) return toast('Draf disimpan.', 'ok');
        const ok = await confirmDialog('Kirim dokumen?', 'Undangan akan dikirim ke ' + (payload.signingOrder === 'parallel' ? 'semua penanda tangan sekaligus' : 'penanda tangan pertama, lalu berurutan') + '. Dokumen tidak dapat diubah setelah dikirim.', 'Kirim sekarang');
        if (!ok) return;
        await callApi('doc.send', { id: id });
        toast('Dokumen dikirim.', 'ok');
        App.go('docs/' + id);
      } catch (err) { if (err.fields && err.fields.signers) errBox.textContent = err.fields.signers; else if (err.fields && err.fields.fields) errBox.textContent = err.fields.fields; showErrors(meta, err); }
    }
  });
}

/* ---------- Detail dokumen ---------- */
function docDetail(c, id) {
  c.appendChild(h('a', { href: '#/docs', class: 'small' }, '‹ Kembali'));
  const body = h('div');
  c.appendChild(body);
  const load = () => loadInto(body, () => callApi('doc.get', { id: id }), (dta) => {
    const doc = dta.doc;
    const waiting = ['sent', 'viewed', 'partially_signed'].indexOf(doc.status) >= 0;
    const dlBtn = (which, label) => h('button', { class: 'btn', onclick: (e) => withBusy(e.currentTarget, async () => { try { downloadB64(await callApi('doc.download', { id: id, which: which })); } catch (er) { toastErr(er); } }) }, icon('download', 16), label);
    const acts = [];
    if (doc.canManage && waiting) acts.push(h('button', { class: 'btn danger', onclick: async (e) => {
      const reason = await promptDialog('Batalkan dokumen', 'Alasan pembatalan (dikirim ke penanda tangan)', { min: 3, multiline: true, okLabel: 'Batalkan dokumen', danger: true });
      if (reason) withBusy(e.currentTarget, async () => { try { await callApi('doc.void', { id: id, reason: reason }); toast('Dokumen dibatalkan.', 'ok'); load(); } catch (er) { toastErr(er); } });
    } }, 'Batalkan'));
    if (doc.canManage && ['voided', 'declined', 'expired'].indexOf(doc.status) >= 0) acts.push(h('button', { class: 'btn danger', onclick: async (e) => {
      if (await confirmDialog('Hapus dokumen?', 'Dokumen disembunyikan dari daftar. Bukti audit tetap disimpan.', 'Hapus', true)) withBusy(e.currentTarget, async () => { try { await callApi('doc.delete', { id: id }); App.go('docs'); } catch (er) { toastErr(er); } });
    } }, 'Hapus'));
    if (['admin', 'editor', 'auditor'].indexOf(State.me.role) >= 0) { acts.push(dlBtn('original', 'Asli')); if (doc.hasCert) acts.push(dlBtn('certificate', 'Sertifikat')); if (doc.hasFinal) acts.push(dlBtn('final', 'PDF final')); }
    if (doc.canManage && doc.status === 'completed' && (!doc.hasFinal || !doc.hasCert)) acts.push(h('button', { class: 'btn primary', onclick: (e) => withBusy(e.currentTarget, async () => {
      try { await callApi('doc.finalize', { id: id }); toast('Sertifikat dan PDF final dibuat ulang di server.', 'ok'); load(); } catch (er) { toastErr(er); }
    }) }, icon('sign', 16), 'Buat ulang PDF final'));
    body.append(pageHead(doc.title, null, acts), h('div', { class: 'row', style: 'margin:-6px 0 14px' }, badge(doc.status, doc.statusLabel), h('span', { class: 'small muted' }, doc.progress.signed + '/' + doc.progress.total + ' tanda tangan · ' + (doc.signingOrder === 'parallel' ? 'bersamaan' : 'berurutan'))));
    if (doc.status === 'voided') body.appendChild(h('div', { class: 'callout bad' }, 'Dibatalkan: ' + (doc.voidReason || '-')));
    const cv = h('canvas', { 'aria-label': 'QR verifikasi dokumen' });
    drawQr(cv, doc.verifyUrl, { size: 180, margin: 3, fg: '#000000', bg: '#ffffff', ecl: 'M' }).catch(() => {});
    body.appendChild(h('div', { class: 'grid grid-2' },
      h('section', { class: 'card' }, h('h2', null, 'Bukti integritas'), h('dl', { class: 'kv' },
        h('dt', null, 'Kode verifikasi'), h('dd', null, h('b', { class: 'mono', text: doc.code }), ' ', h('button', { class: 'btn sm icon', 'aria-label': 'Salin tautan verifikasi', dataset: { action: 'copy', text: doc.verifyUrl } }, icon('copy', 16))),
        h('dt', null, 'Berkas'), h('dd', { text: doc.fileName + ' · ' + bytes(doc.sizeBytes) + ' · ' + doc.pageCount + ' hlm' }),
        h('dt', null, 'SHA-256 asli'), h('dd', null, h('code', { text: doc.originalHash })),
        doc.certHash ? [h('dt', null, 'SHA-256 sertifikat'), h('dd', null, h('code', { text: doc.certHash }))] : null,
        doc.finalHash ? [h('dt', null, 'SHA-256 PDF final'), h('dd', null, h('code', { text: doc.finalHash }))] : null,
        h('dt', null, 'Rantai bukti'), h('dd', null, dta.chain.ok ? badge('valid', 'Utuh · ' + dta.chain.count + ' peristiwa') : badge('review', 'Rusak — perlu pemeriksaan')),
        h('dt', null, 'Dikirim'), h('dd', { text: dt(doc.sentAt) }), h('dt', null, 'Berlaku sampai'), h('dd', { text: dt(doc.expiresAt) }),
        doc.completedAt ? [h('dt', null, 'Selesai'), h('dd', { text: dt(doc.completedAt) })] : null)),
      h('section', { class: 'card' }, h('h2', null, 'QR verifikasi'), h('div', { class: 'qr-stage', style: 'min-height:0' }, cv), h('p', { class: 'small muted', style: 'margin-top:8px' }, 'Siapa pun dapat memeriksa status dokumen dengan memindai QR ini atau membuka tautan verifikasi.'))));
    body.appendChild(h('section', { class: 'card' }, h('h2', null, 'Penanda tangan'), h('div', { class: 'table-wrap' }, h('table', { class: 'responsive' },
      h('thead', null, h('tr', null, ['#', 'Nama', 'Status', 'Autentikasi', 'Waktu', ''].map((t) => h('th', { text: t })))),
      h('tbody', null, doc.signers.map((s) => h('tr', null, h('td', { dataset: { label: '#' }, text: String(s.order) }),
        h('td', { dataset: { label: 'Nama' } }, h('div', null, h('div', { class: 'title', text: s.nama }), h('div', { class: 'small muted', text: s.email }))),
        h('td', { dataset: { label: 'Status' } }, badge(s.status), s.declineReason ? h('div', { class: 'small err', text: 'Alasan: ' + s.declineReason }) : null),
        h('td', { dataset: { label: 'Autentikasi' } }, h('span', { class: 'small', text: AUTH_LABEL[s.authMethod] })),
        h('td', { dataset: { label: 'Waktu' } }, h('span', { class: 'small', text: s.signedAt ? 'Ditandatangani ' + dt(s.signedAt) : s.viewedAt ? 'Dilihat ' + dt(s.viewedAt) : s.sentAt ? 'Dikirim ' + dt(s.sentAt) : '–' })),
        h('td', { dataset: { label: 'Aksi' } }, doc.canManage && waiting && (s.status === 'sent' || s.status === 'viewed') ? h('button', { class: 'btn sm', onclick: (e) => withBusy(e.currentTarget, async () => {
          try { await callApi('doc.remind', { id: id, signerId: s.id }); toast('Pengingat dikirim. Tautan lama tidak berlaku lagi.', 'ok'); load(); } catch (er) { toastErr(er); }
        }) }, 'Kirim pengingat') : null))))))));
    body.appendChild(h('section', { class: 'card' }, h('div', { class: 'card-head' }, h('h2', null, 'Jejak audit (append-only, berantai hash)'), dta.chain.ok ? badge('valid', 'Rantai utuh') : badge('review', 'Rantai rusak')),
      h('ul', { class: 'timeline' }, dta.events.map((e) => h('li', null, h('b', { text: EVENT_LABEL[e.type] || e.type }), h('div', { class: 'small muted', text: dt(e.waktu) + ' · ' + e.actor }),
        Object.keys(e.evidence || {}).length ? h('details', { class: 'small' }, h('summary', null, 'Bukti'), h('pre', { class: 'mono', style: 'white-space:pre-wrap;margin:0', text: JSON.stringify(e.evidence, null, 2) + '\nhash: ' + e.hash })) : null)))));
  });
  load();
}

/* ================= Scanner ================= */
Pages.scanner = (c) => {
  c.appendChild(pageHead('Scanner & Verifikasi', 'Pindai QR/barcode dari kamera atau gambar, atau periksa keaslian berkas PDF. Gambar tidak dikirim maupun disimpan.'));
  const tabs = [['camera', 'Kamera'], ['upload', 'Unggah gambar'], ['manual', 'Input manual'], ['pdf', 'Verifikasi PDF']];
  const tabBar = h('div', { class: 'tabs', role: 'tablist' });
  const panel = h('div', { role: 'tabpanel' });
  const result = h('div', { 'aria-live': 'polite', style: 'margin-top:16px' });
  const hist = h('div');
  c.append(h('section', { class: 'card' }, tabBar, panel, result), h('section', { class: 'card' }, h('h2', null, 'Riwayat verifikasi'), hist));
  let stream = null, raf = null, busy = false;
  const stopCam = () => { if (raf) cancelAnimationFrame(raf); raf = null; if (stream) stream.getTracks().forEach((t) => t.stop()); stream = null; };
  State.cleanup = stopCam;
  const show = (key) => {
    stopCam();
    clear(tabBar); tabs.forEach((t) => tabBar.appendChild(h('button', { role: 'tab', 'aria-selected': String(t[0] === key), onclick: () => show(t[0]) }, t[1])));
    clear(panel);
    if (key === 'camera') camPanel();
    if (key === 'upload') uploadPanel();
    if (key === 'manual') manualPanel();
    if (key === 'pdf') pdfPanel();
  };
  async function check(content, source, format) {
    clear(result).appendChild(skeleton(3));
    try { const r = await callApi('scan.check', { content: content, source: source, format: format || '' }); clear(result).appendChild(scanResultCard(r)); loadHist(); }
    catch (e) { clear(result).appendChild(errorState(e)); }
  }
  function camPanel() {
    const video = h('video', { playsinline: true, muted: true, 'aria-label': 'Pratinjau kamera' });
    const status = h('p', { class: 'small muted', 'aria-live': 'polite' }, 'Kamera hanya aktif setelah Anda menekan tombol dan memberi izin.');
    const startBtn = h('button', { class: 'btn primary', onclick: start }, icon('camera', 16), 'Mulai kamera');
    const stopBtn = h('button', { class: 'btn', onclick: () => { stopCam(); status.textContent = 'Kamera dimatikan.'; } }, 'Matikan');
    panel.append(h('div', { class: 'scan-video' }, video, h('div', { class: 'scan-frame', 'aria-hidden': 'true' })), h('div', { class: 'row', style: 'margin-top:10px' }, startBtn, stopBtn), status);
    async function start() {
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) { status.textContent = 'Browser tidak mendukung akses kamera. Gunakan tab "Unggah gambar".'; return; }
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false });
        video.srcObject = stream; await video.play();
        status.textContent = 'Arahkan kamera ke QR/barcode…';
        const cv = document.createElement('canvas');
        let last = 0;
        const loop = async (t) => {
          if (!stream) return;
          raf = requestAnimationFrame(loop);
          if (busy || t - last < 300) return;
          last = t; busy = true;
          try { const res = await decodeSource(video, cv); if (res && res.text) { stopCam(); status.textContent = 'Kode terdeteksi.'; if (navigator.vibrate) navigator.vibrate(80); check(res.text, 'camera', res.format); } }
          catch (e) { /* abaikan frame gagal */ } finally { busy = false; }
        };
        raf = requestAnimationFrame(loop);
      } catch (e) {
        status.textContent = e && e.name === 'NotAllowedError' ? 'Izin kamera ditolak. Anda tetap bisa memakai tab "Unggah gambar" atau "Input manual".' : 'Kamera tidak dapat diakses di lingkungan ini (' + (e && e.name || 'tidak diketahui') + '). Gunakan "Unggah gambar".';
      }
    }
  }
  function uploadPanel() {
    const input = h('input', { type: 'file', accept: 'image/*', id: 'scan-img', capture: 'environment' });
    const st = h('p', { class: 'small muted', 'aria-live': 'polite' }, 'Gambar diproses di perangkat Anda dan tidak diunggah.');
    panel.append(h('div', { class: 'field' }, h('label', { for: 'scan-img' }, 'Pilih foto/tangkapan layar berisi QR atau barcode'), input), st);
    input.addEventListener('change', async () => {
      const f = input.files[0]; if (!f) return;
      st.textContent = 'Membaca gambar…';
      try { const img = await fileToImage(f); const res = await decodeSource(img); input.value = '';
        if (!res) { st.textContent = 'Tidak ada kode yang terbaca. Pastikan gambar tajam, terang, dan kode terlihat utuh.'; return; }
        st.textContent = 'Kode terbaca (' + res.format + ').'; check(res.text, 'upload', res.format);
      } catch (e) { st.textContent = errMsg(e); }
    });
  }
  function manualPanel() {
    const form = h('form', { novalidate: true }, field('content', 'Tempel URL, kode verifikasi (SS-XXXX-…), atau teks', { type: 'textarea', maxlength: 2000, required: true }));
    const btn = h('button', { class: 'btn primary', type: 'submit' }, 'Periksa');
    form.appendChild(btn);
    form.addEventListener('submit', (e) => { e.preventDefault(); const v = formData(form).content; if (!v) return showErrors(form, { fields: { content: 'Wajib diisi.' } }); withBusy(btn, () => check(v, 'manual')); });
    panel.appendChild(form);
  }
  function pdfPanel() {
    const form = h('form', { novalidate: true },
      h('p', { class: 'small muted' }, 'Sidik jari SHA-256 dihitung di perangkat Anda; isi berkas tidak dikirim. Berkas yang diubah sedikit saja akan menghasilkan sidik jari berbeda.'),
      h('div', { class: 'field' }, h('label', { for: 'f-vfile' }, 'Berkas PDF *'), h('input', { id: 'f-vfile', type: 'file', accept: 'application/pdf,.pdf' }), h('div', { class: 'err', id: 'e-hash' })),
      field('code', 'Kode verifikasi (opsional, lebih akurat)', { maxlength: 30, placeholder: 'SS-XXXX-XXXX-XXXX-XXXX' }));
    const btn = h('button', { class: 'btn primary', type: 'submit' }, 'Verifikasi berkas');
    form.appendChild(btn);
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const f = $('#f-vfile', form).files[0];
      if (!f) return showErrors(form, { fields: { hash: 'Pilih berkas PDF.' } });
      withBusy(btn, async () => {
        try { const hash = await sha256Hex(await readFileBuf(f)); clear(result).appendChild(skeleton(3)); const r = await callApi('scan.verifyHash', { hash: hash, code: formData(form).code }); clear(result).appendChild(scanResultCard(Object.assign({ kind: 'file', fileHash: hash }, r))); loadHist(); }
        catch (er) { clear(result).appendChild(errorState(er)); }
      });
    });
    panel.appendChild(form);
  }
  function loadHist(page) {
    loadInto(hist, () => callApi('scan.history', { page: page || 1, pageSize: 10 }), (pg) => {
      if (!pg.rows.length) return hist.appendChild(h('p', { class: 'muted' }, 'Belum ada pemeriksaan.'));
      hist.appendChild(h('div', { class: 'table-wrap' }, h('table', { class: 'responsive' }, h('thead', null, h('tr', null, ['Waktu', 'Jenis', 'Isi', 'Hasil', ''].map((t) => h('th', { text: t })))),
        h('tbody', null, pg.rows.map((x) => h('tr', null, h('td', { dataset: { label: 'Waktu' }, text: dt(x.checkedAt) }), h('td', { dataset: { label: 'Jenis' }, text: x.objectType }),
          h('td', { dataset: { label: 'Isi' } }, h('span', { class: 'small mono ellipsis', style: 'display:inline-block;max-width:280px', title: x.input, text: x.input })), h('td', { dataset: { label: 'Hasil' } }, badge(x.result)),
          h('td', { dataset: { label: 'Laporan' } }, h('button', { class: 'btn sm', onclick: (e) => withBusy(e.currentTarget, async () => { try { downloadB64(await callApi('scan.report', { id: x.id })); } catch (er) { toastErr(er); } }) }, icon('download', 14), 'PDF')))))))) ;
      hist.appendChild(pager(pg, (p) => loadHist(p)));
    });
  }
  show('camera');
  loadHist();
};
const RESULT_TITLE = { valid: 'VALID', invalid: 'TIDAK VALID', expired: 'KEDALUWARSA', unable: 'TIDAK DAPAT DIVERIFIKASI', review: 'PERLU PEMERIKSAAN' };
function scanResultCard(r) {
  const det = r.details || {};
  const box = h('div', { class: 'result-card ' + r.result, role: 'status' },
    h('div', { class: 'result-title' }, icon(r.result === 'valid' ? 'check' : r.result === 'invalid' ? 'x' : r.result === 'expired' ? 'clock' : r.result === 'review' ? 'alert' : 'help', 26), RESULT_TITLE[r.result] || r.result),
    h('p', { style: 'margin:6px 0 10px', text: r.message || '' }));
  const kv = h('dl', { class: 'kv' });
  const add = (k, v) => { if (v) kv.append(h('dt', { text: k }), h('dd', null, v instanceof Node ? v : h('span', { class: 'mono', text: String(v) }))); };
  add('Jenis', { shortlink: 'Shortlink sistem ini', url: 'Tautan eksternal', document: 'Dokumen bertanda tangan', file: 'Berkas PDF', text: 'Teks', sign: 'Tautan penandatanganan', scheme: 'Skema tidak diizinkan' }[r.kind] || r.kind);
  add('Domain tujuan', det.domain);
  if (det.destination) add('Tujuan', det.destination);
  if (det.text) add('Isi', h('span', { class: 'mono', style: 'white-space:pre-wrap', text: det.text }));
  if (r.fileHash) add('SHA-256 berkas', r.fileHash);
  if (r.match) add('Cocok dengan', { original: 'Dokumen asli (sebelum tanda tangan)', final: 'PDF final bertanda tangan', certificate: 'Sertifikat penyelesaian' }[r.match]);
  if (r.doc && r.doc.title) {
    add('Dokumen', r.doc.title); add('Kode', r.doc.code);
    if (r.doc.statusLabel) add('Status', r.doc.statusLabel);
    if (r.doc.signers) add('Penanda tangan', h('ul', { style: 'margin:0;padding-left:18px' }, r.doc.signers.map((s) => h('li', null, s.nama + ' (' + s.email + ') — ' + (s.signedAt ? 'ditandatangani ' + dt(s.signedAt) + ' via ' + s.auth : 'belum')))));
    if (r.doc.assurance) add('Jenis tanda tangan', r.doc.assurance);
  }
  box.appendChild(kv);
  if (det.flags && det.flags.length) box.appendChild(h('div', { class: 'callout warn', style: 'margin-top:10px' }, h('b', null, 'Indikasi risiko:'), h('ul', null, det.flags.map((f) => h('li', { text: f })))));
  const acts = h('div', { class: 'row', style: 'margin-top:12px' });
  const target = r.kind === 'url' && r.result !== 'invalid' ? det.url : (r.kind === 'shortlink' && (r.result === 'valid' || r.result === 'review')) ? (BOOT.shortBase + encodeURIComponent(det.slug)) : '';
  if (target) acts.appendChild(h('button', { class: 'btn' + (r.result === 'valid' ? ' primary' : ''), onclick: async () => {
    const okGo = await confirmDialog('Buka tautan?', 'Anda akan membuka situs di domain: ' + (det.domain || target) + '. Pastikan domain ini benar sebelum memasukkan data apa pun.', 'Buka di tab baru', r.result !== 'valid');
    if (okGo) window.open(target, '_blank', 'noopener,noreferrer');
  } }, icon('ext', 16), 'Buka tautan'));
  if (det.linkId) acts.appendChild(h('a', { class: 'btn', href: '#/links/' + det.linkId }, 'Lihat di Shortlink'));
  if (r.recordId) acts.appendChild(h('button', { class: 'btn', onclick: (e) => withBusy(e.currentTarget, async () => { try { downloadB64(await callApi('scan.report', { id: r.recordId })); } catch (er) { toastErr(er); } }) }, icon('download', 16), 'Unduh laporan PDF'));
  box.appendChild(acts);
  return box;
}

/* ================= Tim & Anggota ================= */
Pages.team = (c) => {
  if (!can.admin()) return Pages.notFound(c);
  c.appendChild(pageHead('Tim & Anggota', 'Undang anggota, atur peran (RBAC), dan cabut akses.'));
  const body = h('div');
  c.appendChild(body);
  const load = () => loadInto(body, () => callApi('team.list', {}), (dta) => {
    const roleOpts = Object.keys(dta.roles).map((k) => [k, dta.roles[k]]);
    const inv = h('form', { novalidate: true, class: 'form-grid' }, field('email', 'Email', { type: 'email', required: true, maxlength: 120 }), field('role', 'Peran', { type: 'select', value: 'editor', options: roleOpts }));
    const invBtn = h('button', { class: 'btn primary', type: 'submit' }, 'Kirim undangan');
    inv.appendChild(h('div', { class: 'span-2' }, invBtn));
    inv.addEventListener('submit', (e) => { e.preventDefault(); withBusy(invBtn, async () => { try { await callApi('team.invite', formData(inv)); toast('Undangan dikirim.', 'ok'); load(); } catch (er) { showErrors(inv, er); } }); });
    body.appendChild(h('div', { class: 'grid grid-2' },
      h('section', { class: 'card' }, h('h2', null, 'Undang anggota'), inv),
      h('section', { class: 'card' }, h('h2', null, 'Hak akses per peran'), h('ul', { class: 'small' },
        h('li', null, h('b', null, 'Admin: '), 'semua fitur, anggota, pengaturan, audit.'), h('li', null, h('b', null, 'Editor: '), 'membuat & mengubah shortlink/dokumen miliknya, scanner.'),
        h('li', null, h('b', null, 'Pembaca: '), 'melihat shortlink, statistik, dokumen; memakai scanner.'), h('li', null, h('b', null, 'Auditor: '), 'membaca & mengekspor log audit, mengunduh dokumen untuk pemeriksaan.')))));
    body.appendChild(h('section', { class: 'card' }, h('h2', null, 'Anggota (' + dta.members.length + ')'), h('div', { class: 'table-wrap' }, h('table', { class: 'responsive' },
      h('thead', null, h('tr', null, ['Nama', 'Peran', 'Status', 'MFA', 'Login terakhir', ''].map((t) => h('th', { text: t })))),
      h('tbody', null, dta.members.map((m) => h('tr', null,
        h('td', { dataset: { label: 'Nama' } }, h('div', null, h('div', { class: 'title', text: m.nama + (m.self ? ' (Anda)' : '') }), h('div', { class: 'small muted', text: m.email }))),
        h('td', { dataset: { label: 'Peran' } }, m.self ? h('span', { text: m.roleLabel }) : h('select', { 'aria-label': 'Peran ' + m.nama, onchange: async (e) => {
          const sel = e.target;
          if (!(await confirmDialog('Ubah peran?', m.nama + ' akan menjadi ' + dta.roles[sel.value] + ' dan harus login ulang.', 'Ubah peran'))) { sel.value = m.role; return; }
          try { await callApi('team.role', { membershipId: m.membershipId, role: sel.value }); toast('Peran diperbarui.', 'ok'); load(); } catch (er) { sel.value = m.role; toastErr(er); }
        } }, roleOpts.map((o) => h('option', { value: o[0], selected: o[0] === m.role ? true : null }, o[1])))),
        h('td', { dataset: { label: 'Status' } }, badge(m.status)), h('td', { dataset: { label: 'MFA' } }, m.mfaEnabled ? badge('ok', 'Aktif') : badge('pending', 'Belum')),
        h('td', { dataset: { label: 'Login terakhir' } }, h('span', { class: 'small', text: m.lastLoginAt ? dt(m.lastLoginAt) : '–' })),
        h('td', { dataset: { label: 'Aksi' } }, m.self ? null : h('div', { class: 'row', style: 'gap:4px;justify-content:flex-end' },
          h('button', { class: 'btn sm', onclick: (e) => memberStatus(e.currentTarget, m, m.status === 'aktif' ? 'nonaktif' : 'aktif') }, m.status === 'aktif' ? 'Nonaktifkan' : 'Aktifkan'),
          h('button', { class: 'btn sm', onclick: (e) => withBusy(e.currentTarget, async () => { if (!(await confirmDialog('Kirim tautan reset password?', 'Tautan untuk membuat password baru akan dikirim ke email ' + m.email + '.', 'Kirim'))) return; try { const r = await callApi('team.sendReset', { membershipId: m.membershipId }); toast(r.message, 'ok'); } catch (er) { toastErr(er); } }) }, 'Reset password'),
          h('button', { class: 'btn sm', onclick: (e) => withBusy(e.currentTarget, async () => { try { const r = await callApi('team.revokeSessions', { membershipId: m.membershipId }); toast(r.revoked + ' sesi dicabut.', 'ok'); } catch (er) { toastErr(er); } }) }, 'Cabut sesi'),
          h('button', { class: 'btn sm danger', onclick: (e) => memberStatus(e.currentTarget, m, 'dihapus') }, 'Keluarkan'))))))))));
    if (dta.invites.length) body.appendChild(h('section', { class: 'card' }, h('h2', null, 'Undangan tertunda'), h('ul', null, dta.invites.map((i) => h('li', { class: 'row', style: 'padding:4px 0' }, h('span', { text: i.email + ' · ' + i.roleLabel + ' · berlaku sampai ' + d(i.expiresAt) }),
      h('button', { class: 'btn sm', onclick: (e) => withBusy(e.currentTarget, async () => { try { await callApi('team.revokeInvite', { id: i.id }); toast('Undangan dicabut.', 'ok'); load(); } catch (er) { toastErr(er); } }) }, 'Cabut'))))));
  });
  async function memberStatus(btn, m, status) {
    const msg = status === 'dihapus' ? m.nama + ' akan dikeluarkan dari ruang kerja dan semua sesinya dicabut.' : status === 'nonaktif' ? m.nama + ' tidak dapat login ke ruang kerja ini sampai diaktifkan kembali.' : 'Aktifkan kembali ' + m.nama + '?';
    if (!(await confirmDialog(status === 'dihapus' ? 'Keluarkan anggota?' : status === 'nonaktif' ? 'Nonaktifkan anggota?' : 'Aktifkan anggota?', msg, 'Ya, lanjutkan', status !== 'aktif'))) return;
    withBusy(btn, async () => { try { await callApi('team.status', { membershipId: m.membershipId, status: status }); toast('Status anggota diperbarui.', 'ok'); load(); } catch (er) { toastErr(er); } });
  }
  load();
};

/* ================= Keamanan akun ================= */
Pages.security = (c) => {
  c.appendChild(pageHead('Keamanan Akun', 'Kelola password, verifikasi dua langkah, sesi aktif, dan aktivitas keamanan.'));
  const me = State.me;
  const prof = h('form', { novalidate: true }, field('nama', 'Nama', { value: me.nama, maxlength: 80, required: true }), h('p', { class: 'small muted', text: 'Email: ' + me.email }));
  const pBtn = h('button', { class: 'btn', type: 'submit' }, 'Simpan profil');
  prof.appendChild(pBtn);
  prof.addEventListener('submit', (e) => { e.preventDefault(); withBusy(pBtn, async () => { try { const r = await callApi('auth.profile', formData(prof)); State.me = r.me; toast('Profil disimpan.', 'ok'); } catch (er) { showErrors(prof, er); } }); });
  const mfaBox = h('div');
  const drawMfa = () => {
    clear(mfaBox);
    if (State.me.mfaEnabled) mfaBox.append(h('p', null, badge('ok', 'MFA aktif'), ' Login memerlukan kode dari aplikasi autentikator.'),
      h('div', { class: 'row' }, h('button', { class: 'btn', onclick: (e) => withBusy(e.currentTarget, async () => { try { const r = await callApi('auth.mfaRegen', {}); showRecoveryCodes(r.recoveryCodes); } catch (er) { toastErr(er); } }) }, 'Buat ulang kode pemulihan'),
        h('button', { class: 'btn danger', onclick: async (e) => { if (await confirmDialog('Nonaktifkan MFA?', 'Akun Anda akan lebih rentan diambil alih.', 'Nonaktifkan', true)) withBusy(e.currentTarget, async () => { try { const r = await callApi('auth.mfaDisable', {}); State.me = r.me; drawMfa(); toast('MFA dinonaktifkan.', 'ok'); } catch (er) { toastErr(er); } }); } }, 'Nonaktifkan MFA')));
    else mfaBox.append(h('p', null, badge('pending', 'MFA belum aktif'), ' Sangat disarankan untuk melindungi akun.'),
      h('button', { class: 'btn primary', onclick: () => { const box = h('div'); const m = openModal({ title: 'Aktifkan MFA', body: box }); mfaSetupFlow(box, () => { m.close(); drawMfa(); }); } }, 'Aktifkan MFA (TOTP)'));
  };
  drawMfa();
  const sess = h('div'), evs = h('div');
  c.append(h('div', { class: 'grid grid-2' }, h('section', { class: 'card' }, h('h2', null, 'Profil'), prof), h('section', { class: 'card' }, h('h2', null, 'Verifikasi dua langkah'), mfaBox),
    h('section', { class: 'card' }, h('h2', null, 'Ganti password'), changePasswordForm()),
    h('section', { class: 'card' }, h('div', { class: 'card-head' }, h('h2', null, 'Sesi aktif'), h('button', { class: 'btn sm danger', onclick: (e) => withBusy(e.currentTarget, async () => { try { const r = await callApi('auth.revokeOthers', {}); toast(r.revoked + ' sesi lain dikeluarkan.', 'ok'); loadSess(); } catch (er) { toastErr(er); } }) }, 'Keluarkan semua sesi lain')), sess)),
  h('section', { class: 'card' }, h('h2', null, 'Aktivitas keamanan saya'), evs));
  function loadSess() {
    loadInto(sess, () => callApi('auth.sessions', {}), (rows) => sess.appendChild(h('ul', { style: 'list-style:none;padding:0;margin:0' }, rows.map((s) => h('li', { class: 'row between', style: 'padding:8px 0;border-bottom:1px solid var(--border)' },
      h('div', null, h('div', { class: 'title', text: s.device }), h('div', { class: 'small muted', text: 'Masuk ' + dt(s.createdAt) })),
      s.current ? badge('ok', 'Perangkat ini') : h('button', { class: 'btn sm', onclick: (e) => withBusy(e.currentTarget, async () => { try { await callApi('auth.revokeSession', { id: s.id }); loadSess(); } catch (er) { toastErr(er); } }) }, 'Cabut'))))));
  }
  loadSess();
  loadInto(evs, () => callApi('security.mine', { page: 1, pageSize: 10 }), (pg) => evs.appendChild(pg.rows.length ? h('ul', { class: 'timeline' }, pg.rows.map((e) => h('li', null, h('b', { text: e.eventType.replace(/_/g, ' ') }), ' ', badge(e.severity), h('div', { class: 'small muted', text: dt(e.waktu) })))) : h('p', { class: 'muted' }, 'Tidak ada peristiwa keamanan.')));
};

/* ================= Audit ================= */
Pages.audit = (c) => {
  if (!can.audit()) return Pages.notFound(c);
  c.appendChild(pageHead('Log Audit', 'Catatan append-only dengan rantai hash SHA-256. Perubahan atau penghapusan baris akan terdeteksi.', [
    h('button', { class: 'btn', onclick: (e) => withBusy(e.currentTarget, async () => { try { const r = await callApi('audit.verify', {}); openModal({ title: 'Integritas rantai audit', body: h('div', { class: 'callout ' + (r.ok ? 'ok' : 'bad') }, r.message + (r.brokenAt ? ' (ID: ' + r.brokenAt + ')' : '')) }); } catch (er) { toastErr(er); } }) }, icon('shield', 16), 'Periksa integritas')]));
  const tabBar = h('div', { class: 'tabs', role: 'tablist' });
  const panel = h('div');
  c.appendChild(h('section', { class: 'card' }, tabBar, panel));
  const tabs = [['audit', 'Aktivitas'], ['security', 'Peristiwa keamanan']].concat(can.admin() || can.superadmin() ? [['abuse', 'Laporan penyalahgunaan']] : []);
  const show = (k) => { clear(tabBar); tabs.forEach((t) => tabBar.appendChild(h('button', { role: 'tab', 'aria-selected': String(t[0] === k), onclick: () => show(t[0]) }, t[1]))); clear(panel); ({ audit: auditTab, security: secTab, abuse: abuseTab })[k](); };
  function auditTab() {
    const st = { page: 1 };
    const f = h('form', { class: 'toolbar', onsubmit: (e) => { e.preventDefault(); st.page = 1; load(); } },
      h('input', { name: 'q', type: 'search', placeholder: 'Cari pengguna, aksi, ID…', 'aria-label': 'Cari audit' }),
      h('select', { name: 'action', 'aria-label': 'Kategori aksi' }, [['', 'Semua aksi'], ['auth.', 'Autentikasi'], ['link.', 'Shortlink'], ['doc.', 'Dokumen'], ['member.', 'Anggota'], ['workspace.', 'Pengaturan'], ['audit.', 'Audit'], ['system.', 'Sistem']].map((o) => h('option', { value: o[0] }, o[1]))),
      h('input', { name: 'from', type: 'date', 'aria-label': 'Dari tanggal' }), h('input', { name: 'to', type: 'date', 'aria-label': 'Sampai tanggal' }),
      h('button', { class: 'btn', type: 'submit' }, 'Terapkan'),
      h('button', { class: 'btn', type: 'button', onclick: (e) => withBusy(e.currentTarget, async () => { try { const x = await callApi('audit.export', formData(f)); downloadCsv('audit-' + new Date().toISOString().slice(0, 10) + '.csv', x.header, x.rows); } catch (er) { toastErr(er); } }) }, icon('download', 16), 'Ekspor CSV'));
    const list = h('div');
    panel.append(f, list);
    const load = () => loadInto(list, () => callApi('audit.list', Object.assign({ page: st.page, pageSize: 25 }, formData(f))), (pg) => {
      if (!pg.rows.length) return list.appendChild(h('p', { class: 'muted' }, 'Tidak ada catatan.'));
      const detail = (a) => openModal({ title: AUDIT_LABEL[a.action] || a.action, wide: true, body: h('div', null,
        h('dl', { class: 'kv' }, h('dt', null, 'Aksi'), h('dd', { class: 'mono', text: a.action }), h('dt', null, 'Waktu'), h('dd', { text: dt(a.waktu) }),
          h('dt', null, 'Pengguna'), h('dd', { text: a.userEmail || '-' }), h('dt', null, 'Sumber'), h('dd', { text: a.source }), h('dt', null, 'Hash'), h('dd', null, h('code', { text: a.hash }))),
        h('div', { class: 'grid grid-2', style: 'margin-top:12px' },
          h('div', null, h('h3', null, 'Sebelum'), h('pre', { class: 'mono', style: 'white-space:pre-wrap', text: a.before ? JSON.stringify(a.before, null, 2) : '–' })),
          h('div', null, h('h3', null, 'Sesudah'), h('pre', { class: 'mono', style: 'white-space:pre-wrap', text: a.after ? JSON.stringify(a.after, null, 2) : '–' })))) });
      const rowOf = (a) => h('tr', null,
        h('td', { dataset: { label: 'Waktu' } }, h('span', { class: 'small', text: dt(a.waktu) })),
        h('td', { dataset: { label: 'Pengguna' } }, h('span', { class: 'small', text: a.userEmail || a.source })),
        h('td', { dataset: { label: 'Aksi' } }, h('span', { text: AUDIT_LABEL[a.action] || a.action })),
        h('td', { dataset: { label: 'Entitas' } }, h('span', { class: 'small mono', text: a.entity + ' ' + (a.entityId || '') })),
        h('td', { dataset: { label: 'Detail' } }, h('button', { class: 'btn sm', onclick: () => detail(a) }, 'Detail')));
      list.appendChild(h('div', { class: 'table-wrap' }, h('table', { class: 'responsive' },
        h('thead', null, h('tr', null, ['Waktu', 'Pengguna', 'Aksi', 'Entitas', ''].map((t) => h('th', { text: t })))),
        h('tbody', null, pg.rows.map(rowOf)))));
      list.appendChild(pager(pg, (p) => { st.page = p; load(); }));
    });
    load();
  }
  function secTab() {
    const list = h('div');
    panel.appendChild(list);
    const load = (page) => loadInto(list, () => callApi('security.list', { page: page || 1, pageSize: 25 }), (pg) => {
      if (!pg.rows.length) return list.appendChild(h('p', { class: 'muted' }, 'Tidak ada peristiwa keamanan.'));
      list.appendChild(h('div', { class: 'table-wrap' }, h('table', { class: 'responsive' }, h('thead', null, h('tr', null, ['Waktu', 'Peristiwa', 'Tingkat', 'Subjek'].map((t) => h('th', { text: t })))),
        h('tbody', null, pg.rows.map((e) => h('tr', null, h('td', { dataset: { label: 'Waktu' }, text: dt(e.waktu) }), h('td', { dataset: { label: 'Peristiwa' }, text: e.eventType.replace(/_/g, ' ') }), h('td', { dataset: { label: 'Tingkat' } }, badge(e.severity)), h('td', { dataset: { label: 'Subjek' } }, h('span', { class: 'small mono', text: e.subject }))))))));
      list.appendChild(pager(pg, load));
    });
    load();
  }
  function abuseTab() {
    const list = h('div');
    panel.appendChild(list);
    const load = (page) => loadInto(list, () => callApi('abuse.list', { page: page || 1, pageSize: 20 }), (pg) => {
      if (!pg.rows.length) return list.appendChild(h('p', { class: 'muted' }, 'Tidak ada laporan.'));
      const act = (r, a, label, danger) => h('button', { class: 'btn sm' + (danger ? ' danger' : ''), onclick: (e) => withBusy(e.currentTarget, async () => { try { await callApi('abuse.handle', { id: r.id, action: a }); toast('Laporan diproses.', 'ok'); load(page); } catch (er) { toastErr(er); } }) }, label);
      list.appendChild(h('div', { class: 'table-wrap' }, h('table', { class: 'responsive' }, h('thead', null, h('tr', null, ['Waktu', 'Slug', 'Alasan', 'Status', 'Tindakan'].map((t) => h('th', { text: t })))),
        h('tbody', null, pg.rows.map((r) => h('tr', null, h('td', { dataset: { label: 'Waktu' }, text: dt(r.createdAt) }), h('td', { dataset: { label: 'Slug' } }, h('div', null, h('span', { class: 'mono', text: '/' + r.slug }), h('div', { class: 'small muted ellipsis', style: 'max-width:240px', title: r.destination, text: r.destination }))),
          h('td', { dataset: { label: 'Alasan' } }, h('div', null, h('b', { text: r.reason }), r.detail ? h('div', { class: 'small', text: r.detail }) : null)), h('td', { dataset: { label: 'Status' } }, badge(r.status)),
          h('td', { dataset: { label: 'Tindakan' } }, r.status === 'baru' ? h('div', { class: 'row', style: 'gap:4px' }, can.superadmin() ? act(r, 'block', 'Blokir', true) : null, act(r, 'deactivate', 'Nonaktifkan'), act(r, 'dismiss', 'Tolak')) : (can.superadmin() && r.linkStatus === 'diblokir' ? act(r, 'unblock', 'Buka blokir') : h('span', { class: 'small muted', text: 'Link: ' + r.linkStatus })))))))));
      list.appendChild(pager(pg, load));
    });
    load();
  }
  show('audit');
};

/* ================= Pengaturan ruang kerja ================= */
Pages.settings = (c) => {
  if (!can.admin()) return Pages.notFound(c);
  c.appendChild(pageHead('Pengaturan', 'Kebijakan keamanan, privasi analitik, retensi, dan daftar blokir ruang kerja.'));
  const body = h('div');
  c.appendChild(body);
  const load = () => loadInto(body, () => callApi('settings.get', {}), (dta) => {
    const s = dta.settings, u = dta.usage;
    const form = h('form', { novalidate: true, class: 'form-grid' },
      field('nama', 'Nama ruang kerja', { required: true, maxlength: 80, value: dta.workspace.nama, span: true }),
      h('div', { class: 'span-2' }, checkField('requireMfaAdmin', 'Wajibkan MFA untuk semua admin', s.requireMfaAdmin, 'Admin tanpa MFA akan diminta mengaktifkannya sebelum bisa bekerja.')),
      field('interstitialMode', 'Halaman peringatan sebelum redirect', { type: 'select', value: s.interstitialMode, options: [['risky', 'Hanya untuk tautan berisiko'], ['always', 'Selalu tampilkan domain tujuan']] }),
      field('analyticsMode', 'Privasi analitik', { type: 'select', value: s.analyticsMode, options: [['full', 'Lengkap agregat (perangkat, OS, browser)'], ['minimal', 'Minimal (jumlah klik saja)'], ['off', 'Nonaktif']] }),
      field('defaultLinkDays', 'Kedaluwarsa default shortlink (hari)', { type: 'number', min: 0, max: 3650, value: s.defaultLinkDays }, '0 = tidak ada kedaluwarsa default.'),
      field('signLinkDays', 'Masa berlaku undangan tanda tangan (hari)', { type: 'number', min: 1, max: 90, value: s.signLinkDays }),
      field('allowedDomains', 'Hanya izinkan domain tujuan berikut (opsional)', { type: 'textarea', value: s.allowedDomains, span: true, placeholder: 'contoh.id, toko-saya.com' }, 'Kosongkan untuk mengizinkan semua domain kecuali yang diblokir.'));
    const btn = h('button', { class: 'btn primary', type: 'submit' }, 'Simpan pengaturan');
    form.appendChild(h('div', { class: 'span-2' }, btn));
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const f = formData(form);
      withBusy(btn, async () => { try { await callApi('settings.save', { nama: f.nama, settings: f }); toast('Pengaturan disimpan.', 'ok'); const me = await callApi('auth.me', {}); State.me = me.me; App.render(); } catch (er) { showErrors(form, er); } });
    });
    const bl = h('form', { novalidate: true, class: 'form-grid' }, field('domain', 'Domain diblokir', { maxlength: 200, placeholder: 'domain-phishing.com', required: true }), field('reason', 'Alasan', { maxlength: 200 }),
      can.superadmin() ? checkField('global', 'Berlaku global (semua ruang kerja)', false) : null);
    const blBtn = h('button', { class: 'btn', type: 'submit' }, 'Tambahkan');
    bl.appendChild(h('div', { class: 'span-2' }, blBtn));
    bl.addEventListener('submit', (e) => { e.preventDefault(); withBusy(blBtn, async () => { try { await callApi('block.add', formData(bl)); toast('Domain diblokir.', 'ok'); load(); } catch (er) { showErrors(bl, er); } }); });
    const usageRow = (label, used, max) => h('div', null, h('div', { class: 'row between small' }, h('span', { text: label }), h('span', { text: num(used) + ' / ' + num(max) })), h('div', { class: 'hbar', style: 'grid-template-columns:1fr' }, h('div', { class: 'track' }, h('div', { class: 'fill', style: 'width:' + Math.min(100, Math.round(used / max * 100)) + '%' }))));
    body.appendChild(h('div', { class: 'grid grid-2' }, h('section', { class: 'card' }, h('h2', null, 'Kebijakan'), form),
      h('div', { class: 'stack' }, h('section', { class: 'card' }, h('h2', null, 'Paket & kuota: ' + dta.workspace.planLabel), usageRow('Shortlink', u.links, u.linksMax), usageRow('Dokumen bulan ini', u.docsMonth, u.docsMax), usageRow('Anggota', u.members, u.membersMax),
        h('p', { class: 'small muted', style: 'margin-top:8px' }, 'Alamat pendek: ', h('code', { text: dta.shortBase + 'slug' }))),
        h('section', { class: 'card' }, h('h2', null, 'Daftar blokir domain'), bl, dta.blocklist.length ? h('ul', null, dta.blocklist.map((b) => h('li', { class: 'row', style: 'padding:4px 0' }, h('span', { class: 'mono', text: b.domain }), b.global ? h('span', { class: 'chip' }, 'global') : null, h('span', { class: 'small muted', text: b.reason || '' }),
          h('button', { class: 'btn sm', onclick: (e) => withBusy(e.currentTarget, async () => { try { await callApi('block.remove', { id: b.id }); load(); } catch (er) { toastErr(er); } }) }, 'Hapus')))) : h('p', { class: 'muted small' }, 'Belum ada domain diblokir.')))));
  });
  load();
};

/* ================= Platform (superadmin) ================= */
