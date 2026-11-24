/* SmartSign: halaman publik (tanda tangan, verifikasi, reset, undangan) */
'use strict';
/* ============ Halaman publik: penandatanganan, verifikasi, reset, undangan, verifikasi email ============ */
const PublicPages = {};
function publicFrame(root, title, wide) {
  const card = h('div', { class: 'card', style: 'width:100%;max-width:' + (wide ? '980px' : '520px') });
  root.appendChild(h('div', { class: 'auth-wrap', style: 'align-items:start' }, h('div', { style: 'width:100%;display:flex;flex-direction:column;align-items:center;gap:12px' },
    h('div', { class: 'brand' }, h('span', { class: 'brand-logo' }, icon('shield', 20)), BOOT.appName), card,
    h('p', { class: 'small faint', style: 'text-align:center;max-width:560px' }, 'Waspadai penipuan: ' + BOOT.appName + ' tidak pernah meminta password, PIN, atau kode OTP Anda lewat telepon atau chat.'))));
  if (title) card.appendChild(h('h1', { text: title }));
  return card;
}
function goLogin() { State.publicDone = true; BOOT.mode = 'app'; try { history.replaceState(null, '', '/'); } catch (e) { /* abaikan */ } App.start(); }

/* ---------- Penandatanganan ---------- */
PublicPages.sign = (root) => {
  const card = publicFrame(root, 'Tanda tangan dokumen', true);
  const body = h('div');
  card.appendChild(body);
  const S = { ss: null, info: null, load: null, sigPng: null, sigType: 'draw', pdfBytes: null };
  if (!BOOT.token) return body.appendChild(h('div', { class: 'callout bad' }, 'Tautan tidak valid. Buka kembali tautan dari email undangan.'));
  loadInto(body, () => rawApi('sign.open', { token: BOOT.token }), (info) => {
    S.info = info;
    const dd = info.doc, sg = info.signer;
    body.append(h('dl', { class: 'kv' }, h('dt', null, 'Dokumen'), h('dd', null, h('b', { text: dd.title })), h('dt', null, 'Dari'), h('dd', { text: info.sender }),
      h('dt', null, 'Untuk'), h('dd', { text: sg.nama + ' (' + sg.email + ')' }), h('dt', null, 'Status'), h('dd', null, badge(dd.status, dd.statusLabel)),
      h('dt', null, 'Berlaku sampai'), h('dd', { text: dt(dd.expiresAt) })),
      dd.message ? h('div', { class: 'callout', style: 'margin-top:12px' }, h('b', null, 'Pesan pengirim: '), dd.message) : null,
      h('div', { class: 'callout info', style: 'margin-top:12px' }, h('b', null, 'Jenis tanda tangan: '), info.assurance + '. Tanda tangan ini dibuktikan dengan OTP ke email Anda, persetujuan eksplisit, waktu server, dan sidik jari SHA-256 dokumen. Bukan sertifikat elektronik PSrE.'));
    const blocked = ['voided', 'declined', 'expired'].indexOf(dd.status) >= 0;
    if (blocked) return body.appendChild(h('div', { class: 'callout bad', style: 'margin-top:12px' }, dd.status === 'voided' ? 'Permintaan ini telah dibatalkan oleh pengirim.' : dd.status === 'declined' ? 'Dokumen ini telah ditolak oleh salah satu penanda tangan.' : 'Masa berlaku permintaan ini telah habis.'));
    if (sg.status === 'signed') body.appendChild(h('div', { class: 'callout ok', style: 'margin-top:12px' }, 'Anda sudah menandatangani dokumen ini pada ' + dt(sg.signedAt) + '. ' + (dd.completed ? 'Semua pihak telah menandatangani.' : 'Menunggu penanda tangan lain.')));
    if (sg.status === 'declined') return body.appendChild(h('div', { class: 'callout bad', style: 'margin-top:12px' }, 'Anda telah menolak dokumen ini.'));
    body.appendChild(otpStep(sg, () => afterOtp()));
    body.appendChild(h('p', { class: 'small', style: 'margin-top:12px' }, 'Ingin memeriksa keaslian? ', h('a', { href: dd.verifyUrl, target: '_top', rel: 'noopener', text: 'Halaman verifikasi dokumen' })));
  });
  function otpStep(sg, onOk) {
    const wrap = h('section', { style: 'margin-top:16px' }, h('h2', null, 'Langkah 1 — Verifikasi identitas'));
    const sendBtn = h('button', { class: 'btn primary', type: 'button' }, 'Kirim kode OTP ke ' + sg.email);
    const form = h('form', { novalidate: true, hidden: true },
      field('code', 'Kode OTP (6 digit)', { inputmode: 'numeric', maxlength: 6, autocomplete: 'one-time-code', class: 'otp-input', required: true }),
      sg.authMethod === 'otp_code' ? field('accessCode', 'Kode akses dari pengirim', { maxlength: 20, required: true, autocomplete: 'off' }, 'Kode ini dikirim pengirim lewat kanal terpisah (telepon/chat).') : null);
    const vBtn = h('button', { class: 'btn primary', type: 'submit' }, 'Verifikasi');
    const resend = h('button', { class: 'btn ghost', type: 'button' }, 'Kirim ulang kode');
    form.append(h('div', { class: 'row' }, vBtn, resend));
    const note = h('p', { class: 'small muted', 'aria-live': 'polite' });
    const send = (btn) => withBusy(btn, async () => {
      try { const r = await rawApi('sign.sendOtp', { token: BOOT.token }); note.textContent = 'Kode dikirim ke ' + r.sentTo + '. Berlaku 10 menit. Periksa juga folder spam.'; form.hidden = false; sendBtn.hidden = true; $('input', form).focus(); }
      catch (e) { note.textContent = errMsg(e); }
    });
    sendBtn.addEventListener('click', () => send(sendBtn));
    resend.addEventListener('click', () => send(resend));
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      withBusy(vBtn, async () => {
        try { const r = await rawApi('sign.verifyOtp', Object.assign({ token: BOOT.token }, formData(form))); S.ss = r.ss; wrap.replaceChildren(h('div', { class: 'callout ok' }, '✓ Identitas terverifikasi melalui ' + (sg.authMethod === 'otp_code' ? 'OTP email dan kode akses.' : 'OTP email.'))); onOk(); }
        catch (err) { showErrors(form, err); }
      });
    });
    wrap.append(sendBtn, note, form);
    return wrap;
  }
  async function afterOtp() {
    const sec = h('section', { style: 'margin-top:16px' });
    body.appendChild(sec);
    await loadInto(sec, () => rawApi('sign.load', { token: BOOT.token, ss: S.ss }), async (ld) => {
      S.load = ld;
      if (ld.signed) {
        sec.append(h('h2', null, 'Dokumen Anda'), ld.hasCert ? h('button', { class: 'btn primary', onclick: (e) => withBusy(e.currentTarget, async () => { try { downloadB64(await rawApi('sign.cert', { token: BOOT.token, ss: S.ss })); } catch (er) { toastErr(er); } }) }, icon('download', 16), 'Unduh sertifikat penyelesaian') : h('p', { class: 'muted' }, 'Sertifikat tersedia setelah semua pihak menandatangani.'));
        return;
      }
      S.pdfBytes = await fetchBytes(ld.url);
      const localHash = await sha256Hex(S.pdfBytes.slice().buffer);
      S.hash = localHash;
      const hashOk = localHash === ld.originalHash;
      sec.append(h('h2', null, 'Langkah 2 — Tinjau dokumen'),
        h('div', { class: 'callout ' + (hashOk ? 'ok' : 'bad') }, hashOk ? '✓ Integritas dokumen terverifikasi (SHA-256 cocok dengan yang dicatat saat diunggah): ' : '✕ Sidik jari dokumen tidak cocok. Jangan tanda tangani; hubungi pengirim. ', h('code', { text: maskHash(localHash) })));
      if (!hashOk) return;
      const pagesBox = h('div', { class: 'pdf-pages', style: 'margin-top:12px;max-height:75vh;overflow:auto;padding:8px;background:var(--surface-2);border-radius:10px' }, skeleton(6));
      sec.appendChild(pagesBox);
      const myFields = ld.fields;
      const fieldEls = [];
      try {
        const pdf = await pdfOpen(S.pdfBytes.slice());
        clear(pagesBox);
        const width = Math.min(860, (pagesBox.clientWidth || 700) - 16);
        for (let n = 1; n <= pdf.numPages; n++) {
          const pg = await renderPdfPage(pdf, n, width);
          const pe = h('div', { class: 'pdf-page', style: 'width:' + width + 'px' }, pg.canvas);
          myFields.filter((f) => f.page === n).forEach((f) => {
            const el = h('button', { type: 'button', class: 'pdf-field mine', style: 'left:' + f.x * 100 + '%;top:' + f.y * 100 + '%;width:' + f.w * 100 + '%;height:' + f.h * 100 + '%', 'aria-label': FIELD_LABEL[f.type] + ' Anda di halaman ' + n },
              f.type === 'signature' || f.type === 'initial' ? 'Klik untuk ' + FIELD_LABEL[f.type].toLowerCase() : f.type === 'name' ? ld.signerName : f.type === 'date' ? new Intl.DateTimeFormat('id-ID', { timeZone: 'Asia/Jakarta' }).format(new Date()) : (f.label || 'Isian'));
            if (f.type === 'signature' || f.type === 'initial') el.addEventListener('click', captureSignature);
            else if (f.type === 'text') el.addEventListener('click', () => { const inp = $('#tf-' + f.id); if (inp) inp.focus(); });
            fieldEls.push({ f: f, el: el });
            pe.appendChild(el);
          });
          pagesBox.append(h('div', { class: 'small muted' }, 'Halaman ' + n + ' dari ' + pdf.numPages), pe);
        }
      } catch (e) { clear(pagesBox).appendChild(errorState(e)); }
      const textFields = myFields.filter((f) => f.type === 'text');
      const form = h('form', { novalidate: true, style: 'margin-top:16px' }, h('h2', null, 'Langkah 3 — Tanda tangan & persetujuan'),
        h('div', { class: 'row' }, h('button', { class: 'btn primary', type: 'button', onclick: captureSignature }, icon('sign', 16), 'Buat tanda tangan'), h('span', { id: 'sig-state', class: 'small muted' }, 'Belum ada tanda tangan.')),
        h('div', { id: 'sig-preview', style: 'margin:10px 0' }),
        textFields.map((f) => field('field_' + f.id, f.label || 'Isian', { id: 'tf-' + f.id, maxlength: 200, required: f.required })),
        h('div', { class: 'callout', style: 'margin:12px 0' }, h('label', { class: 'check' }, h('input', { type: 'checkbox', name: 'consent', id: 'f-consent' }), h('span', { text: ld.consentText })), h('div', { class: 'err', id: 'e-consent' })),
        h('div', { class: 'err', id: 'e-signature' }));
      const signBtn = h('button', { class: 'btn primary', type: 'submit' }, 'Tanda Tangani');
      const declineBtn = h('button', { class: 'btn danger', type: 'button' }, 'Tolak dokumen');
      form.appendChild(h('div', { class: 'row' }, signBtn, declineBtn));
      sec.appendChild(form);
      declineBtn.addEventListener('click', async () => {
        const reason = await promptDialog('Tolak dokumen', 'Alasan penolakan (dikirim ke pengirim)', { min: 3, multiline: true, okLabel: 'Tolak dokumen', danger: true });
        if (!reason) return;
        withBusy(declineBtn, async () => { try { await rawApi('sign.decline', { token: BOOT.token, ss: S.ss, reason: reason }); clear(body).appendChild(h('div', { class: 'callout bad' }, 'Anda telah menolak dokumen ini. Pengirim telah diberi tahu.')); } catch (er) { toastErr(er); } });
      });
      form.addEventListener('submit', (e) => {
        e.preventDefault();
        const fd = formData(form);
        const errs = {};
        if (!S.sigPng) errs.signature = 'Buat tanda tangan terlebih dahulu.';
        if (!fd.consent) errs.consent = 'Centang pernyataan persetujuan.';
        textFields.forEach((f) => { if (f.required && !fd['field_' + f.id]) errs['field_' + f.id] = 'Wajib diisi.'; });
        if (Object.keys(errs).length) return showErrors(form, { fields: errs });
        withBusy(signBtn, async () => {
          try {
            const values = {};
            textFields.forEach((f) => { values[f.id] = fd['field_' + f.id]; });
            const r = await rawApi('sign.submit', { token: BOOT.token, ss: S.ss, consent: true, consentVersion: ld.consentVersion, docHash: S.hash,
              signatureType: S.sigType, signatureImage: S.sigPng, fieldValues: values, ua: navigator.userAgent });
            clear(body).append(h('div', { class: 'result-card valid' }, h('div', { class: 'result-title' }, icon('check', 26), 'Berhasil ditandatangani'),
              h('p', null, 'Terima kasih. Tanda tangan Anda telah dicatat pada ' + dt(new Date().toISOString()) + ' dengan bukti hash dokumen ', h('code', { text: maskHash(S.hash) }), '.'),
              h('p', null, r.completed ? 'Semua pihak telah menandatangani. Sertifikat penyelesaian dikirim ke email Anda.' : 'Pengirim akan diberi tahu. Anda akan menerima email saat semua pihak selesai.'),
              h('a', { class: 'btn', href: S.info.doc.verifyUrl, target: '_top' }, 'Buka halaman verifikasi')));
          } catch (err) { if (err.code === 'UNAUTHORIZED') { toast(err.message, 'bad'); App.render(); } else showErrors(form, err); }
        });
      });
      function captureSignature() {
        const tabsBar = h('div', { class: 'tabs', role: 'tablist' });
        const pane = h('div');
        let mode = S.sigType, pad = null, typed = null, uploaded = null;
        const ok = h('button', { class: 'btn primary', type: 'button' }, 'Pakai tanda tangan ini');
        const m = openModal({ title: 'Buat tanda tangan', wide: true, body: h('div', null, tabsBar, pane, h('p', { class: 'small muted', style: 'margin-top:8px' }, 'Gambar tanda tangan adalah representasi visual; bukti utamanya adalah OTP, persetujuan, dan hash dokumen.')),
          foot: [h('button', { class: 'btn', dataset: { close: '1' } }, 'Batal'), ok] });
        const draw = (k) => {
          mode = k; clear(tabsBar); clear(pane);
          [['draw', 'Gambar'], ['type', 'Ketik'], ['upload', 'Unggah']].forEach((t) => tabsBar.appendChild(h('button', { role: 'tab', 'aria-selected': String(t[0] === k), onclick: () => draw(t[0]) }, t[1])));
          if (k === 'draw') {
            const cv = h('canvas', { class: 'sig-pad', 'aria-label': 'Area menggambar tanda tangan. Gunakan jari, stylus, atau mouse.' });
            pane.append(cv, h('div', { class: 'row', style: 'margin-top:8px' }, h('button', { class: 'btn sm', type: 'button', onclick: () => pad.clear() }, 'Hapus'), h('span', { class: 'small muted' }, 'Pengguna keyboard dapat memakai tab "Ketik".')));
            setTimeout(() => { pad = signaturePad(cv); }, 30);
          } else if (k === 'type') {
            const inp = h('input', { id: 'sig-name', value: ld.signerName, maxlength: 60 });
            const style = h('select', { id: 'sig-style', 'aria-label': 'Gaya huruf' }, h('option', { value: 'a' }, 'Tulisan tangan'), h('option', { value: 'b' }, 'Serif miring'), h('option', { value: 'c' }, 'Santai'));
            const prev = h('div', { class: 'qr-stage', style: 'min-height:120px;background:#fff' });
            const upd = () => { const png = typedSignaturePng(inp.value || ld.signerName, style.value); typed = png; clear(prev); if (png) prev.appendChild(h('img', { src: png, alt: 'Pratinjau tanda tangan', style: 'max-height:100px' })); };
            inp.addEventListener('input', upd); style.addEventListener('change', upd);
            pane.append(h('div', { class: 'form-grid' }, h('div', { class: 'field' }, h('label', { for: 'sig-name' }, 'Nama'), inp), h('div', { class: 'field' }, h('label', { for: 'sig-style' }, 'Gaya'), style)), prev);
            upd();
          } else {
            const f = h('input', { type: 'file', accept: 'image/png,image/jpeg', id: 'sig-file' });
            const prev = h('div', { class: 'qr-stage', style: 'min-height:120px;background:#fff' });
            f.addEventListener('change', async () => {
              try {
                const img = await fileToImage(f.files[0]);
                const cv = document.createElement('canvas'); const r = Math.min(1, 900 / img.width); cv.width = img.width * r; cv.height = img.height * r;
                const ctx = cv.getContext('2d'); ctx.drawImage(img, 0, 0, cv.width, cv.height);
                const dta = ctx.getImageData(0, 0, cv.width, cv.height); // jadikan latar putih transparan
                for (let i = 0; i < dta.data.length; i += 4) if (dta.data[i] > 225 && dta.data[i + 1] > 225 && dta.data[i + 2] > 225) dta.data[i + 3] = 0;
                ctx.putImageData(dta, 0, 0);
                uploaded = trimCanvas(cv);
                clear(prev); if (uploaded) prev.appendChild(h('img', { src: uploaded, alt: 'Pratinjau tanda tangan', style: 'max-height:100px' }));
              } catch (e) { toastErr(e); }
            });
            pane.append(h('div', { class: 'field' }, h('label', { for: 'sig-file' }, 'Foto tanda tangan di atas kertas putih (PNG/JPG)'), f), prev);
          }
        };
        draw(mode);
        ok.addEventListener('click', () => {
          const png = mode === 'draw' ? (pad && !pad.isEmpty() ? pad.toPng() : null) : mode === 'type' ? typed : uploaded;
          if (!png) return toast('Tanda tangan masih kosong.', 'bad');
          if (png.length > 380000) return toast('Gambar tanda tangan terlalu besar. Coba lagi dengan goresan lebih sederhana.', 'bad');
          S.sigPng = png; S.sigType = mode;
          fieldEls.filter((x) => x.f.type === 'signature' || x.f.type === 'initial').forEach((x) => { x.el.classList.add('done'); x.el.replaceChildren(h('img', { src: png, alt: 'Tanda tangan Anda' })); });
          $('#sig-state').textContent = '✓ Tanda tangan siap (' + { draw: 'digambar', type: 'diketik', upload: 'diunggah' }[mode] + ').';
          $('#sig-preview').replaceChildren(h('img', { src: png, alt: 'Pratinjau tanda tangan', style: 'max-height:80px;background:#fff;border:1px solid var(--border);border-radius:8px;padding:6px' }));
          m.close(true);
        });
      }
    });
  }
};

