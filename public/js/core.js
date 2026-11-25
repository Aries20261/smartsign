/* SmartSign: inti klien (state, API, DOM builder, UI umum) */
'use strict';
/* ============ Inti klien: state, API, DOM builder, UI umum ============ */
const BOOT = (() => { try { return JSON.parse(document.getElementById('boot').textContent || '{}'); } catch (e) { return {}; } })();
const State = { token: null, me: null, route: '', params: {}, reauthPending: null, theme: 'light' };

/* ---------- Library pihak ketiga: disajikan dari domain sendiri (public/vendor), dimuat saat dibutuhkan ---------- */
const LIBS = { qr: ['/vendor/qrcode.js'], jsqr: ['/vendor/jsQR.js'], pdflib: ['/vendor/pdf-lib.min.js'] };
const libPromises = {};
function loadLib(name) {
  if (libPromises[name]) return libPromises[name];
  libPromises[name] = LIBS[name].reduce((p, src) => p.then(() => new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src + '?v=' + encodeURIComponent(BOOT.version || '1');
    s.onload = resolve;
    s.onerror = () => reject({ code: 'LIB', message: 'Gagal memuat komponen (' + name + '). Periksa koneksi internet lalu coba lagi.' });
    document.head.appendChild(s);
  })), Promise.resolve()).catch((e) => { delete libPromises[name]; throw e; });
  return libPromises[name];
}
let pdfjsPromise = null;
function loadPdfjs() {
  if (!pdfjsPromise) {
    pdfjsPromise = import('/vendor/pdf.min.mjs').then((lib) => { lib.GlobalWorkerOptions.workerSrc = '/vendor/pdf.worker.min.mjs'; return lib; })
      .catch(() => { pdfjsPromise = null; throw { code: 'LIB', message: 'Gagal memuat penampil PDF. Periksa koneksi lalu coba lagi.' }; });
  }
  return pdfjsPromise;
}

/* ---------- Pemanggil server ---------- */
async function rawApi(action, payload) {
  let res;
  try {
    res = await fetch('/api/rpc', { method: 'POST', credentials: 'same-origin', cache: 'no-store',
      headers: { 'content-type': 'application/json', 'x-requested-with': 'smartsign' },
      body: JSON.stringify({ action: action, payload: payload == null ? null : payload }) });
  } catch (e) { throw { code: 'NETWORK', message: 'Koneksi ke server gagal. Periksa internet Anda lalu coba lagi.' }; }
  let body = null;
  try { body = await res.json(); } catch (e) { /* respons bukan JSON */ }
  if (body && body.ok) return body.data;
  throw body || { code: 'SERVER_ERROR', message: 'Respons server tidak valid (' + res.status + '). Coba lagi.' };
}
async function callApi(action, payload, opts) {
  try {
    return await rawApi(action, payload);
  } catch (err) {
    if (err.code === 'UNAUTHORIZED' && State.token && !(opts && opts.noRedirect)) {
      State.token = null; State.me = null;
      toast(err.message || 'Sesi berakhir. Silakan masuk kembali.', 'bad');
      App.render();
    } else if (err.code === 'REAUTH_REQUIRED' && !(opts && opts.noReauth)) {
      const okRe = await reauthDialog();
      if (okRe) return callApi(action, payload, Object.assign({}, opts, { noReauth: true }));
      throw { code: 'CANCELLED', message: 'Tindakan dibatalkan.' };
    } else if ((err.code === 'MFA_REQUIRED' || err.code === 'PASSWORD_CHANGE_REQUIRED') && State.me) {
      State.me.mfaSetupRequired = err.code === 'MFA_REQUIRED' || State.me.mfaSetupRequired;
      State.me.mustChangePassword = err.code === 'PASSWORD_CHANGE_REQUIRED' || State.me.mustChangePassword;
      App.render();
    }
    throw err;
  }
}

