/* SmartSign: beranda publik (shortlink tanpa login), harga, paket & tagihan (Mayar), panel platform superadmin */
'use strict';

const rupiah = (n) => n === 0 ? 'Gratis' : new Intl.NumberFormat('id-ID', { style: 'currency', currency: 'IDR', maximumFractionDigits: 0 }).format(n);
const PAY_META = { pending: ['b-info', 'clock', 'Menunggu pembayaran'], paid: ['b-ok', 'check', 'Lunas'], expired: ['b-gray', 'clock', 'Kedaluwarsa'], failed: ['b-bad', 'x', 'Gagal'], cancelled: ['b-gray', 'x', 'Dibatalkan'] };
const payBadge = (s) => { const m = PAY_META[s] || PAY_META.pending; return h('span', { class: 'badge ' + m[0] }, icon(m[1], 14), m[2]); };

/* ---------- penyimpanan lokal shortlink anonim (untuk diklaim setelah login) ---------- */
const AnonStore = {
  key: 'smartsign.anonLinks',
  all() { try { const v = JSON.parse(localStorage.getItem(this.key) || '[]'); return Array.isArray(v) ? v : []; } catch (e) { return []; } },
  add(item) { const v = [item].concat(this.all()).slice(0, 20); try { localStorage.setItem(this.key, JSON.stringify(v)); } catch (e) { /* mode privat */ } },
  clear() { try { localStorage.removeItem(this.key); } catch (e) { /* abaikan */ } }
};

function planCards(data, onPick) {
  return h('div', { class: 'pricing' }, data.plans.map((p) => h('div', { class: 'card plan' + (p.best ? ' best' : '') },
    p.best ? h('span', { class: 'plan-tag' }, 'Paling hemat') : null,
    h('h3', { text: p.label }),
    h('div', { class: 'price' }, h('b', { text: rupiah(p.price) }), h('span', { class: 'muted small', text: ' / ' + p.period })),
    h('ul', { class: 'plan-feat' }, p.features.map((f) => h('li', null, icon('check', 16), h('span', { text: f })))),
    onPick ? onPick(p) : null)));
}