/* ---------- Verifikasi publik ---------- */
PublicPages.verify = (root) => {
  const card = publicFrame(root, 'Verifikasi dokumen', false);
  card.appendChild(h('p', { class: 'muted' }, 'Periksa status dan keaslian dokumen yang ditandatangani melalui ' + BOOT.appName + '.'));
  const result = h('div', { 'aria-live': 'polite', style: 'margin-top:14px' });
  const form = h('form', { novalidate: true }, field('code', 'Kode verifikasi', { maxlength: 30, value: BOOT.token || '', placeholder: 'SS-XXXX-XXXX-XXXX-XXXX', required: true }),
    h('div', { class: 'field' }, h('label', { for: 'f-pfile' }, 'Bandingkan dengan berkas PDF (opsional)'), h('input', { id: 'f-pfile', type: 'file', accept: 'application/pdf,.pdf' }),
      h('div', { class: 'hint' }, 'Sidik jari SHA-256 dihitung di perangkat Anda; berkas tidak diunggah.'), h('div', { class: 'err', id: 'e-hash' })));
  const btn = h('button', { class: 'btn primary', type: 'submit' }, 'Verifikasi');
  form.appendChild(btn);
  const run = () => withBusy(btn, async () => {
    const f = formData(form);
    const file = $('#f-pfile', form).files[0];
    clear(result).appendChild(skeleton(3));
    try {
      let r;
      if (file) { const hash = await sha256Hex(await readFileBuf(file)); r = Object.assign({ kind: 'file', fileHash: hash }, await rawApi('public.verifyHash', { hash: hash, code: f.code })); }
      else { if (!f.code) { clear(result); return showErrors(form, { fields: { code: 'Masukkan kode verifikasi.' } }); } r = Object.assign({ kind: 'document' }, await rawApi('public.verifyDoc', { code: f.code })); }
      delete r.recordId;
      clear(result).appendChild(scanResultCard(r));
    } catch (e) { clear(result).appendChild(errorState(e)); }
  });
  form.addEventListener('submit', (e) => { e.preventDefault(); run(); });
  card.append(form, result, h('div', { class: 'divider' }), h('button', { class: 'btn ghost', onclick: goLogin }, 'Masuk ke aplikasi'));
  if (BOOT.token) run();
};