/* ---------- DOM builder aman (teks selalu lewat textContent) ---------- */
/* append/replaceChildren bawaan mengubah null menjadi teks "null"; abaikan anak kosong agar pola `kondisi ? el : null` aman. */
['append', 'prepend', 'replaceChildren'].forEach((m) => {
  [Element.prototype, DocumentFragment.prototype].forEach((proto) => {
    const orig = proto[m];
    proto[m] = function (...kids) { return orig.apply(this, kids.filter((k) => k != null && k !== false)); };
  });
});
function h(tag, props, ...children) {
  const el = document.createElement(tag);
  if (props) {
    for (const k in props) {
      const v = props[k];
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'text') el.textContent = v;
      else if (k === 'dataset') Object.assign(el.dataset, v);
      else if (k === 'style') el.setAttribute('style', v);
      else if (k === 'html') el.innerHTML = v; // HANYA untuk konstanta internal (ikon SVG)
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
      else if (v === true) el.setAttribute(k, '');
      else el.setAttribute(k, v);
    }
  }
  appendKids(el, children);
  return el;
}
function appendKids(el, kids) {
  kids.flat(Infinity).forEach((c) => {
    if (c == null || c === false) return;
    el.appendChild(c instanceof Node ? c : document.createTextNode(String(c)));
  });
}
function clear(el) { while (el.firstChild) el.removeChild(el.firstChild); return el; }
function $(sel, root) { return (root || document).querySelector(sel); }
function $all(sel, root) { return Array.from((root || document).querySelectorAll(sel)); }
function escapeHtml(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

const ICONS = {
  home: '<path d="M3 11l9-8 9 8v9a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z"/>',
  link: '<path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7"/><path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7"/>',
  qr: '<rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><path d="M14 14h3v3h-3zM20 14v.01M14 20h.01M17 20h4v-3"/>',
  sign: '<path d="M3 21h18"/><path d="M14.5 4.5l5 5L9 20H4v-5z"/>',
  scan: '<path d="M3 7V5a2 2 0 0 1 2-2h2M17 3h2a2 2 0 0 1 2 2v2M21 17v2a2 2 0 0 1-2 2h-2M7 21H5a2 2 0 0 1-2-2v-2"/><path d="M7 12h10"/>',
  chart: '<path d="M3 3v18h18"/><path d="M7 15v3M12 10v8M17 6v12"/>',
  team: '<circle cx="9" cy="8" r="4"/><path d="M2 21a7 7 0 0 1 14 0"/><path d="M16 4a4 4 0 0 1 0 8M22 21a7 7 0 0 0-5-6.7"/>',
  shield: '<path d="M12 3l8 3v6c0 5-3.5 8.5-8 9-4.5-.5-8-4-8-9V6z"/><path d="M9 12l2 2 4-4"/>',
  log: '<path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/>',
  gear: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
  plus: '<path d="M12 5v14M5 12h14"/>', menu: '<path d="M3 6h18M3 12h18M3 18h18"/>', x: '<path d="M18 6L6 18M6 6l12 12"/>',
  copy: '<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/>', ext: '<path d="M14 3h7v7M10 14L21 3M21 14v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5"/>',
  download: '<path d="M12 3v12M7 10l5 5 5-5M5 21h14"/>', upload: '<path d="M12 21V9M7 14l5-5 5 5M5 3h14"/>', search: '<circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/>',
  check: '<path d="M5 12l5 5L20 7"/>', alert: '<path d="M12 9v4M12 17h.01"/><path d="M10.3 3.9L1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 3"/>', help: '<circle cx="12" cy="12" r="9"/><path d="M9.1 9a3 3 0 0 1 5.8 1c0 2-3 3-3 3M12 17h.01"/>',
  moon: '<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/>', logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9"/>',
  file: '<path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><path d="M14 3v6h6"/>', camera: '<path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/>',
  eye: '<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8S1 12 1 12z"/><circle cx="12" cy="12" r="3"/>', lock: '<rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>'
};
function icon(name, size) {
  const s = size || 20;
  return h('span', { 'aria-hidden': 'true', style: 'display:inline-flex', html: '<svg width="' + s + '" height="' + s + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' + (ICONS[name] || '') + '</svg>' });
}

/* ---------- Format lokal ---------- */
const fmtDT = new Intl.DateTimeFormat('id-ID', { timeZone: 'Asia/Jakarta', day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
const fmtD = new Intl.DateTimeFormat('id-ID', { timeZone: 'Asia/Jakarta', day: '2-digit', month: 'short', year: 'numeric' });
const fmtN = new Intl.NumberFormat('id-ID');
function dt(iso) { if (!iso) return '–'; const d = new Date(iso); return isNaN(d) ? '–' : fmtDT.format(d) + ' WIB'; }
function d(iso) { if (!iso) return '–'; const x = new Date(iso.length === 10 ? iso + 'T00:00:00+07:00' : iso); return isNaN(x) ? '–' : fmtD.format(x); }
function num(n) { return n == null ? '–' : fmtN.format(n); }
function bytes(n) { return n > 1048576 ? (n / 1048576).toFixed(1).replace('.', ',') + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB'; }
function rel(iso) {
  const diff = (new Date(iso).getTime() - Date.now()) / 1000;
  const rtf = new Intl.RelativeTimeFormat('id-ID', { numeric: 'auto' });
  const a = Math.abs(diff);
  if (a < 60) return rtf.format(Math.round(diff), 'second');
  if (a < 3600) return rtf.format(Math.round(diff / 60), 'minute');
  if (a < 86400) return rtf.format(Math.round(diff / 3600), 'hour');
  return rtf.format(Math.round(diff / 86400), 'day');
}
function toLocalInput(iso) { if (!iso) return ''; const dd = new Date(iso); const p = (n) => String(n).padStart(2, '0'); const j = new Date(dd.getTime() + (7 * 60 + dd.getTimezoneOffset()) * 60000); return j.getFullYear() + '-' + p(j.getMonth() + 1) + '-' + p(j.getDate()) + 'T' + p(j.getHours()) + ':' + p(j.getMinutes()); }
function fromLocalInput(v) { return v ? v + ':00+07:00' : ''; }

/* ---------- Badge status (ikon + teks, tidak hanya warna) ---------- */
const STATUS_META = {
  ok: ['b-ok', 'check', 'Aktif'], aktif: ['b-ok', 'check', 'Aktif'], nonaktif: ['b-gray', 'x', 'Nonaktif'], arsip: ['b-gray', 'file', 'Arsip'],
  diblokir: ['b-bad', 'alert', 'Diblokir'], expired: ['b-warn', 'clock', 'Kedaluwarsa'], inactive: ['b-gray', 'x', 'Nonaktif'], blocked: ['b-bad', 'alert', 'Diblokir'],
  scheduled: ['b-info', 'clock', 'Terjadwal'], limit: ['b-warn', 'clock', 'Batas klik'], notfound: ['b-gray', 'help', 'Tidak ada'],
  draft: ['b-gray', 'file', 'Draf'], sent: ['b-info', 'sign', 'Terkirim'], viewed: ['b-info', 'eye', 'Dilihat'], partially_signed: ['b-warn', 'sign', 'Sebagian'],
  completed: ['b-ok', 'check', 'Selesai'], declined: ['b-bad', 'x', 'Ditolak'], voided: ['b-gray', 'x', 'Dibatalkan'], pending: ['b-gray', 'clock', 'Menunggu giliran'],
  signed: ['b-ok', 'check', 'Ditandatangani'], valid: ['b-ok', 'check', 'Valid'], invalid: ['b-bad', 'x', 'Tidak valid'],
  review: ['b-warn', 'alert', 'Perlu pemeriksaan'], unable: ['b-gray', 'help', 'Tidak dapat diverifikasi'],
  baru: ['b-warn', 'alert', 'Baru'], ditindak: ['b-ok', 'check', 'Ditindak'], ditolak: ['b-gray', 'x', 'Ditolak'],
  tinggi: ['b-bad', 'alert', 'Tinggi'], sedang: ['b-warn', 'alert', 'Sedang'], rendah: ['b-info', 'help', 'Rendah'], info: ['b-gray', 'help', 'Info']
};
function badge(status, labelOverride) {
  const m = STATUS_META[status] || ['b-gray', 'help', status];
  return h('span', { class: 'badge ' + m[0] }, icon(m[1], 14), labelOverride || m[2]);
}

/* ---------- Toast, modal, konfirmasi ---------- */
function toast(msg, kind) {
  const box = $('#toasts');
  const t = h('div', { class: 'toast ' + (kind || ''), role: kind === 'bad' ? 'alert' : 'status' }, icon(kind === 'bad' ? 'alert' : 'check', 18), h('span', null, msg));
  box.appendChild(t);
  setTimeout(() => t.remove(), kind === 'bad' ? 7000 : 4000);
}
function errMsg(e) { return (e && e.message) || 'Terjadi kesalahan. Silakan coba lagi.'; }
function toastErr(e) { if (e && e.code === 'CANCELLED') return; toast(errMsg(e), 'bad'); }

function openModal(opts) {
  const prevFocus = document.activeElement;
  const titleId = 'm' + Math.random().toString(36).slice(2);
  const body = h('div', { class: 'modal-body' }, opts.body);
  const foot = opts.foot ? h('div', { class: 'modal-foot' }, opts.foot) : null;
  const dlg = h('div', { class: 'modal' + (opts.wide ? ' wide' : ''), role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': titleId },
    h('div', { class: 'modal-head' }, h('h2', { id: titleId, text: opts.title }), h('button', { class: 'btn ghost icon', 'aria-label': 'Tutup', dataset: { close: '1' } }, icon('x'))),
    body, foot);
  const back = h('div', { class: 'modal-back' }, dlg);
  const close = (val) => { back.remove(); document.removeEventListener('keydown', onKey); if (prevFocus && prevFocus.focus) prevFocus.focus(); if (opts.onClose) opts.onClose(val); };
  const onKey = (e) => {
    if (e.key === 'Escape' && !opts.sticky) close(null);
    if (e.key === 'Tab') {
      const f = $all('button,input,select,textarea,a[href],[tabindex]:not([tabindex="-1"])', dlg).filter((x) => !x.disabled && x.offsetParent !== null);
      if (!f.length) return;
      if (e.shiftKey && document.activeElement === f[0]) { e.preventDefault(); f[f.length - 1].focus(); }
      else if (!e.shiftKey && document.activeElement === f[f.length - 1]) { e.preventDefault(); f[0].focus(); }
    }
  };
  back.addEventListener('click', (e) => { if (e.target === back && !opts.sticky) close(null); if (e.target.closest('[data-close]')) close(null); });
  document.addEventListener('keydown', onKey);
  $('#modals').appendChild(back);
  setTimeout(() => { const f = $('[autofocus]', dlg) || $('input,select,textarea,button.primary', body) || $('button', dlg); if (f) f.focus(); }, 30);
  return { close: close, el: dlg, body: body };
}
function confirmDialog(title, message, okLabel, danger) {
  return new Promise((resolve) => {
    let m;
    const ok = h('button', { class: 'btn ' + (danger ? 'danger' : 'primary'), onclick: () => { m.close(true); resolve(true); } }, okLabel || 'Ya, lanjutkan');
    m = openModal({ title: title, body: h('p', null, message), foot: [h('button', { class: 'btn', dataset: { close: '1' } }, 'Batal'), ok], onClose: (v) => { if (v !== true) resolve(false); } });
  });
}
function promptDialog(title, label, opts) {
  return new Promise((resolve) => {
    let m;
    const input = (opts && opts.multiline) ? h('textarea', { id: 'pd-in', maxlength: (opts && opts.max) || 300 }) : h('input', { id: 'pd-in', maxlength: (opts && opts.max) || 300 });
    const errEl = h('div', { class: 'err', 'aria-live': 'polite' });
    const ok = h('button', { class: 'btn ' + (opts && opts.danger ? 'danger' : 'primary'), onclick: () => {
      const v = input.value.trim();
      if ((opts && opts.min) && v.length < opts.min) { errEl.textContent = 'Minimal ' + opts.min + ' karakter.'; return; }
      m.close(v); resolve(v);
    } }, (opts && opts.okLabel) || 'Simpan');
    m = openModal({ title: title, body: h('div', { class: 'field' }, h('label', { for: 'pd-in', text: label }), input, errEl),
      foot: [h('button', { class: 'btn', dataset: { close: '1' } }, 'Batal'), ok], onClose: (v) => { if (typeof v !== 'string') resolve(null); } });
  });
}
/** Re-autentikasi untuk tindakan sensitif (password + kode MFA bila aktif). */
function reauthDialog() {
  return new Promise((resolve) => {
    let m;
    const needCode = State.me && State.me.mfaEnabled;
    const form = h('form', { novalidate: true },
      h('p', { class: 'muted' }, 'Tindakan ini sensitif. Masukkan kembali password Anda' + (needCode ? ' dan kode autentikator' : '') + '. Konfirmasi berlaku 5 menit.'),
      field('password', 'Password', { type: 'password', autocomplete: 'current-password', required: true }),
      needCode ? field('code', 'Kode autentikator (6 digit)', { inputmode: 'numeric', maxlength: 6, autocomplete: 'one-time-code', class: 'otp-input' }) : null);
    const ok = h('button', { class: 'btn primary', type: 'submit' }, 'Konfirmasi');
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      await withBusy(ok, async () => {
        try { await rawApi('auth.reauth', formData(form)); m.close(true); resolve(true); }
        catch (err) { showErrors(form, err); }
      });
    });
    form.appendChild(h('div', { class: 'row', style: 'justify-content:flex-end' }, h('button', { class: 'btn', type: 'button', dataset: { close: '1' } }, 'Batal'), ok));
    m = openModal({ title: 'Konfirmasi identitas', body: form, onClose: (v) => { if (v !== true) resolve(false); } });
  });
}

/* ---------- Form ---------- */
function field(name, label, attrs, hint) {
  const a = Object.assign({ id: 'f-' + name, name: name }, attrs || {});
  let ctrl;
  if (a.type === 'select') { const opts = a.options || []; delete a.type; delete a.options; ctrl = h('select', a, opts.map((o) => h('option', { value: o[0], selected: String(a.value) === String(o[0]) ? true : null }, o[1]))); delete a.value; }
  else if (a.type === 'textarea') { delete a.type; const v = a.value; delete a.value; ctrl = h('textarea', a); if (v != null) ctrl.value = v; }
  else { const v = a.value; delete a.value; ctrl = h('input', a); if (v != null) ctrl.value = v; }
  const errId = 'e-' + name;
  ctrl.setAttribute('aria-describedby', errId + (hint ? ' h-' + name : ''));
  return h('div', { class: 'field' + (attrs && attrs.span ? ' span-2' : '') }, h('label', { for: a.id, text: label + (attrs && attrs.required ? ' *' : '') }), ctrl,
    hint ? h('div', { class: 'hint', id: 'h-' + name, text: hint }) : null, h('div', { class: 'err', id: errId, 'aria-live': 'polite' }));
}
function checkField(name, label, checked, hint) {
  return h('div', { class: 'field' }, h('label', { class: 'check' }, h('input', { type: 'checkbox', name: name, id: 'f-' + name, checked: checked ? true : null }), h('span', null, label)),
    hint ? h('div', { class: 'hint', text: hint }) : null, h('div', { class: 'err', id: 'e-' + name, 'aria-live': 'polite' }));
}
function formData(form) {
  const o = {};
  $all('input,select,textarea', form).forEach((el) => {
    if (!el.name) return;
    if (el.type === 'checkbox') o[el.name] = el.checked;
    else if (el.type === 'radio') { if (el.checked) o[el.name] = el.value; }
    else if (el.type !== 'file') o[el.name] = el.value.trim ? (el.type === 'password' ? el.value : el.value.trim()) : el.value;
  });
  return o;
}
function clearErrors(form) { $all('.err', form).forEach((e) => { e.textContent = ''; }); $all('[aria-invalid]', form).forEach((e) => e.removeAttribute('aria-invalid')); }
function showErrors(form, err) {
  clearErrors(form);
  let shown = false;
  if (err && err.fields) {
    Object.keys(err.fields).forEach((k) => {
      if (!err.fields[k]) return;
      const box = $('#e-' + CSS.escape(k), form);
      const ctrl = $('[name="' + CSS.escape(k) + '"]', form);
      if (box) { box.textContent = err.fields[k]; shown = true; }
      if (ctrl) ctrl.setAttribute('aria-invalid', 'true');
    });
    const first = $('[aria-invalid=true]', form); if (first) first.focus();
  }
  if (!shown) toastErr(err);
  else if (err.message && err.code !== 'VALIDATION') toast(err.message, 'bad');
}
async function withBusy(btn, fn) {
  if (!btn || btn.getAttribute('aria-busy') === 'true') return;
  btn.setAttribute('aria-busy', 'true'); btn.disabled = true;
  try { return await fn(); } finally { btn.removeAttribute('aria-busy'); btn.disabled = false; }
}

/* ---------- Status halaman ---------- */
function skeleton(lines) { return h('div', { class: 'stack', 'aria-busy': 'true', 'aria-label': 'Memuat' }, Array.from({ length: lines || 4 }, (_, i) => h('div', { class: 'skeleton', style: 'height:' + (i === 0 ? 28 : 18) + 'px;width:' + (90 - i * 12) + '%' }))); }
function emptyState(ic, title, text, action) { return h('div', { class: 'empty' }, h('div', { class: 'ico' }, icon(ic, 28)), h('h3', { text: title }), h('p', { text: text }), action || null); }
function errorState(err, retry) { return h('div', { class: 'state-error', role: 'alert' }, h('p', null, h('b', null, 'Gagal memuat. '), errMsg(err)), retry ? h('button', { class: 'btn sm', onclick: retry }, 'Coba lagi') : null); }
async function loadInto(container, loader, render) {
  clear(container).appendChild(skeleton());
  try { const data = await loader(); clear(container); render(data); }
  catch (e) { if (e.code === 'UNAUTHORIZED') return; clear(container).appendChild(errorState(e, () => loadInto(container, loader, render))); }
}

/* ---------- Unduh, salin, CSV, hash ---------- */
function downloadBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = h('a', { href: url, download: name, style: 'display:none' });
  document.body.appendChild(a);
  try { a.click(); } catch (e) { window.open(url, '_blank', 'noopener'); }
  setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 4000);
}
function b64ToBytes(b64) { const bin = atob(b64); const out = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i); return out; }
function bytesToB64(bytes) { let s = ''; const chunk = 0x8000; for (let i = 0; i < bytes.length; i += chunk) s += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk)); return btoa(s); }
function downloadB64(res) {
  if (res && res.url) { // URL bertanda tangan berumur pendek dari server (Content-Disposition: attachment)
    const a = h('a', { href: res.url, rel: 'noopener', download: res.fileName || '' });
    document.body.appendChild(a); a.click(); a.remove();
    return;
  }
  downloadBlob(new Blob([b64ToBytes(res.base64)], { type: res.mime || 'application/octet-stream' }), res.fileName);
}
/** Mengambil berkas dari URL bertanda tangan (Supabase Storage) sebagai byte. */
async function fetchBytes(url) {
  let r;
  try { r = await fetch(url, { cache: 'no-store', credentials: 'omit', referrerPolicy: 'no-referrer' }); } catch (e) { throw { code: 'NETWORK', message: 'Gagal mengunduh berkas. Periksa koneksi lalu coba lagi.' }; }
  if (!r.ok) throw { code: 'NOT_FOUND', message: 'Berkas tidak tersedia atau tautan sudah kedaluwarsa. Muat ulang halaman.' };
  return new Uint8Array(await r.arrayBuffer());
}
/** Mengunggah berkas langsung ke Storage memakai URL unggah bertanda tangan (tidak melewati server aplikasi). */
async function putUpload(url, file, contentType) {
  let r;
  try { r = await fetch(url, { method: 'PUT', body: file, credentials: 'omit', headers: { 'content-type': contentType || 'application/pdf', 'x-upsert': 'false' } }); }
  catch (e) { throw { code: 'NETWORK', message: 'Unggah gagal. Periksa koneksi lalu coba lagi.' }; }
  if (!r.ok) throw { code: 'SERVER_ERROR', message: 'Unggah ditolak penyimpanan (' + r.status + '). Coba lagi.' };
}
async function copyText(text) {
  try { await navigator.clipboard.writeText(text); toast('Disalin ke clipboard.', 'ok'); return; } catch (e) { /* lanjut fallback */ }
  const ta = h('textarea', { style: 'position:fixed;opacity:0' }); ta.value = text; document.body.appendChild(ta); ta.select();
  let ok = false; try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
  ta.remove();
  ok ? toast('Disalin ke clipboard.', 'ok') : openModal({ title: 'Salin manual', body: h('input', { value: text, readonly: true, onfocus: (e) => e.target.select(), autofocus: true }) });
}
function csvCell(v) {
  let s = v == null ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; // cegah formula injection saat dibuka di Excel/Sheets
  return /[",\n;]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
function downloadCsv(name, header, rows) {
  const lines = [header].concat(rows).map((r) => r.map(csvCell).join(','));
  downloadBlob(new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' }), name);
}
async function sha256Hex(buf) {
  if (!(window.crypto && crypto.subtle)) throw { message: 'Browser tidak mendukung perhitungan SHA-256.' };
  const d = await crypto.subtle.digest('SHA-256', buf);
  return Array.from(new Uint8Array(d)).map((b) => b.toString(16).padStart(2, '0')).join('');
}
function readFileBuf(file) { return new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = () => rej({ message: 'Berkas tidak dapat dibaca.' }); r.readAsArrayBuffer(file); }); }
function debounce(fn, ms) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }
function maskHash(hh) { return hh ? hh.slice(0, 12) + '…' + hh.slice(-8) : '–'; }