/* ================= Beranda publik ================= */
const Home = {
  render(root) {
    const top = h('header', { class: 'home-top' },
      h('div', { class: 'brand' }, h('span', { class: 'brand-logo' }, icon('shield', 20)), BOOT.appName),
      h('nav', { class: 'row' },
        h('a', { class: 'btn ghost sm hide-sm', href: '#harga', onclick: (e) => { e.preventDefault(); $('#harga').scrollIntoView({ behavior: 'smooth' }); } }, 'Harga'),
        h('a', { class: 'btn ghost sm hide-sm', href: '/verify' }, 'Verifikasi dokumen'),
        h('button', { class: 'btn sm', onclick: () => Auth.setView('login') }, 'Masuk'),
        BOOT.allowRegistration ? h('button', { class: 'btn primary sm', onclick: () => Auth.setView('register') }, 'Daftar gratis') : null));

    const input = h('input', { id: 'h-url', name: 'destination', type: 'url', inputmode: 'url', required: true, maxlength: 2000, placeholder: 'Tempel tautan panjang, mis. https://contoh.id/halaman/sangat/panjang', autocomplete: 'off', 'aria-describedby': 'e-destination' });
    const btn = h('button', { class: 'btn primary', type: 'submit' }, icon('link', 16), 'Pendekkan');
    const hp = h('input', { name: 'website', tabindex: '-1', autocomplete: 'off', style: 'position:absolute;left:-9999px', 'aria-hidden': 'true' });
    const form = h('form', { class: 'shorten', novalidate: true }, h('label', { for: 'h-url', class: 'sr-only' }, 'Tautan panjang'),
      h('div', { class: 'shorten-row' }, input, btn), hp, h('div', { class: 'err', id: 'e-destination', role: 'alert' }));
    const result = h('div', { 'aria-live': 'polite' });
    const recent = h('div');
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      withBusy(btn, async () => {
        clearErrors(form);
        let url = input.value.trim();
        if (!url) return showErrors(form, { fields: { destination: 'Tempel tautan yang ingin dipendekkan.' } });
        if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
        try {
          const r = await rawApi('public.shorten', { destination: url, website: hp.value });
          if (!r.link) return;
          AnonStore.add({ slug: r.link.slug, shortUrl: r.link.shortUrl, destination: r.link.destination, claim: r.claim, at: new Date().toISOString() });
          input.value = '';
          Home.showResult(result, r.link);
          Home.renderRecent(recent);
        } catch (err) { showErrors(form, err.fields ? err : { fields: { destination: errMsg(err) } }); }
      });
    });

    const hero = h('section', { class: 'hero' },
      h('h1', null, 'Pendekkan tautan, buat QR, dan tanda tangani dokumen.'),
      h('p', { class: 'muted' }, 'Gratis tanpa login. Tautan diperiksa keamanannya sebelum dipendekkan. Masuk untuk memilih nama slug sendiri, melihat analitik, dan mengelola tautan.'),
      h('div', { class: 'card' }, form, result, recent));

    const feats = h('section', { class: 'grid grid-3 home-feats' },
      [['link', 'Shortlink aman', 'Pemeriksaan phishing & blocklist, halaman peringatan untuk tautan berisiko, password, jadwal, dan batas klik.'],
        ['qr', 'QR & Barcode', 'Desain QR dengan warna dan logo. Kunjungan dari QR tercatat terpisah di analitik.'],
        ['sign', 'Tanda tangan digital', 'Kirim PDF ke klien, verifikasi OTP email, sertifikat penyelesaian, dan jejak audit berantai hash.']]
        .map((f) => h('div', { class: 'card' }, h('div', { class: 'feat-ico' }, icon(f[0], 22)), h('h3', { text: f[1] }), h('p', { class: 'muted small', text: f[2] }))));

    const pricing = h('section', { id: 'harga', class: 'home-pricing' }, h('h2', null, 'Pilih paket'), h('p', { class: 'muted' }, 'Bayar sekali lewat Mayar (QRIS, transfer bank, e-wallet). Tanpa langganan otomatis.'));
    const pricingBody = h('div');
    pricing.appendChild(pricingBody);
    loadInto(pricingBody, () => rawApi('public.plans', {}), (data) => pricingBody.appendChild(planCards(data, (p) =>
      h('button', { class: 'btn ' + (p.best ? 'primary' : '') , style: 'width:100%', onclick: () => { State.afterLogin = p.price ? '#/billing' : '#/dashboard'; Auth.setView(BOOT.allowRegistration ? 'register' : 'login'); } },
        p.price ? 'Pilih ' + p.label : 'Mulai gratis'))));

    const foot = h('footer', { class: 'home-foot muted small' }, '© ' + new Date().getFullYear() + ' ' + BOOT.appName + ' · ', h('a', { href: '/verify' }, 'Verifikasi dokumen'), ' · Tanda tangan elektronik tidak tersertifikasi (bukan PSrE).');
    root.appendChild(h('div', { class: 'home' }, top, h('main', { id: 'content', class: 'home-main' }, hero, feats, pricing), foot));
    Home.renderRecent(recent);
  },
  async showResult(box, link) {
    clear(box);
    const qrBox = h('div', { class: 'qr-mini', 'aria-label': 'QR ' + link.shortUrl });
    box.appendChild(h('div', { class: 'shorten-result' },
      h('div', { class: 'grow' },
        h('div', { class: 'small muted' }, 'Shortlink Anda'),
        h('div', { class: 'short-url' }, h('a', { href: link.shortUrl, target: '_blank', rel: 'noopener', text: link.shortUrl.replace(/^https?:\/\//, '') }),
          h('button', { class: 'btn sm', type: 'button', onclick: () => copyText(link.shortUrl) }, icon('copy', 14), 'Salin')),
        h('div', { class: 'small muted ellipsis', text: '→ ' + link.destination }),
        h('div', { class: 'callout info small', style: 'margin-top:10px' }, 'Ingin mengganti nama slug, melihat statistik klik, atau menambah password? ',
          h('button', { class: 'btn sm', type: 'button', onclick: () => Auth.setView('register') }, 'Daftar gratis'), ' — tautan ini otomatis pindah ke akun Anda.')),
      qrBox));
    try {
      await loadLib('qr');
      const svg = await qrSvg(link.shortUrl + '?q=1', { size: 160, margin: 2, fg: '#000000', bg: '#ffffff', ecl: 'M', logo: false });
      qrBox.appendChild(h('img', { src: 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg), width: 120, height: 120, alt: 'Kode QR untuk ' + link.shortUrl }));
    } catch (e) { /* QR opsional */ }
  },
  renderRecent(box) {
    clear(box);
    const items = AnonStore.all();
    if (!items.length) return;
    box.appendChild(h('div', { class: 'recent' }, h('div', { class: 'small muted', style: 'margin:14px 0 6px' }, 'Shortlink terakhir di perangkat ini'),
      h('ul', { class: 'recent-list' }, items.slice(0, 5).map((it) => h('li', null,
        h('a', { class: 'mono small', href: it.shortUrl, target: '_blank', rel: 'noopener', text: it.shortUrl.replace(/^https?:\/\//, '') }),
        h('span', { class: 'small muted ellipsis grow', text: it.destination }),
        h('button', { class: 'btn ghost sm', type: 'button', 'aria-label': 'Salin ' + it.shortUrl, onclick: () => copyText(it.shortUrl) }, icon('copy', 14)))))));
  },
  /** Setelah login: pindahkan shortlink anonim dari perangkat ini ke ruang kerja pengguna. */
  async claimAfterLogin() {
    const items = AnonStore.all();
    if (!items.length || !State.me || ['admin', 'editor'].indexOf(State.me.role) < 0) return;
    try {
      const r = await rawApi('link.claim', { claims: items.map((x) => x.claim) });
      AnonStore.clear();
      if (r.claimed) toast(r.claimed + ' shortlink dari perangkat ini dipindahkan ke akun Anda. Sekarang Anda bisa mengganti slug-nya.', 'ok');
    } catch (e) { /* coba lagi pada login berikutnya */ }
    if (State.afterLogin) { location.hash = State.afterLogin; State.afterLogin = null; }
  }
};

/* ================= Paket & Tagihan ================= */
Pages.billing = (c) => {
  c.appendChild(pageHead('Paket & Tagihan', 'Kelola paket ruang kerja ' + State.me.workspaceName + '. Pembayaran diproses oleh Mayar.id.'));
  const body = h('div');
  c.appendChild(body);
  const qs = new URLSearchParams(location.search);
  const returned = qs.get('pay');
  if (returned) { try { history.replaceState(null, '', location.pathname + location.hash); } catch (e) { /* abaikan */ } }

  const load = () => loadInto(body, () => callApi('billing.get', {}), (b) => {
    const cur = b.current;
    body.appendChild(h('section', { class: 'card current-plan' },
      h('div', { class: 'row', style: 'justify-content:space-between;align-items:flex-start' },
        h('div', null, h('div', { class: 'small muted' }, 'Paket saat ini'), h('h2', { style: 'margin:2px 0 6px', text: cur.planLabel }),
          h('div', { class: 'small' }, cur.plan === 'pro' ? 'Berlaku sampai ' + dt(cur.planExpiresAt) : cur.plan === 'lifetime' ? 'Berlaku selamanya' : 'Tanpa batas waktu')),
        h('div', { class: 'stack', style: 'align-items:flex-end' },
          cur.esignEnabled ? h('span', { class: 'badge b-ok' }, icon('check', 14), 'Tanda tangan digital aktif') : h('span', { class: 'badge b-gray' }, icon('lock', 14), 'Tanda tangan digital terkunci'))),
      h('dl', { class: 'kv', style: 'margin-top:12px' }, h('dt', null, 'Batas shortlink'), h('dd', { text: num(cur.limits.links) }),
        h('dt', null, 'Dokumen per bulan'), h('dd', { text: cur.limits.docsPerMonth ? num(cur.limits.docsPerMonth) : '–' }), h('dt', null, 'Anggota tim'), h('dd', { text: num(cur.limits.members) }))));

    if (!b.paymentReady) body.appendChild(h('div', { class: 'callout warn' }, 'Pembayaran online belum dikonfigurasi oleh admin platform. Hubungi admin untuk aktivasi paket.'));
    else if (!b.canBuy) body.appendChild(h('div', { class: 'callout info' }, 'Hanya Admin ruang kerja yang dapat membeli paket.'));

    body.appendChild(h('h2', { style: 'margin:24px 0 12px' }, 'Pilih paket'));
    body.appendChild(planCards(b, (p) => {
      if (p.id === 'free') return h('button', { class: 'btn', style: 'width:100%', disabled: true }, cur.plan === 'free' ? 'Paket Anda saat ini' : 'Termasuk');
      if (cur.plan === 'lifetime') return h('button', { class: 'btn', style: 'width:100%', disabled: true }, p.id === 'lifetime' ? 'Paket Anda saat ini' : 'Sudah termasuk');
      const label = p.id === 'pro' && cur.plan === 'pro' ? 'Perpanjang 3 bulan' : 'Beli ' + p.label;
      return h('button', { class: 'btn ' + (p.best ? 'primary' : ''), style: 'width:100%', disabled: !b.canBuy || !b.paymentReady ? true : null, onclick: () => checkout(p) }, label);
    }));

    body.appendChild(h('section', { class: 'card', style: 'margin-top:24px' }, h('h2', null, 'Riwayat pembayaran'),
      !b.payments.length ? h('p', { class: 'muted' }, 'Belum ada transaksi.') :
        h('div', { class: 'table-wrap' }, h('table', { class: 'responsive' }, h('thead', null, h('tr', null, ['Tanggal', 'Paket', 'Jumlah', 'Status', ''].map((t) => h('th', { text: t })))),
          h('tbody', null, b.payments.map((x) => h('tr', null,
            h('td', { dataset: { label: 'Tanggal' }, text: dt(x.createdAt) }),
            tdm('Paket', h('span', { text: x.planLabel }), x.periodEnd ? h('div', { class: 'small muted', text: 's/d ' + d(x.periodEnd) }) : null),
            h('td', { dataset: { label: 'Jumlah' }, text: rupiah(x.amount) }),
            h('td', { dataset: { label: 'Status' } }, payBadge(x.status)),
            h('td', { dataset: { label: 'Aksi' } }, x.status === 'pending' ? h('div', { class: 'row' },
              x.payUrl ? h('a', { class: 'btn sm primary', href: x.payUrl, rel: 'noopener' }, 'Bayar') : null,
              h('button', { class: 'btn sm', onclick: (e) => withBusy(e.currentTarget, () => check(x.id)) }, 'Periksa status')) : null))))))));
  });

  async function check(id, silent) {
    try {
      const r = await callApi('billing.check', { id: id });
      toast(r.message, r.status === 'paid' ? 'ok' : r.status === 'expired' ? 'bad' : 'info');
      if (r.status === 'paid') { const m = await callApi('auth.me', {}); State.me = m.me; }
      load();
      return r;
    } catch (e) { if (!silent) toastErr(e); }
  }
  function checkout(plan) {
    const form = h('form', { novalidate: true },
      h('p', null, 'Paket ', h('b', { text: plan.label }), ' · ', h('b', { text: rupiah(plan.price) })),
      field('mobile', 'Nomor HP (untuk bukti pembayaran)', { type: 'tel', inputmode: 'tel', required: true, maxlength: 16, autocomplete: 'tel', placeholder: '081234567890', autofocus: true }),
      h('p', { class: 'small muted' }, 'Anda akan diarahkan ke halaman pembayaran Mayar.id (QRIS, transfer bank, e-wallet). Tagihan berlaku 24 jam. Setelah membayar, Anda akan kembali ke halaman ini dan paket aktif otomatis.'));
    const go = h('button', { class: 'btn primary', type: 'submit' }, 'Lanjut ke pembayaran');
    const m = openModal({ title: 'Beli paket', body: form, foot: [h('button', { class: 'btn', dataset: { close: '1' } }, 'Batal'), go] });
    const submit = (e) => {
      e.preventDefault();
      withBusy(go, async () => {
        clearErrors(form);
        try { const r = await callApi('billing.checkout', { plan: plan.id, mobile: formData(form).mobile }); m.close(); toast('Mengarahkan ke halaman pembayaran…', 'info'); location.href = r.payUrl; }
        catch (er) { showErrors(form, er); }
      });
    };
    form.addEventListener('submit', submit);
    go.addEventListener('click', submit);
  }
  load();
  if (returned) setTimeout(() => check(returned, true), 400);
};

/* ================= Platform (superadmin) ================= */
// Sel tabel berisi beberapa baris: dibungkus satu div agar tetap bertumpuk di tampilan kartu (ponsel)
function tdm(label, ...kids) { return h('td', { dataset: { label: label } }, h('div', null, ...kids)); }
Pages.platform = (c, r) => {
  if (!can.superadmin()) return Pages.notFound(c);
  const tab = ['users', 'workspaces', 'payments', 'settings'].indexOf(r.id) >= 0 ? r.id : 'users';
  c.appendChild(pageHead('Platform', 'Kelola pengguna, akses, paket, dan pembayaran seluruh platform (khusus superadmin).'));
  c.appendChild(h('div', { class: 'tabs', role: 'tablist' }, [['users', 'Pengguna'], ['workspaces', 'Ruang kerja & paket'], ['payments', 'Pembayaran'], ['settings', 'Pengaturan']]
    .map((t) => h('a', { role: 'tab', href: '#/platform/' + t[0], 'aria-selected': t[0] === tab ? 'true' : 'false', class: 'tab' + (t[0] === tab ? ' active' : '') }, t[1]))));
  const body = h('div', { style: 'margin-top:16px' });
  c.appendChild(body);
  ({ users: platUsers, workspaces: platWorkspaces, payments: platPayments, settings: platSettings })[tab](body);
};

function platUsers(body) {
  const st = { page: 1, q: '' };
  const q = h('input', { type: 'search', placeholder: 'Cari nama atau email…', 'aria-label': 'Cari pengguna' });
  const list = h('div');
  body.appendChild(h('div', { class: 'card' }, h('div', { class: 'toolbar' }, q), list));
  const load = () => loadInto(list, () => callApi('platform.users', { page: st.page, pageSize: 25, q: st.q }), (pg) => {
    if (!pg.rows.length) return list.appendChild(emptyState('team', 'Tidak ada pengguna', 'Ubah kata kunci pencarian.'));
    list.appendChild(h('div', { class: 'table-wrap' }, h('table', { class: 'responsive' }, h('thead', null, h('tr', null, ['Pengguna', 'Paket', 'Keamanan', 'Status', 'Aksi'].map((t) => h('th', { text: t })))),
      h('tbody', null, pg.rows.map((u) => h('tr', null,
        tdm('Pengguna', h('div', null, h('b', { text: u.nama || '–' }), u.platformRole === 'superadmin' ? h('span', { class: 'badge b-info', style: 'margin-left:6px' }, 'Superadmin') : null),
          h('div', { class: 'small muted', text: u.email }), h('div', { class: 'small faint', text: 'Login terakhir: ' + (u.lastLoginAt ? rel(u.lastLoginAt) : 'belum pernah') })),
        tdm('Paket', h('div', { text: u.planLabel }), u.planExpiresAt ? h('div', { class: 'small muted', text: 's/d ' + d(u.planExpiresAt) }) : null,
          h('div', { class: 'small ' + (u.esignEnabled ? '' : 'muted'), text: u.esignEnabled ? 'E-sign: aktif' : 'E-sign: terkunci' })),
        tdm('Keamanan', h('div', { class: 'small', text: (u.emailConfirmed ? '✓ Email terverifikasi' : '✗ Email belum diverifikasi') }),
          h('div', { class: 'small', text: u.mfaEnabled ? '✓ MFA aktif' : '– MFA nonaktif' }), u.mustChangePassword ? h('div', { class: 'small', style: 'color:var(--warn)', text: 'Wajib ganti password' }) : null),
        h('td', { dataset: { label: 'Status' } }, badge(u.status)),
        h('td', { dataset: { label: 'Aksi' } }, h('button', { class: 'btn sm', onclick: () => manageUser(u, load) }, 'Kelola'))))))));
    list.appendChild(pager(pg, (p) => { st.page = p; load(); }));
  });
  q.addEventListener('input', debounce(() => { st.q = q.value.trim(); st.page = 1; load(); }, 350));
  load();
}

function manageUser(u, reload) {
  const out = h('div', { 'aria-live': 'polite' });
  const act = (label, cls, fn) => h('button', { class: 'btn ' + (cls || ''), style: 'width:100%;justify-content:flex-start', onclick: (e) => withBusy(e.currentTarget, async () => { try { await fn(); } catch (er) { if (er.code !== 'CANCELLED') toastErr(er); } }) }, label);
  const isSelf = State.me && u.id === State.me.userId;
  const body = h('div', { class: 'stack' },
    h('dl', { class: 'kv' }, h('dt', null, 'Nama'), h('dd', { text: u.nama || '–' }), h('dt', null, 'Email'), h('dd', { text: u.email }),
      h('dt', null, 'Ruang kerja'), h('dd', { text: u.workspaceName || '–' }), h('dt', null, 'Paket'), h('dd', { text: u.planLabel + (u.planExpiresAt ? ' (s/d ' + d(u.planExpiresAt) + ')' : '') })),
    h('h3', null, 'Reset password'),
    act('Kirim tautan reset ke email pengguna', '', async () => { const r = await callApi('platform.resetPassword', { userId: u.id, mode: 'link' }); toast(r.message, 'ok'); }),
    act('Buat password sementara', '', async () => {
      if (!(await confirmDialog('Buat password sementara?', 'Password lama ' + u.email + ' langsung tidak berlaku dan semua sesinya dikeluarkan. Pengguna wajib mengganti password saat login berikutnya.', 'Buat password'))) return;
      const r = await callApi('platform.resetPassword', { userId: u.id, mode: 'temp' });
      clear(out).appendChild(h('div', { class: 'callout ok' }, h('div', null, h('b', null, 'Password sementara: ')), h('div', { class: 'row', style: 'margin:6px 0' }, h('code', { class: 'mono', style: 'font-size:1.05rem', text: r.tempPassword }),
        h('button', { class: 'btn sm', onclick: () => copyText(r.tempPassword) }, icon('copy', 14), 'Salin')), h('div', { class: 'small', text: r.message + ' Password ini hanya ditampilkan sekali.' })));
      reload();
    }),
    act('Reset MFA (jika kehilangan aplikasi autentikator)', '', async () => {
      if (!(await confirmDialog('Reset MFA?', 'Semua faktor MFA ' + u.email + ' dihapus dan sesinya dikeluarkan. Pastikan identitas pengguna sudah diverifikasi.', 'Reset MFA', true))) return;
      const r = await callApi('platform.resetMfa', { userId: u.id }); toast(r.message, 'ok'); reload();
    }),
    h('h3', null, 'Akses'),
    isSelf ? h('p', { class: 'small muted' }, 'Anda tidak dapat menonaktifkan atau menurunkan peran akun sendiri.') : null,
    !isSelf ? act(u.status === 'aktif' ? 'Nonaktifkan akun' : 'Aktifkan kembali akun', u.status === 'aktif' ? 'danger' : 'primary', async () => {
      const next = u.status === 'aktif' ? 'nonaktif' : 'aktif';
      if (next === 'nonaktif' && !(await confirmDialog('Nonaktifkan akun?', u.email + ' tidak akan bisa masuk dan semua sesinya dikeluarkan.', 'Nonaktifkan', true))) return;
      await callApi('platform.user', { userId: u.id, status: next }); toast('Status akun diperbarui.', 'ok'); m.close(); reload();
    }) : null,
    !isSelf ? act(u.platformRole === 'superadmin' ? 'Cabut peran superadmin' : 'Jadikan superadmin', '', async () => {
      const next = u.platformRole === 'superadmin' ? 'user' : 'superadmin';
      if (!(await confirmDialog(next === 'superadmin' ? 'Jadikan superadmin?' : 'Cabut superadmin?', next === 'superadmin' ? u.email + ' akan dapat mengelola seluruh pengguna, paket, dan pembayaran.' : u.email + ' kembali menjadi pengguna biasa.', 'Lanjutkan', next === 'superadmin'))) return;
      await callApi('platform.user', { userId: u.id, platformRole: next }); toast('Peran platform diperbarui.', 'ok'); m.close(); reload();
    }) : null,
    u.workspaceId ? act('Atur paket & akses tanda tangan digital…', '', async () => { m.close(); editWorkspacePlan({ id: u.workspaceId, nama: u.workspaceName, plan: u.plan, planExpiresAt: u.planExpiresAt, esign: 'auto' }, reload); }) : null,
    out);
  const m = openModal({ title: 'Kelola pengguna', body: body, wide: true });
}

function editWorkspacePlan(w, reload) {
  const form = h('form', { novalidate: true, class: 'form-grid' },
    field('plan', 'Paket', { type: 'select', value: w.plan, options: [['free', 'Gratis'], ['pro', 'Pro (berjangka)'], ['lifetime', 'Lifetime']] }),
    field('days', 'Lama paket Pro (hari)', { type: 'number', min: 1, max: 3650, value: 90 }, 'Hanya untuk paket Pro.'),
    h('div', { class: 'span-2' }, checkField('extend', 'Perpanjang dari tanggal berakhir saat ini (bukan dari hari ini)', true)),
    field('esign', 'Akses tanda tangan digital', { type: 'select', value: w.esign || 'auto', options: [['auto', 'Ikuti paket'], ['on', 'Selalu izinkan (hadiah/uji coba)'], ['off', 'Blokir']], span: true }),
    field('status', 'Status ruang kerja', { type: 'select', value: w.status || 'aktif', options: [['aktif', 'Aktif'], ['ditangguhkan', 'Ditangguhkan']], span: true }));
  const save = h('button', { class: 'btn primary', type: 'submit' }, 'Simpan');
  const m = openModal({ title: 'Paket: ' + w.nama, body: form, foot: [h('button', { class: 'btn', dataset: { close: '1' } }, 'Batal'), save] });
  const submit = (e) => {
    e.preventDefault();
    withBusy(save, async () => {
      const f = formData(form);
      try { await callApi('platform.workspace', { workspaceId: w.id, plan: f.plan, days: f.days, extend: f.extend, esign: f.esign, status: f.status }); toast('Paket ruang kerja diperbarui.', 'ok'); m.close(); reload(); }
      catch (er) { if (er.code !== 'CANCELLED') showErrors(form, er); }
    });
  };
  form.addEventListener('submit', submit); save.addEventListener('click', submit);
}

function platWorkspaces(body) {
  const load = () => loadInto(body, () => callApi('platform.get', {}), (p) => {
    body.appendChild(h('section', { class: 'card' }, h('div', { class: 'table-wrap' }, h('table', { class: 'responsive' },
      h('thead', null, h('tr', null, ['Ruang kerja', 'Paket', 'E-sign', 'Anggota / Link', 'Status', ''].map((t) => h('th', { text: t })))),
      h('tbody', null, p.workspaces.map((w) => h('tr', null,
        tdm('Ruang kerja', h('b', { text: w.nama }), w.system ? h('span', { class: 'badge b-gray', style: 'margin-left:6px' }, 'Sistem') : null, h('div', { class: 'small muted', text: w.owner || '' })),
        tdm('Paket', h('span', { text: w.planLabel }), w.planExpiresAt ? h('div', { class: 'small muted', text: 's/d ' + d(w.planExpiresAt) }) : null),
        h('td', { dataset: { label: 'E-sign' }, text: (w.esignEnabled ? 'Aktif' : 'Terkunci') + (w.esign !== 'auto' ? ' (manual)' : '') }),
        h('td', { dataset: { label: 'Anggota / Link' }, text: num(w.members) + ' / ' + num(w.links) }),
        h('td', { dataset: { label: 'Status' } }, badge(w.status)),
        h('td', { dataset: { label: 'Aksi' } }, w.system ? null : h('button', { class: 'btn sm', onclick: () => editWorkspacePlan(w, load) }, 'Ubah paket')))))))));
  });
  load();
}

function platPayments(body) {
  const load = () => loadInto(body, () => callApi('platform.payments', {}), (r) => {
    body.appendChild(h('div', { class: 'grid grid-3' }, h('div', { class: 'card kpi' }, h('div', { class: 'small muted' }, 'Total pendapatan'), h('b', { class: 'kpi-v', text: rupiah(r.totalPaid) })),
      h('div', { class: 'card kpi' }, h('div', { class: 'small muted' }, 'Transaksi lunas'), h('b', { class: 'kpi-v', text: num(r.countPaid) }))));
    body.appendChild(h('section', { class: 'card', style: 'margin-top:16px' }, !r.rows.length ? h('p', { class: 'muted' }, 'Belum ada transaksi.') : h('div', { class: 'table-wrap' }, h('table', { class: 'responsive' },
      h('thead', null, h('tr', null, ['Tanggal', 'Ruang kerja', 'Paket', 'Jumlah', 'Status'].map((t) => h('th', { text: t })))),
      h('tbody', null, r.rows.map((x) => h('tr', null,
        h('td', { dataset: { label: 'Tanggal' }, text: dt(x.createdAt) }),
        tdm('Ruang kerja', h('span', { text: x.workspace }), h('div', { class: 'small muted', text: x.email })),
        h('td', { dataset: { label: 'Paket' }, text: x.plan === 'lifetime' ? 'Lifetime' : 'Pro 3 Bulan' }),
        h('td', { dataset: { label: 'Jumlah' }, text: rupiah(x.amount) }),
        h('td', { dataset: { label: 'Status' } }, payBadge(x.status)))))))));
  });
  load();
}

function platSettings(body) {
  const load = () => loadInto(body, () => callApi('platform.get', {}), (p) => {
    const form = h('form', { novalidate: true, class: 'form-grid' },
      h('div', { class: 'span-2' }, checkField('allowRegistration', 'Izinkan pendaftaran mandiri', p.allowRegistration)),
      field('retentionClickDays', 'Retensi data klik (hari)', { type: 'number', min: 30, max: 3650, value: p.retentionClickDays }),
      field('retentionSecurityDays', 'Retensi log keamanan (hari)', { type: 'number', min: 30, max: 3650, value: p.retentionSecurityDays }),
      field('globalBlocklist', 'Blocklist domain global (satu per baris)', { type: 'textarea', value: p.globalBlocklist, span: true }));
    const btn = h('button', { class: 'btn primary', type: 'submit' }, 'Simpan');
    form.appendChild(h('div', { class: 'span-2' }, btn));
    form.addEventListener('submit', (e) => { e.preventDefault(); withBusy(btn, async () => { try { await callApi('platform.save', formData(form)); toast('Pengaturan platform disimpan.', 'ok'); load(); } catch (er) { showErrors(form, er); } }); });
    const okBadge = (v, yes, no) => v ? h('span', { class: 'badge b-ok' }, icon('check', 14), yes || 'Aktif') : h('span', { class: 'badge b-warn' }, icon('alert', 14), no || 'Belum dikonfigurasi');
    body.appendChild(h('div', { class: 'grid grid-2' }, h('section', { class: 'card' }, h('h2', null, 'Global'), form),
      h('section', { class: 'card' }, h('h2', null, 'Status layanan'), h('dl', { class: 'kv' },
        h('dt', null, 'Pembayaran Mayar'), h('dd', null, okBadge(p.mayar)),
        h('dt', null, 'URL webhook Mayar'), h('dd', null, h('code', { class: 'small mono', style: 'word-break:break-all', text: p.webhookUrl })),
        h('dt', null, 'Email (SMTP)'), h('dd', null, okBadge(p.smtp)),
        h('dt', null, 'Domain pendek'), h('dd', { text: p.shortDomain || '(memakai domain aplikasi)' }),
        h('dt', null, 'Google Safe Browsing'), h('dd', null, okBadge(p.safeBrowsing))),
        h('p', { class: 'small muted', style: 'margin-top:12px' }, 'Daftarkan URL webhook di dashboard Mayar → Integration → Webhook. Ganti "…" dengan nilai MAYAR_WEBHOOK_TOKEN.'))));
  });
  load();
}