/* ---------- Reset password ---------- */
PublicPages.reset = (root) => {
  const card = publicFrame(root, 'Atur ulang password', false);
  const form = h('form', { novalidate: true },
    field('password', 'Password baru', { type: 'password', required: true, autocomplete: 'new-password', maxlength: 128 }, 'Minimal ' + BOOT.passwordMin + ' karakter, kombinasi huruf dan angka.'),
    field('confirm', 'Ulangi password baru', { type: 'password', required: true, autocomplete: 'new-password', maxlength: 128 }));
  const btn = h('button', { class: 'btn primary', type: 'submit', style: 'width:100%' }, 'Simpan password baru');
  form.appendChild(btn);
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const f = formData(form);
    if (f.password !== f.confirm) return showErrors(form, { fields: { confirm: 'Password tidak sama.' } });
    withBusy(btn, async () => {
      try { const r = await rawApi('auth.reset', { token: BOOT.token, password: f.password }); clear(form).append(h('div', { class: 'callout ok' }, r.message), h('button', { class: 'btn primary', style: 'margin-top:12px', onclick: goLogin }, 'Masuk')); }
      catch (err) { showErrors(form, err); }
    });
  });
  card.appendChild(form);
};

/* ---------- Undangan anggota ---------- */
PublicPages.invite = (root) => {
  const card = publicFrame(root, 'Undangan ruang kerja', false);
  const body = h('div');
  card.appendChild(body);
  loadInto(body, () => rawApi('invite.peek', { token: BOOT.token }), (inv) => {
    body.appendChild(h('p', null, 'Anda diundang bergabung ke ', h('b', { text: inv.workspace }), ' sebagai ', h('b', { text: inv.role }), ' (' + inv.email + ').'));
    if (inv.accountExists) {
      body.append(h('p', { class: 'muted' }, 'Email ini sudah memiliki akun. Masuk untuk menerima undangan.'), h('button', { class: 'btn primary', onclick: () => { State.pendingInvite = BOOT.token; goLogin(); } }, 'Masuk & terima undangan'));
      return;
    }
    const form = h('form', { novalidate: true }, field('nama', 'Nama lengkap', { required: true, maxlength: 80, autocomplete: 'name' }),
      field('password', 'Buat password', { type: 'password', required: true, autocomplete: 'new-password', maxlength: 128 }, 'Minimal ' + BOOT.passwordMin + ' karakter, kombinasi huruf dan angka.'));
    const btn = h('button', { class: 'btn primary', type: 'submit', style: 'width:100%' }, 'Buat akun & bergabung');
    form.appendChild(btn);
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      withBusy(btn, async () => {
        try { const r = await rawApi('invite.acceptNew', Object.assign({ token: BOOT.token, ua: navigator.userAgent }, formData(form))); State.publicDone = true; BOOT.mode = 'app'; Auth.done(r); }
        catch (err) { showErrors(form, err); }
      });
    });
    body.appendChild(form);
  });
};

App.start();
