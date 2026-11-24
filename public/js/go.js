/* SmartSign: halaman pengalihan shortlink (password, peringatan risiko, laporan penyalahgunaan) */
'use strict';
(function () {
  var B = JSON.parse(document.getElementById('boot').textContent || '{}');
  var V = B.view;
  var card = document.getElementById('card');
  function el(tag, attrs, kids) {
    var e = document.createElement(tag);
    Object.keys(attrs || {}).forEach(function (k) { if (k === 'text') e.textContent = attrs[k]; else if (k.indexOf('on') === 0) e.addEventListener(k.slice(2), attrs[k]); else e.setAttribute(k, attrs[k]); });
    (kids || []).forEach(function (c) { if (c) e.appendChild(typeof c === 'string' ? document.createTextNode(c) : c); });
    return e;
  }
  function render(kids) { while (card.firstChild) card.removeChild(card.firstChild); kids.forEach(function (k) { if (k) card.appendChild(k); }); var f = card.querySelector('button,input,a'); if (f) f.focus(); }
  function call(action, payload) {
    return fetch('/api/rpc', { method: 'POST', credentials: 'same-origin', cache: 'no-store', headers: { 'content-type': 'application/json', 'x-requested-with': 'smartsign' },
      body: JSON.stringify({ action: action, payload: payload }) })
      .then(function (r) { return r.json().catch(function () { return null; }); }, function () { throw { message: 'Koneksi gagal. Periksa internet Anda.' }; })
      .then(function (r) { if (r && r.ok) return r.data; throw r || { message: 'Respons kosong.' }; });
  }
  var MSG = {
    notfound: ['Tautan tidak ditemukan', 'Shortlink ini tidak ada atau sudah dihapus. Periksa kembali alamatnya.'],
    inactive: ['Tautan tidak aktif', 'Pemilik tautan telah menonaktifkan atau mengarsipkan tautan ini.'],
    blocked: ['Tautan diblokir', 'Tautan ini diblokir karena laporan penyalahgunaan (mis. phishing). Demi keamanan Anda, tautan tidak dibuka.'],
    expired: ['Tautan kedaluwarsa', 'Masa berlaku tautan ini sudah habis.'],
    scheduled: ['Tautan belum aktif', 'Tautan ini dijadwalkan aktif nanti.'],
    limit: ['Batas penggunaan tercapai', 'Tautan ini sudah mencapai batas jumlah pembukaan.']
  };
  function go(url) {
    var a = el('a', { class: 'btn p', href: url, rel: 'noopener noreferrer', text: 'Lanjutkan ke tujuan' });
    try { window.location.replace(url); } catch (e) { /* abaikan; tombol cadangan ditampilkan */ }
    setTimeout(function () {
      render([el('h1', { text: 'Membuka tautan…' }), el('p', { class: 'm', text: 'Jika halaman tidak terbuka otomatis, tekan tombol di bawah.' }),
        el('div', { class: 'domain', text: hostOf(url) }), el('div', { class: 'row' }, [a])]);
    }, 900);
  }
  function hostOf(u) { var m = /^https?:\/\/([^\/?#:]+)/i.exec(u); return m ? m[1] : u; }
  function open(pw, btn) {
    if (btn) { btn.disabled = true; btn.textContent = 'Memproses…'; }
    call('public.open', { slug: V.slug, src: B.src, ref: document.referrer || '', password: pw || '' }).then(function (r) {
      if (r.state === 'ok' && r.url) return pw && V.interstitial ? interstitial(r.url) : go(r.url);
      if (r.state === 'password') return passwordView(r.error);
      showState(r.state);
    }).catch(function (e) { render([el('h1', { text: 'Gagal membuka tautan' }), el('p', { class: 'bad', text: e.message || 'Terjadi kesalahan.' }), el('div', { class: 'row' }, [el('button', { class: 'btn p', text: 'Coba lagi', onclick: function () { open(pw); } })])]); });
  }
  function reportLink() {
    var reason = el('select', { id: 'r' }, [['phishing', 'Phishing / pencurian data'], ['penipuan', 'Penipuan'], ['malware', 'Malware'], ['spam', 'Spam'], ['lainnya', 'Lainnya']].map(function (o) { return el('option', { value: o[0], text: o[1] }); }));
    var detail = el('textarea', { id: 'd', maxlength: '500', rows: '3' });
    var send = el('button', { class: 'btn p', text: 'Kirim laporan', onclick: function () {
      send.disabled = true;
      call('public.report', { slug: V.slug, reason: reason.value, detail: detail.value }).then(function (r) { render([el('h1', { text: 'Laporan terkirim' }), el('p', { class: 'm', text: r.message })]); })
        .catch(function (e) { send.disabled = false; alert_(e.message); });
    } });
    render([el('h1', { text: 'Laporkan tautan' }), el('p', { class: 'm small', text: 'Laporan bersifat anonim dan akan ditinjau.' }), el('label', { for: 'r', text: 'Alasan' }), reason, el('label', { for: 'd', text: 'Keterangan (opsional)' }), detail,
      el('div', { class: 'row' }, [send, el('button', { class: 'btn', text: 'Kembali', onclick: start })])]);
  }
  function alert_(m) { var p = el('p', { class: 'bad', role: 'alert', text: m }); card.appendChild(p); }
  function passwordView(err) {
    var inp = el('input', { type: 'password', id: 'pw', autocomplete: 'off', maxlength: '64' });
    var b = el('button', { class: 'btn p', text: 'Buka', type: 'submit' });
    var f = el('form', { onsubmit: function (e) { e.preventDefault(); if (inp.value) open(inp.value, b); } }, [el('label', { for: 'pw', text: 'Password tautan' }), inp, err ? el('p', { class: 'bad', role: 'alert', text: err }) : null, el('div', { class: 'row' }, [b])]);
    render([el('h1', { text: 'Tautan dilindungi password' }), el('p', { class: 'm', text: 'Masukkan password yang diberikan pemilik tautan.' }), f]);
  }
  function showState(state) {
    var m = MSG[state] || MSG.notfound;
    render([el('h1', { text: m[0] }), el('p', { class: state === 'blocked' ? 'bad' : 'm', text: m[1] + (state === 'scheduled' && V.activeFrom ? ' Aktif mulai ' + new Date(V.activeFrom).toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' }) + ' WIB.' : '') }),
      el('p', { class: 'small m', text: B.appName + ', layanan shortlink aman.' })]);
  }
  function interstitial(url) {
    var domain = url ? hostOf(url) : V.domain;
    var kids = [el('h1', { text: V.risky ? 'Periksa sebelum melanjutkan' : 'Anda akan meninggalkan ' + B.appName }),
      el('p', { class: 'm', text: 'Tautan ini akan membuka situs di domain:' }), el('div', { class: 'domain', text: domain })];
    if (V.risky && V.flags && V.flags.length) kids.push(el('div', { class: 'warn' }, [el('b', { text: 'Indikasi risiko:' }), el('ul', {}, V.flags.map(function (f) { return el('li', { text: f }); }))]));
    kids.push(el('p', { class: 'small m', text: 'Jangan masukkan password, PIN, atau OTP jika Anda tidak yakin situs ini resmi.' }));
    var btn = el('button', { class: 'btn' + (V.risky ? '' : ' p'), text: 'Lanjutkan ke ' + domain, onclick: function () { if (url) go(url); else open('', btn); } });
    kids.push(el('div', { class: 'row' }, [btn, el('button', { class: 'btn', text: 'Laporkan tautan', onclick: reportLink })]));
    render(kids);
  }
  function start() {
    if (V.state !== 'ok') return showState(V.state);
    if (V.hasPassword) return passwordView();
    if (V.interstitial) return interstitial();
    open('');
  }
  start();
})();