/* ---------- Grafik batang aksesibel (satu seri, tooltip, tabel alternatif) ---------- */
function barChart(series, opts) {
  const W = 640, H = 200, pad = { l: 34, r: 8, t: 10, b: 26 };
  const max = Math.max(1, ...series.map((s) => s.value));
  const step = (W - pad.l - pad.r) / Math.max(1, series.length);
  const bw = Math.max(2, Math.min(28, step - 2));
  const y = (v) => H - pad.b - (v / max) * (H - pad.t - pad.b);
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 ' + W + ' ' + H); svg.setAttribute('class', 'chart'); svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', (opts && opts.label) || 'Grafik');
  const mk = (tag, attrs, text) => { const e = document.createElementNS(ns, tag); for (const k in attrs) e.setAttribute(k, attrs[k]); if (text != null) e.textContent = text; svg.appendChild(e); return e; };
  [0, 0.5, 1].forEach((f) => { const v = Math.round(max * f); mk('line', { x1: pad.l, x2: W - pad.r, y1: y(v), y2: y(v), class: 'axis' }); mk('text', { x: pad.l - 6, y: y(v) + 4, 'text-anchor': 'end' }, fmtN.format(v)); });
  const tip = h('div', { class: 'chart-tip', hidden: true });
  series.forEach((s, i) => {
    const x = pad.l + i * step + (step - bw) / 2;
    const top = y(s.value);
    const hgt = Math.max(0, H - pad.b - top);
    const r = Math.min(4, bw / 2, hgt);
    const path = hgt > 0 ? 'M' + x + ',' + (H - pad.b) + 'V' + (top + r) + 'Q' + x + ',' + top + ' ' + (x + r) + ',' + top + 'H' + (x + bw - r) + 'Q' + (x + bw) + ',' + top + ' ' + (x + bw) + ',' + (top + r) + 'V' + (H - pad.b) + 'Z' : '';
    if (path) mk('path', { d: path, class: 'bar' });
    const hit = mk('rect', { x: pad.l + i * step, y: pad.t, width: step, height: H - pad.t - pad.b, fill: 'transparent', tabindex: '0', 'aria-label': s.label + ': ' + s.value });
    const show = (ev) => { tip.hidden = false; tip.textContent = s.label + ' — ' + fmtN.format(s.value) + ((opts && opts.unit) || ''); const b = hit.getBoundingClientRect(); tip.style.left = Math.min(window.innerWidth - 160, b.left + b.width / 2 - 40) + 'px'; tip.style.top = (b.top + 8) + 'px'; };
    hit.addEventListener('mouseenter', show); hit.addEventListener('focus', show);
    hit.addEventListener('mouseleave', () => { tip.hidden = true; }); hit.addEventListener('blur', () => { tip.hidden = true; });
    const every = Math.ceil(series.length / 7);
    if (i % every === 0) mk('text', { x: x + bw / 2, y: H - 8, 'text-anchor': 'middle' }, s.short || s.label);
  });
  const table = h('table', { class: 'sr-only' }, h('caption', null, (opts && opts.label) || 'Data grafik'), h('tbody', null, series.map((s) => h('tr', null, h('th', { text: s.label }), h('td', { text: String(s.value) })))));
  const toggle = h('button', { class: 'btn sm ghost', type: 'button', 'aria-expanded': 'false' }, 'Lihat sebagai tabel');
  const wrap = h('div', null, svg, toggle, table, tip);
  toggle.addEventListener('click', () => { const open = table.classList.toggle('sr-only'); toggle.setAttribute('aria-expanded', String(!open)); toggle.textContent = open ? 'Lihat sebagai tabel' : 'Sembunyikan tabel'; });
  return wrap;
}
function hbars(items, total) {
  if (!items || !items.length) return h('p', { class: 'muted small' }, 'Belum ada data.');
  const max = Math.max(1, ...items.map((i) => i.count));
  return h('div', null, items.map((i) => h('div', { class: 'hbar' }, h('span', { class: 'ellipsis', title: i.key, text: i.key }),
    h('div', { class: 'track', role: 'presentation' }, h('div', { class: 'fill', style: 'width:' + Math.round(i.count / max * 100) + '%' })),
    h('span', { class: 'small', text: fmtN.format(i.count) + (total ? ' (' + Math.round(i.count / total * 100) + '%)' : '') }))));
}
function pager(pg, onPage) {
  pg = Object.assign({}, pg, { pages: pg.pages || Math.max(1, Math.ceil((pg.total || 0) / (pg.pageSize || 20))) });
  return h('div', { class: 'pager' }, h('span', { class: 'muted small' }, 'Menampilkan ' + (pg.rows.length ? ((pg.page - 1) * pg.pageSize + 1) : 0) + '–' + ((pg.page - 1) * pg.pageSize + pg.rows.length) + ' dari ' + num(pg.total)),
    h('div', { class: 'row' }, h('button', { class: 'btn sm', disabled: pg.page <= 1 ? true : null, onclick: () => onPage(pg.page - 1) }, '‹ Sebelumnya'),
      h('span', { class: 'small' }, 'Hal. ' + pg.page + '/' + pg.pages),
      h('button', { class: 'btn sm', disabled: pg.page >= pg.pages ? true : null, onclick: () => onPage(pg.page + 1) }, 'Berikutnya ›')));
}
