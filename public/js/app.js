/* SmartSign: shell aplikasi, autentikasi, dasbor, shortlink, QR, analitik */
'use strict';
/* ============ Shell aplikasi, autentikasi, dasbor, shortlink, QR, analitik ============ */
const ROLE_ALL = ['admin', 'editor', 'viewer', 'auditor'];
const NAV = [
  { group: 'Utama', items: [['dashboard', 'Dasbor', 'home', ROLE_ALL], ['links', 'Shortlink', 'link', ROLE_ALL], ['qr', 'QR & Barcode', 'qr', ROLE_ALL],
    ['docs', 'E-Signature', 'sign', ROLE_ALL], ['scanner', 'Scanner', 'scan', ROLE_ALL], ['analytics', 'Analitik', 'chart', ROLE_ALL]] },
  { group: 'Kelola', items: [['team', 'Tim & Anggota', 'team', ['admin']], ['security', 'Keamanan Akun', 'shield', ROLE_ALL],
    ['audit', 'Log Audit', 'log', ['admin', 'auditor']], ['billing', 'Paket & Tagihan', 'check', ROLE_ALL], ['settings', 'Pengaturan', 'gear', ['admin']]] }
];
const can = {
  edit: () => State.me && ['admin', 'editor'].indexOf(State.me.role) >= 0,
  admin: () => State.me && State.me.role === 'admin',
  audit: () => State.me && ['admin', 'auditor'].indexOf(State.me.role) >= 0,
  superadmin: () => State.me && State.me.platformRole === 'superadmin'
};
const Pages = {};

const App = {
  async start() {
    State.theme = (window.matchMedia && matchMedia('(prefers-color-scheme: dark)').matches) ? 'dark' : 'light';
    document.documentElement.dataset.theme = State.theme;
    window.addEventListener('hashchange', () => App.renderRoute());
    document.addEventListener('click', App.onClick);
    if ((BOOT.mode || 'app') === 'app') {
      clear($('#app')).appendChild(h('div', { class: 'auth-wrap' }, skeleton(3)));
      try { const r = await rawApi('auth.me', {}); State.token = 'cookie'; State.me = r.me; Home.claimAfterLogin(); }
      catch (e) { if (e.code === 'MFA_REQUIRED') { State.authView = 'mfa'; State.mfaTicket = 'session'; } }
    }
    App.render();
    if (BOOT.notice) setTimeout(() => toast(BOOT.notice, BOOT.noticeType || 'ok'), 200);
  },
  onClick(e) {
    const a = e.target.closest('[data-action]');
    if (!a) return;
    const fn = Actions[a.dataset.action];
    if (fn) { e.preventDefault(); fn(a, e); }
  },
  go(route) { if (location.hash === '#/' + route) App.renderRoute(); else location.hash = '#/' + route; },
  parseHash() {
    const raw = (location.hash || '').replace(/^#\/?/, '');
    const [path, query] = raw.split('?');
    const parts = path.split('/').filter(Boolean);
    const params = {};
    (query || '').split('&').filter(Boolean).forEach((kv) => { const [k, v] = kv.split('='); params[decodeURIComponent(k)] = decodeURIComponent(v || ''); });
    return { page: parts[0] || 'dashboard', id: parts[1] || '', sub: parts[2] || '', params: params };
  },
  render() {
    const root = clear($('#app'));
    const mode = BOOT.mode || 'app';
    if (mode !== 'app' && PublicPages[mode] && !State.publicDone) return PublicPages[mode](root);
    if (!State.token) return Auth.screen(root, State.authView || 'home');
    if (State.me.mustChangePassword) return Auth.forceChangePassword(root);
    if (State.me.mfaSetupRequired) return Auth.forceMfa(root);
    App.shell(root);
    App.renderRoute();
  },
  shell(root) {
    const me = State.me;
    const navEl = h('nav', { class: 'nav', 'aria-label': 'Navigasi utama' },
      NAV.map((g) => [h('div', { class: 'nav-group', text: g.group }),
        g.items.filter((it) => it[3].indexOf(me.role) >= 0).map((it) => h('a', { href: '#/' + it[0], dataset: { nav: it[0] } }, icon(it[2]), it[1]))]),
      can.superadmin() ? h('a', { href: '#/platform', dataset: { nav: 'platform' } }, icon('gear'), 'Platform (superadmin)') : null);
    const sidebar = h('aside', { class: 'sidebar', id: 'sidebar' }, h('div', { class: 'brand' }, h('span', { class: 'brand-logo' }, icon('shield', 20)), BOOT.appName), navEl);
    const wsSelect = me.workspaces.length > 1 ? h('select', { 'aria-label': 'Ganti ruang kerja', style: 'max-width:220px', onchange: (e) => Actions.switchWs(e.target) },
      me.workspaces.map((w) => h('option', { value: w.workspaceId, selected: w.workspaceId === me.workspaceId ? true : null }, w.nama))) : h('span', { class: 'ws-name', text: me.workspaceName });
    const top = h('header', { class: 'topbar' },
      h('button', { class: 'btn ghost icon menu-btn', 'aria-label': 'Buka menu', dataset: { action: 'toggleMenu' } }, icon('menu')),
      h('div', { class: 'grow' }, wsSelect, h('div', { class: 'small muted ellipsis' }, me.nama + ' · ' + me.roleLabel)),
      h('button', { class: 'btn ghost icon', 'aria-label': 'Ganti tema terang/gelap', dataset: { action: 'toggleTheme' } }, icon('moon')),
      h('button', { class: 'btn sm', dataset: { action: 'logout' } }, icon('logout', 16), h('span', { class: 'hide-sm' }, 'Keluar')));
    const bottom = h('nav', { class: 'bottom-nav', 'aria-label': 'Navigasi cepat' },
      [['dashboard', 'Dasbor', 'home'], ['links', 'Link', 'link'], ['scanner', 'Scan', 'scan'], ['docs', 'TTD', 'sign']].map((it) => h('a', { href: '#/' + it[0], dataset: { nav: it[0] } }, icon(it[2]), it[1])),
      h('a', { href: '#', dataset: { action: 'toggleMenu' } }, icon('menu'), 'Menu'));
    root.appendChild(h('div', { class: 'shell' }, sidebar, h('div', { class: 'main' }, top, h('main', { class: 'content', id: 'content', tabindex: '-1' })), bottom));
  },
  renderRoute() {
    const content = $('#content');
    if (!content) return;
    const r = App.parseHash();
    State.route = r.page; State.params = r;
    $all('[data-nav]').forEach((a) => { if (a.dataset.nav === r.page) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current'); });
    if (State.cleanup) { try { State.cleanup(); } catch (e) { /* abaikan */ } State.cleanup = null; }
    const sb = $('#sidebar'); if (sb) sb.classList.remove('open');
    const sc = $('.scrim'); if (sc) sc.remove();
    clear(content);
    const fn = Pages[r.page] || Pages.notFound;
    try { fn(content, r); } catch (e) { console.error(e); content.appendChild(errorState(e)); }
    content.focus({ preventScroll: true });
    window.scrollTo(0, 0);
  }
};

const Actions = {
  toggleMenu() {
    const sb = $('#sidebar');
    if (!sb) return;
    const open = !sb.classList.contains('open');
    sb.classList.toggle('open', open);
    if (open) { const s = h('div', { class: 'scrim', onclick: () => Actions.toggleMenu() }); document.body.appendChild(s); $('a', sb).focus(); }
    else { const s = $('.scrim'); if (s) s.remove(); }
  },
  toggleTheme() { State.theme = State.theme === 'dark' ? 'light' : 'dark'; document.documentElement.dataset.theme = State.theme; },
  async logout(btn) {
    await withBusy(btn, async () => { try { await callApi('auth.logout', {}, { noRedirect: true }); } catch (e) { /* tetap keluar */ } });
    State.token = null; State.me = null; State.authView = 'home';
    toast('Anda telah keluar.', 'ok'); App.render();
  },
  async switchWs(sel) {
    try { const r = await callApi('auth.switchWorkspace', { workspaceId: sel.value }); State.me = r.me; App.render(); toast('Ruang kerja diganti ke ' + r.me.workspaceName + '.', 'ok'); }
    catch (e) { toastErr(e); }
  },
  copy(el) { copyText(el.dataset.text); },
  go(el) { App.go(el.dataset.to); }
};

function pageHead(title, desc, actions) {
  return h('div', { class: 'page-head' }, h('div', null, h('h1', { text: title }), desc ? h('p', { text: desc }) : null), actions ? h('div', { class: 'row' }, actions) : null);
}
Pages.notFound = (c) => c.appendChild(emptyState('help', 'Halaman tidak ditemukan', 'Alamat yang Anda buka tidak tersedia.', h('a', { class: 'btn primary', href: '#/dashboard' }, 'Ke Dasbor')));

/* ================= Autentikasi ================= */
const Auth = {
  frame(root, title, sub, body, foot) {
    root.appendChild(h('div', { class: 'auth-wrap' }, h('div', { class: 'card auth-card' },
      h('div', { class: 'brand' }, h('span', { class: 'brand-logo' }, icon('shield', 20)), BOOT.appName),
      h('h1', { style: 'text-align:center;font-size:1.25rem', text: title }), sub ? h('p', { class: 'muted', style: 'text-align:center', text: sub }) : null, body, foot || null,
      h('p', { style: 'text-align:center;margin-top:14px' }, h('button', { class: 'btn ghost sm', type: 'button', onclick: () => Auth.setView('home') }, '← Kembali ke beranda')))));
  },
  screen(root, view) {
    if (view === 'register') return Auth.register(root);
    if (view === 'forgot') return Auth.forgot(root);
    if (view === 'mfa') return Auth.mfa(root);
    if (view === 'login') return Auth.login(root);
    return Home.render(root);
  },
  setView(v) { State.authView = v; App.render(); },
  login(root) {
    const form = h('form', { novalidate: true },
      field('email', 'Email', { type: 'email', autocomplete: 'username', required: true, autofocus: true, maxlength: 120 }),
      field('password', 'Password', { type: 'password', autocomplete: 'current-password', required: true, maxlength: 128 }));
    const btn = h('button', { class: 'btn primary', type: 'submit', style: 'width:100%' }, 'Masuk');
    form.appendChild(btn);
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      withBusy(btn, async () => {
        const data = formData(form);
        clearErrors(form);
        if (!data.email || !data.password) return showErrors(form, { fields: { email: data.email ? '' : 'Wajib diisi.', password: data.password ? '' : 'Wajib diisi.' } });
        try {
          const r = await rawApi('auth.login', Object.assign(data, { ua: navigator.userAgent }));
          if (r.mfaRequired) { State.mfaTicket = r.ticket; return Auth.setView('mfa'); }
          Auth.done(r);
        } catch (err) {
          if (err.code === 'FORBIDDEN' && /verifikasi/i.test(err.message)) {
            showErrors(form, err);
            form.appendChild(h('button', { class: 'btn sm', type: 'button', style: 'margin-top:10px', onclick: async (ev) => {
              await withBusy(ev.currentTarget, async () => { try { const r2 = await rawApi('auth.resendVerify', { email: data.email }); toast(r2.message, 'ok'); } catch (e2) { toastErr(e2); } });
            } }, 'Kirim ulang email verifikasi'));
          } else showErrors(form, err);
        }
      });
    });
    Auth.frame(root, 'Masuk ke akun Anda', BOOT.tagline, form, h('div', { class: 'stack', style: 'margin-top:14px;text-align:center' },
      h('button', { class: 'btn ghost', onclick: () => Auth.setView('forgot') }, 'Lupa password?'),
      BOOT.allowRegistration ? h('p', { class: 'small' }, 'Belum punya akun? ', h('button', { class: 'btn sm', onclick: () => Auth.setView('register') }, 'Daftar gratis')) : null,
      h('a', { class: 'small', href: '/verify' }, 'Verifikasi dokumen tanpa login'),
      h('p', { class: 'faint small' }, 'Sesi disimpan dalam cookie aman (httpOnly) dan berakhir otomatis. Selalu keluar di perangkat bersama.')));
  },
  mfa(root) {
    const form = h('form', { novalidate: true },
      h('p', { class: 'muted' }, 'Masukkan 6 digit kode dari aplikasi autentikator Anda, atau kode pemulihan (format XXXX-XXXX).'),
      field('code', 'Kode verifikasi', { inputmode: 'text', autocomplete: 'one-time-code', required: true, maxlength: 9, class: 'otp-input', autofocus: true }));
    const btn = h('button', { class: 'btn primary', type: 'submit', style: 'width:100%' }, 'Verifikasi');
    form.appendChild(btn);
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      withBusy(btn, async () => {
        try { await Auth.done(await rawApi('auth.mfa', { ticket: State.mfaTicket, code: formData(form).code })); }
        catch (err) { if (err.code === 'UNAUTHORIZED') { toast(err.message, 'bad'); Auth.setView('login'); } else showErrors(form, err); }
      });
    });
    Auth.frame(root, 'Verifikasi dua langkah', null, form, h('button', { class: 'btn ghost', style: 'width:100%;margin-top:10px', onclick: () => Auth.setView('login') }, 'Kembali'));
  },
  async done(r) {
    State.token = r.token; State.me = r.me; State.authView = 'login'; State.mfaTicket = null;
    if (State.pendingInvite && !r.me.mustChangePassword && !r.me.mfaSetupRequired) {
      try { const inv = await callApi('invite.accept', { token: State.pendingInvite }); State.me = inv.me; toast('Undangan diterima. Anda kini di ' + inv.me.workspaceName + '.', 'ok'); }
      catch (e) { toastErr(e); }
      State.pendingInvite = null;
    }
    toast('Selamat datang, ' + State.me.nama + '.', 'ok');
    await Home.claimAfterLogin();
    if (!location.hash) location.hash = '#/dashboard';
    App.render();
  },
  register(root) {
    const form = h('form', { novalidate: true },
      field('nama', 'Nama lengkap', { required: true, maxlength: 80, autocomplete: 'name', autofocus: true }),
      field('email', 'Email', { type: 'email', required: true, maxlength: 120, autocomplete: 'email' }),
      field('password', 'Password', { type: 'password', required: true, maxlength: 128, autocomplete: 'new-password' }, 'Minimal ' + BOOT.passwordMin + ' karakter, kombinasi huruf dan angka.'),
      h('div', { style: 'position:absolute;left:-9999px', 'aria-hidden': 'true' }, h('label', { for: 'f-website' }, 'Website'), h('input', { id: 'f-website', name: 'website', tabindex: '-1', autocomplete: 'off' })),
      checkField('agree', 'Saya menyetujui pemrosesan data pribadi sesuai UU PDP No. 27/2022 untuk keperluan layanan ini.', false));
    const btn = h('button', { class: 'btn primary', type: 'submit', style: 'width:100%' }, 'Buat akun');
    form.appendChild(btn);
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      withBusy(btn, async () => {
        try { const r = await rawApi('auth.register', formData(form)); clear(form).appendChild(h('div', { class: 'callout ok', role: 'status' }, r.message)); }
        catch (err) { showErrors(form, err); }
      });
    });
    Auth.frame(root, 'Daftar akun baru', 'Ruang kerja pribadi akan dibuat otomatis.', form, h('button', { class: 'btn ghost', style: 'width:100%;margin-top:10px', onclick: () => Auth.setView('login') }, 'Sudah punya akun? Masuk'));
  },
  forgot(root) {
    const form = h('form', { novalidate: true }, field('email', 'Email terdaftar', { type: 'email', required: true, autofocus: true, maxlength: 120 }));
    const btn = h('button', { class: 'btn primary', type: 'submit', style: 'width:100%' }, 'Kirim tautan reset');
    form.appendChild(btn);
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      withBusy(btn, async () => {
        try { const r = await rawApi('auth.forgot', formData(form)); clear(form).appendChild(h('div', { class: 'callout ok', role: 'status' }, r.message)); }
        catch (err) { showErrors(form, err); }
      });
    });
    Auth.frame(root, 'Lupa password', 'Kami akan mengirim tautan sekali pakai ke email Anda.', form, h('button', { class: 'btn ghost', style: 'width:100%;margin-top:10px', onclick: () => Auth.setView('login') }, 'Kembali ke halaman masuk'));
  },
  forceChangePassword(root) {
    const form = changePasswordForm(() => { State.me.mustChangePassword = false; toast('Password diperbarui.', 'ok'); App.render(); });
    Auth.frame(root, 'Ganti password sementara', 'Akun Anda memakai password sementara. Buat password baru untuk melanjutkan.', form,
      h('button', { class: 'btn ghost', style: 'width:100%;margin-top:10px', dataset: { action: 'logout' } }, 'Keluar'));
  },
  forceMfa(root) {
    const box = h('div');
    Auth.frame(root, 'Aktifkan verifikasi dua langkah', 'Kebijakan ruang kerja mewajibkan admin memakai MFA (TOTP).', box,
      h('button', { class: 'btn ghost', style: 'width:100%;margin-top:10px', dataset: { action: 'logout' } }, 'Keluar'));
    mfaSetupFlow(box, () => App.render());
  }
};
function changePasswordForm(onDone) {
  const form = h('form', { novalidate: true },
    field('oldPassword', 'Password saat ini', { type: 'password', required: true, autocomplete: 'current-password' }),
    field('newPassword', 'Password baru', { type: 'password', required: true, autocomplete: 'new-password' }, 'Minimal ' + (BOOT.passwordMin || 10) + ' karakter, kombinasi huruf dan angka, tidak memuat nama email.'),
    field('confirm', 'Ulangi password baru', { type: 'password', required: true, autocomplete: 'new-password' }));
  const btn = h('button', { class: 'btn primary', type: 'submit' }, 'Simpan password');
  form.appendChild(btn);
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const dta = formData(form);
    if (dta.newPassword !== dta.confirm) return showErrors(form, { fields: { confirm: 'Password tidak sama.' } });
    withBusy(btn, async () => {
      try { const r = await callApi('auth.changePassword', dta); form.reset(); clearErrors(form); toast('Password diubah. ' + r.revoked + ' sesi lain dikeluarkan.', 'ok'); if (onDone) onDone(); }
      catch (err) { showErrors(form, err); }
    });
  });
  return form;
}
async function mfaSetupFlow(box, onDone) {
  clear(box).appendChild(skeleton(3));
  try {
    const r = await callApi('auth.mfaStart', {});
    const cv = h('canvas', { 'aria-label': 'Kode QR untuk aplikasi autentikator' });
    await drawQr(cv, r.otpauth, { size: 220, margin: 4, fg: '#000000', bg: '#ffffff', ecl: 'M' });
    const form = h('form', { novalidate: true }, field('code', 'Masukkan 6 digit kode dari aplikasi', { inputmode: 'numeric', maxlength: 6, required: true, class: 'otp-input', autocomplete: 'one-time-code' }));
    const btn = h('button', { class: 'btn primary', type: 'submit', style: 'width:100%' }, 'Aktifkan MFA');
    form.appendChild(btn);
    clear(box).append(
      h('ol', { class: 'small' }, h('li', null, 'Pasang aplikasi autentikator (Google Authenticator, Microsoft Authenticator, Aegis, 1Password, dll.).'),
        h('li', null, 'Pindai kode QR di bawah, atau masukkan kunci secara manual.'), h('li', null, 'Masukkan kode 6 digit yang muncul.')),
      h('div', { class: 'qr-stage', style: 'min-height:0' }, cv),
      h('p', { class: 'small', style: 'margin-top:10px' }, 'Kunci manual: ', h('code', { text: r.secret.replace(/(.{4})/g, '$1 ').trim() })), form);
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      withBusy(btn, async () => {
        try {
          const res = await callApi('auth.mfaConfirm', formData(form));
          State.me = res.me;
          showRecoveryCodes(res.recoveryCodes, onDone);
        } catch (err) { showErrors(form, err); }
      });
    });
  } catch (e) { clear(box).appendChild(errorState(e, () => mfaSetupFlow(box, onDone))); }
}
function showRecoveryCodes(codes, onDone) {
  const txt = 'Kode pemulihan ' + BOOT.appName + ' (' + (State.me ? State.me.email : '') + ')\nSetiap kode hanya bisa dipakai sekali.\n\n' + codes.join('\n');
  openModal({ title: 'Simpan kode pemulihan', sticky: true,
    body: h('div', null, h('div', { class: 'callout warn' }, 'Kode ini hanya ditampilkan SEKALI. Simpan di tempat aman; gunakan bila ponsel autentikator hilang.'),
      h('div', { class: 'codes', style: 'margin-top:12px' }, codes.map((c) => h('span', { text: c })))),
    foot: [h('button', { class: 'btn', onclick: () => downloadBlob(new Blob([txt], { type: 'text/plain' }), 'kode-pemulihan.txt') }, icon('download', 16), 'Unduh .txt'),
      h('button', { class: 'btn', onclick: () => copyText(codes.join('\n')) }, icon('copy', 16), 'Salin'),
      h('button', { class: 'btn primary', dataset: { close: '1' } }, 'Sudah saya simpan')],
    onClose: () => { if (onDone) onDone(); } });
}

/* ================= Dasbor ================= */
const AUDIT_LABEL = {
  'auth.login': 'Masuk', 'auth.logout': 'Keluar', 'auth.register': 'Registrasi', 'link.create': 'Membuat shortlink', 'link.update': 'Mengubah shortlink',
  'link.status': 'Mengubah status shortlink', 'link.delete': 'Menghapus shortlink', 'doc.upload': 'Mengunggah dokumen', 'doc.send': 'Mengirim dokumen',
  'doc.setup': 'Menyiapkan dokumen', 'doc.void': 'Membatalkan dokumen', 'doc.completed': 'Dokumen selesai', 'doc.download': 'Mengunduh dokumen',
  'doc.finalize': 'Membuat PDF final', 'code.save': 'Menyimpan desain QR', 'member.invite': 'Mengundang anggota', 'member.role': 'Mengubah peran',
  'member.status': 'Mengubah status anggota', 'workspace.settings': 'Mengubah pengaturan', 'auth.mfaEnabled': 'Mengaktifkan MFA', 'auth.changePassword': 'Mengganti password',
  'audit.export': 'Mengekspor audit', 'scan.report': 'Mengunduh laporan verifikasi'
};
Pages.dashboard = (c) => {
  c.appendChild(pageHead('Dasbor', 'Ringkasan aktivitas ruang kerja ' + State.me.workspaceName + '.', can.edit() ? [
    h('a', { class: 'btn primary', href: '#/links?new=1' }, icon('plus', 16), 'Buat shortlink'),
    h('a', { class: 'btn', href: '#/docs/new' }, icon('sign', 16), 'Kirim dokumen'),
    h('a', { class: 'btn', href: '#/scanner' }, icon('scan', 16), 'Scanner')] : [h('a', { class: 'btn primary', href: '#/scanner' }, icon('scan', 16), 'Buka Scanner')]));
  const body = h('div');
  c.appendChild(body);
  loadInto(body, () => callApi('dashboard.get', {}), (dta) => {
    const k = dta.kpi;
    const tile = (label, value, sub, href) => h(href ? 'a' : 'div', { class: 'card kpi', href: href || null, style: href ? 'text-decoration:none;color:inherit' : null },
      h('div', { class: 'label', text: label }), h('div', { class: 'value', text: value }), sub ? h('div', { class: 'sub', text: sub }) : null);
    body.appendChild(h('div', { class: 'grid grid-kpi' },
      tile('Shortlink aktif', num(k.activeLinks), 'dari ' + num(k.totalLinks) + ' tautan', '#/links'),
      tile('Klik 14 hari', num(k.clicks14), num(k.qr14) + ' dari pindaian QR', '#/analytics'),
      tile('Menunggu tanda tangan', num(k.waitingDocs), 'dokumen sedang berjalan', '#/docs?status=waiting'),
      tile('Dokumen selesai', num(k.completed30), '30 hari terakhir', '#/docs?status=completed'),
      tile('Verifikasi & scan', num(k.verifications30), num(k.verificationValid30) + ' valid · 30 hari', '#/scanner'),
      tile('Tingkat penyelesaian', k.completionRate == null ? '–' : k.completionRate + '%', k.medianHoursToSign == null ? 'median waktu tanda tangan –' : 'median ' + String(k.medianHoursToSign).replace('.', ',') + ' jam')));
    const ob = dta.onboarding;
    const steps = [[true, 'Verifikasi email'], [ob.mfa, 'Aktifkan MFA', '#/security'], [ob.link, 'Buat shortlink pertama', '#/links?new=1'], [ob.qr, 'Simpan desain QR', '#/qr'], [ob.doc, 'Kirim dokumen pertama', '#/docs/new'], [ob.member, 'Undang anggota tim', '#/team']];
    const doneCount = steps.filter((s) => s[0]).length;
    const grid = h('div', { class: 'grid grid-2', style: 'margin-top:16px' });
    grid.appendChild(h('section', { class: 'card' }, h('div', { class: 'card-head' }, h('h2', null, 'Klik shortlink, 14 hari'), h('span', { class: 'small muted' }, num(k.clicks14) + ' total')),
      barChart(dta.series.map((s) => ({ label: d(s.date), short: s.date.slice(8) + '/' + s.date.slice(5, 7), value: s.total })), { label: 'Jumlah klik per hari, 14 hari terakhir', unit: ' klik' })));
    grid.appendChild(h('section', { class: 'card' }, h('div', { class: 'card-head' }, h('h2', null, 'Menunggu tanda tangan'), h('a', { href: '#/docs?status=waiting', class: 'small' }, 'Lihat semua')),
      dta.waiting.length ? h('ul', { class: 'timeline' }, dta.waiting.map((w) => h('li', null, h('a', { href: '#/docs/' + w.id, class: 'title', text: w.title }), h('div', { class: 'row small' }, badge(w.status), h('span', { class: 'muted' }, w.progress.signed + '/' + w.progress.total + ' tanda tangan · berakhir ' + d(w.expiresAt))))))
        : emptyState('sign', 'Tidak ada yang menunggu', 'Semua dokumen sudah selesai atau belum dikirim.')));
    grid.appendChild(h('section', { class: 'card' }, h('h2', null, 'Tautan teratas (14 hari)'),
      dta.topLinks.length ? hbars(dta.topLinks.map((t) => ({ key: t.title + ' (/' + t.slug + ')', count: t.count }))) : h('p', { class: 'muted' }, 'Belum ada klik.')));
    grid.appendChild(h('section', { class: 'card' }, h('div', { class: 'card-head' }, h('h2', null, 'Langkah awal'), h('span', { class: 'badge b-info' }, doneCount + '/' + steps.length)),
      h('ul', { style: 'list-style:none;padding:0;margin:0' }, steps.map((s) => h('li', { class: 'row', style: 'padding:6px 0' }, s[0] ? badge('ok', 'Selesai') : badge('pending', 'Belum'),
        s[2] && !s[0] ? h('a', { href: s[2], text: s[1] }) : h('span', { text: s[1] }))))));
    body.appendChild(grid);
    body.appendChild(h('section', { class: 'card', style: 'margin-top:16px' }, h('div', { class: 'card-head' }, h('h2', null, 'Aktivitas terbaru'), can.audit() ? h('a', { href: '#/audit', class: 'small' }, 'Log audit lengkap') : null),
      dta.recent.length ? h('ul', { class: 'timeline' }, dta.recent.map((a) => h('li', null, h('b', { text: AUDIT_LABEL[a.action] || a.action }), h('div', { class: 'small muted' }, (a.userEmail || 'sistem') + ' · ' + dt(a.waktu)))))
        : h('p', { class: 'muted' }, 'Belum ada aktivitas.')));
    body.appendChild(h('p', { class: 'small faint', style: 'margin-top:12px' }, 'Paket ' + dta.plan.label + ': ' + num(dta.plan.linksUsed) + '/' + num(dta.plan.links) + ' shortlink terpakai.'));
  });
};

/* ================= Shortlink ================= */
function shortDisp(u) { const s = String(u || '').replace(/^https?:\/\//, ''); return s.length > 48 ? '…' + s.slice(-47) : s; }
Pages.links = (c, r) => {
  const st = { page: 1, q: r.params.q || '', status: r.params.status || '', sort: '' };
  c.appendChild(pageHead('Shortlink', 'Buat, kelola, dan pantau tautan pendek. QR tetap berlaku walau tujuan diubah.', [
    can.edit() ? h('button', { class: 'btn primary', onclick: () => linkForm(null, reload) }, icon('plus', 16), 'Buat shortlink') : null,
    can.edit() ? h('button', { class: 'btn', onclick: () => bulkImport(reload) }, icon('upload', 16), 'Impor massal') : null,
    ['admin', 'editor', 'auditor'].indexOf(State.me.role) >= 0 ? h('button', { class: 'btn', onclick: (e) => withBusy(e.currentTarget, async () => {
      try { const x = await callApi('link.export', {}); downloadCsv('shortlink-' + new Date().toISOString().slice(0, 10) + '.csv', x.header, x.rows); } catch (er) { toastErr(er); }
    }) }, icon('download', 16), 'Ekspor CSV') : null]));
  const q = h('input', { type: 'search', placeholder: 'Cari judul, slug, tujuan, kampanye, tag…', 'aria-label': 'Cari shortlink', value: st.q });
  const status = h('select', { 'aria-label': 'Filter status' }, [['', 'Semua status'], ['aktif', 'Aktif'], ['nonaktif', 'Nonaktif'], ['arsip', 'Arsip'], ['expired', 'Kedaluwarsa'], ['diblokir', 'Diblokir']].map((o) => h('option', { value: o[0], selected: o[0] === st.status ? true : null }, o[1])));
  const sort = h('select', { 'aria-label': 'Urutkan' }, h('option', { value: '' }, 'Terbaru'), h('option', { value: 'clicks' }, 'Klik terbanyak'));
  const list = h('div');
  c.appendChild(h('div', { class: 'card' }, h('div', { class: 'toolbar' }, q, status, sort), list));
  const reload = () => loadInto(list, () => callApi('link.list', { page: st.page, pageSize: 20, q: st.q, status: st.status, sort: st.sort }), (pg) => {
    if (!pg.rows.length) return list.appendChild(st.q || st.status ? emptyState('search', 'Tidak ada hasil', 'Coba ubah kata kunci atau filter.') :
      emptyState('link', 'Belum ada shortlink', 'Buat shortlink pertama Anda untuk mulai berbagi dan membuat QR.', can.edit() ? h('button', { class: 'btn primary', onclick: () => linkForm(null, reload) }, 'Buat shortlink') : null));
    list.appendChild(h('div', { class: 'table-wrap' }, h('table', { class: 'responsive' },
      h('thead', null, h('tr', null, ['Judul & URL pendek', 'Tujuan', 'Status', 'Klik', 'Kedaluwarsa', ''].map((t) => h('th', { text: t })))),
      h('tbody', null, pg.rows.map((l) => h('tr', null,
        h('td', { dataset: { label: 'Judul' } }, h('div', null, h('a', { class: 'title', href: '#/links/' + l.id, text: l.title }), h('div', { class: 'small mono muted', text: shortDisp(l.shortUrl) }))),
        h('td', { dataset: { label: 'Tujuan' } }, h('span', { class: 'small', title: l.destination }, l.domain, l.riskScore >= 40 ? h('span', { class: 'badge b-warn', style: 'margin-left:6px' }, icon('alert', 12), 'Berisiko') : null, l.hasPassword ? h('span', { class: 'chip', style: 'margin-left:6px' }, icon('lock', 12), 'Sandi') : null)),
        h('td', { dataset: { label: 'Status' } }, badge(l.status === 'arsip' ? 'arsip' : l.effectiveStatus === 'ok' ? 'aktif' : l.effectiveStatus)),
        h('td', { dataset: { label: 'Klik' } }, h('span', { text: num(l.clicks) + (l.maxClicks ? ' / ' + num(l.maxClicks) : '') })),
        h('td', { dataset: { label: 'Kedaluwarsa' } }, h('span', { class: 'small', text: l.expiresAt ? d(l.expiresAt) : 'Tidak ada' })),
        h('td', { dataset: { label: 'Aksi' } }, h('div', { class: 'row', style: 'justify-content:flex-end;gap:4px' },
          h('button', { class: 'btn sm icon', 'aria-label': 'Salin ' + l.shortUrl, title: 'Salin URL pendek', dataset: { action: 'copy', text: l.shortUrl } }, icon('copy', 16)),
          h('a', { class: 'btn sm icon', href: '#/qr?link=' + l.id, 'aria-label': 'Buat QR untuk ' + l.title, title: 'QR' }, icon('qr', 16)),
          h('a', { class: 'btn sm', href: '#/links/' + l.id }, 'Detail')))))))));
    list.appendChild(pager(pg, (p) => { st.page = p; reload(); }));
  });
  const deb = debounce(() => { st.q = q.value.trim(); st.page = 1; reload(); }, 350);
  q.addEventListener('input', deb);
  status.addEventListener('change', () => { st.status = status.value; st.page = 1; reload(); });
  sort.addEventListener('change', () => { st.sort = sort.value; reload(); });
  reload();
  if (r.params.new && can.edit()) linkForm(null, reload);
};

function linkForm(link, onSaved) {
  const isEdit = !!link;
  const L = link || {};
  const slugHint = h('div', { class: 'hint', id: 'slug-status', 'aria-live': 'polite' }, 'Kosongkan untuk slug acak yang sulit ditebak.');
  const form = h('form', { novalidate: true, class: 'form-grid' },
    field('destination', 'URL tujuan', { type: 'url', required: true, maxlength: 2000, value: L.destination || '', placeholder: 'https://contoh.id/halaman', span: true, autofocus: true }, 'Hanya http/https. Sistem memeriksa risiko dasar dan daftar blokir.'),
    field('title', 'Judul internal', { required: true, maxlength: 120, value: L.title || '' }, 'Hanya terlihat oleh tim Anda.'),
    h('div', { class: 'field' }, h('label', { for: 'f-slug' }, 'Slug kustom'), h('div', { class: 'input-group' }, h('span', { class: 'chip', style: 'flex:0 0 auto' }, '/'), h('input', { id: 'f-slug', name: 'slug', maxlength: 50, value: L.slug || '', 'aria-describedby': 'slug-status e-slug', autocomplete: 'off' })), slugHint, h('div', { class: 'err', id: 'e-slug' })),
    field('expiresAt', 'Kedaluwarsa (opsional)', { type: 'datetime-local', value: toLocalInput(L.expiresAt) }),
    field('activeFrom', 'Aktif mulai (opsional)', { type: 'datetime-local', value: toLocalInput(L.activeFrom) }),
    h('details', { class: 'span-2', open: isEdit && (L.hasPassword || L.maxClicks || L.campaign || L.tags) ? true : null }, h('summary', null, 'Opsi lanjutan: password, batas klik, kampanye, UTM'),
      h('div', { class: 'form-grid', style: 'margin-top:8px' },
        field('password', isEdit && L.hasPassword ? 'Password baru (kosongkan bila tetap)' : 'Password tautan (opsional)', { type: 'password', maxlength: 64, autocomplete: 'new-password' }, 'Pengunjung wajib memasukkan password ini.'),
        isEdit && L.hasPassword ? checkField('removePassword', 'Hapus password tautan', false) : h('div'),
        field('maxClicks', 'Batas jumlah klik', { type: 'number', min: 0, max: 1000000, value: L.maxClicks || '' }, 'Kosongkan = tanpa batas. Cocok untuk tautan sekali pakai.'),
        field('interstitial', 'Halaman peringatan', { type: 'select', value: L.interstitial || 'auto', options: [['auto', 'Otomatis (bila berisiko)'], ['always', 'Selalu tampilkan domain tujuan']] }),
        field('campaign', 'Nama kampanye', { maxlength: 80, value: L.campaign || '' }),
        field('tags', 'Tag (pisahkan koma)', { maxlength: 200, value: L.tags || '' }),
        !isEdit ? h('fieldset', { class: 'span-2', style: 'border:1px solid var(--border);border-radius:10px;padding:10px 12px' }, h('legend', { class: 'small' }, 'Tambahkan parameter UTM ke URL tujuan'),
          h('div', { class: 'form-grid' }, field('utm_source', 'utm_source', { maxlength: 80, placeholder: 'instagram' }), field('utm_medium', 'utm_medium', { maxlength: 80, placeholder: 'social' }), field('utm_campaign', 'utm_campaign', { maxlength: 80, placeholder: 'promo-akhir-tahun' }))) : null,
        field('notes', 'Catatan', { type: 'textarea', maxlength: 500, value: L.notes || '', span: true }))));
  const slugInput = $('#f-slug', form);
  const checkSlug = debounce(async () => {
    const v = slugInput.value.trim();
    if (!v || (isEdit && v === L.slug)) { slugHint.textContent = isEdit ? 'Mengubah slug akan membuat QR/tautan lama tidak berfungsi.' : 'Kosongkan untuk slug acak yang sulit ditebak.'; return; }
    slugHint.textContent = 'Memeriksa…';
    try { const r = await callApi('link.checkSlug', { slug: v, id: L.id || '' }); slugHint.textContent = r.available ? '✓ Slug tersedia.' : '✕ ' + r.reason; }
    catch (e) { slugHint.textContent = ''; }
  }, 400);
  slugInput.addEventListener('input', checkSlug);
  let m;
  const save = h('button', { class: 'btn primary', type: 'button' }, isEdit ? 'Simpan perubahan' : 'Buat shortlink');
  save.addEventListener('click', () => withBusy(save, async () => {
    const f = formData(form);
    const p = { title: f.title, destination: f.destination, slug: f.slug, expiresAt: fromLocalInput(f.expiresAt), activeFrom: fromLocalInput(f.activeFrom),
      maxClicks: f.maxClicks, campaign: f.campaign, tags: f.tags, interstitial: f.interstitial, notes: f.notes };
    if (f.password) p.password = f.password;
    if (f.removePassword) p.removePassword = true;
    if (!isEdit) p.utm = { source: f.utm_source, medium: f.utm_medium, campaign: f.utm_campaign };
    else p.id = L.id;
    if (!/^https?:\/\//i.test(p.destination)) return showErrors(form, { fields: { destination: 'Awali dengan https:// atau http://' } });
    if (isEdit && p.slug !== L.slug && !(await confirmDialog('Ubah slug?', 'QR dan tautan yang sudah dibagikan dengan slug lama (/' + L.slug + ') akan berhenti berfungsi. Lanjutkan?', 'Ubah slug', true))) return;
    try {
      const r = await callApi(isEdit ? 'link.update' : 'link.create', p);
      m.close(true);
      toast(isEdit ? 'Shortlink diperbarui.' : 'Shortlink dibuat: ' + r.link.shortUrl, 'ok');
      if (!isEdit && r.link.riskScore >= 40) toast('Perhatian: tujuan dinilai berisiko. Pengunjung akan melihat halaman peringatan.', 'bad');
      if (onSaved) onSaved(r.link);
    } catch (err) { if (err.code !== 'CANCELLED') showErrors(form, err); }
  }));
  m = openModal({ title: isEdit ? 'Ubah shortlink' : 'Buat shortlink', wide: true, body: form, foot: [h('button', { class: 'btn', dataset: { close: '1' } }, 'Batal'), save] });
}
function bulkImport(onDone) {
  const form = h('form', { novalidate: true },
    h('p', { class: 'muted small' }, 'Satu tautan per baris, maksimal 100 baris. Format: URL, slug (opsional), judul (opsional). Pemisah koma, titik koma, tab, atau |.'),
    field('lines', 'Daftar tautan', { type: 'textarea', rows: 8, placeholder: 'https://toko.id/promo, promo-desember, Promo Desember\nhttps://toko.id/katalog', required: true }));
  const out = h('div');
  form.appendChild(out);
  let m;
  const go = h('button', { class: 'btn primary', type: 'button' }, 'Impor');
  go.addEventListener('click', () => withBusy(go, async () => {
    try {
      const r = await callApi('link.bulkCreate', formData(form));
      clear(out).appendChild(h('div', { class: 'callout ' + (r.created ? 'ok' : 'bad') }, r.created + ' dari ' + r.results.length + ' tautan berhasil dibuat.'));
      out.appendChild(h('ul', { class: 'small' }, r.results.map((x) => h('li', null, 'Baris ' + x.line + ': ', x.ok ? h('span', { class: 'mono', text: x.shortUrl }) : h('span', { class: 'err', text: x.error })))));
      if (r.created && onDone) onDone();
    } catch (err) { showErrors(form, err); }
  }));
  m = openModal({ title: 'Impor shortlink massal', wide: true, body: form, foot: [h('button', { class: 'btn', dataset: { close: '1' } }, 'Tutup'), go] });
}

const _linksPage = Pages.links;
Pages.links = (c, r) => (r.id ? linkDetail(c, r.id) : _linksPage(c, r));
function linkDetail(c, id) {
  c.appendChild(h('a', { href: '#/links', class: 'small' }, '‹ Kembali ke daftar'));
  const body = h('div', { style: 'margin-top:8px' });
  c.appendChild(body);
  const load = () => loadInto(body, () => callApi('link.get', { id: id }), (dta) => {
    const l = dta.link;
    const statusBtns = l.canEdit && l.status !== 'diblokir' ? [
      l.status !== 'aktif' ? h('button', { class: 'btn sm', onclick: (e) => setStatus(e.currentTarget, 'aktif') }, 'Aktifkan') : h('button', { class: 'btn sm', onclick: (e) => setStatus(e.currentTarget, 'nonaktif') }, 'Nonaktifkan'),
      l.status !== 'arsip' ? h('button', { class: 'btn sm', onclick: (e) => setStatus(e.currentTarget, 'arsip') }, 'Arsipkan') : null,
      h('button', { class: 'btn sm danger', onclick: (e) => setStatus(e.currentTarget, 'dihapus') }, 'Hapus')] : [];
    async function setStatus(btn, s) {
      if (s === 'dihapus' && !(await confirmDialog('Hapus shortlink?', 'Tautan /' + l.slug + ' dan QR-nya akan berhenti berfungsi. Riwayat & statistik tetap tersimpan untuk audit.', 'Hapus', true))) return;
      if (s === 'nonaktif' && !(await confirmDialog('Nonaktifkan shortlink?', 'Pengunjung akan melihat pesan bahwa tautan tidak aktif.', 'Nonaktifkan'))) return;
      withBusy(btn, async () => { try { await callApi('link.status', { id: l.id, status: s }); toast('Status diperbarui.', 'ok'); s === 'dihapus' ? App.go('links') : load(); } catch (e) { toastErr(e); } });
    }
    const qrBox = h('div', { class: 'qr-stage', style: 'min-height:200px' });
    const cv = h('canvas', { 'aria-label': 'Pratinjau QR ' + l.shortUrl });
    qrBox.appendChild(cv);
    drawQr(cv, qrContent(l, 'short'), { size: 240, margin: 4, fg: '#000000', bg: '#ffffff', ecl: 'M' }).catch(() => { clear(qrBox).appendChild(h('p', { class: 'muted' }, 'Pratinjau QR gagal dimuat.')); });
    body.appendChild(pageHead(l.title, null, [l.canEdit && l.status !== 'diblokir' ? h('button', { class: 'btn primary', onclick: () => linkForm(l, load) }, 'Ubah') : null, h('a', { class: 'btn', href: '#/qr?link=' + l.id }, icon('qr', 16), 'Desain QR'), statusBtns]));
    body.appendChild(h('div', { class: 'grid grid-2' },
      h('section', { class: 'card' }, h('dl', { class: 'kv' },
        h('dt', null, 'URL pendek'), h('dd', null, h('span', { class: 'mono', text: l.shortUrl }), ' ', h('button', { class: 'btn sm icon', 'aria-label': 'Salin URL pendek', dataset: { action: 'copy', text: l.shortUrl } }, icon('copy', 16))),
        h('dt', null, 'Tujuan'), h('dd', null, h('span', { class: 'mono', text: l.destination })),
        h('dt', null, 'Status'), h('dd', null, badge(l.status === 'arsip' ? 'arsip' : l.effectiveStatus === 'ok' ? 'aktif' : l.effectiveStatus)),
        h('dt', null, 'Klik'), h('dd', { text: num(l.clicks) + (l.maxClicks ? ' dari batas ' + num(l.maxClicks) : '') }),
        h('dt', null, 'Kedaluwarsa'), h('dd', { text: l.expiresAt ? dt(l.expiresAt) : 'Tidak ada' }),
        l.activeFrom ? [h('dt', null, 'Aktif mulai'), h('dd', { text: dt(l.activeFrom) })] : null,
        h('dt', null, 'Proteksi'), h('dd', { text: (l.hasPassword ? 'Password · ' : '') + (l.interstitial === 'always' ? 'Selalu tampilkan peringatan' : 'Peringatan otomatis') }),
        l.campaign ? [h('dt', null, 'Kampanye'), h('dd', { text: l.campaign })] : null,
        l.tags ? [h('dt', null, 'Tag'), h('dd', null, l.tags.split(',').map((t) => h('span', { class: 'chip', style: 'margin:0 4px 4px 0', text: t.trim() })))] : null,
        h('dt', null, 'Dibuat'), h('dd', { text: dt(l.createdAt) })),
        l.riskFlags && l.riskFlags.length ? h('div', { class: 'callout warn', style: 'margin-top:12px' }, h('b', null, 'Indikasi risiko (skor ' + l.riskScore + '):'), h('ul', null, l.riskFlags.map((f) => h('li', { text: f })))) : null),
      h('section', { class: 'card' }, h('h2', null, 'QR Code'), qrBox, h('p', { class: 'small muted', style: 'margin-top:8px' }, 'QR mengarah ke URL pendek, jadi tetap berlaku walau URL tujuan diubah.'))));
    const s = dta.stats;
    body.appendChild(h('section', { class: 'card' }, h('div', { class: 'card-head' }, h('h2', null, 'Statistik 30 hari'), h('span', { class: 'small muted' }, num(s.total) + ' klik · ' + num(s.totalQr) + ' dari QR')),
      barChart(s.series.map((x) => ({ label: d(x.date), short: x.date.slice(8) + '/' + x.date.slice(5, 7), value: x.total })), { label: 'Klik per hari untuk ' + l.title, unit: ' klik' }),
      h('div', { class: 'grid grid-3', style: 'margin-top:12px' }, h('div', null, h('h3', null, 'Perangkat'), hbars(s.devices, s.total)), h('div', null, h('h3', null, 'Sumber'), hbars(s.sources, s.total)), h('div', null, h('h3', null, 'Browser'), hbars(s.browsers, s.total)))));
    body.appendChild(h('section', { class: 'card' }, h('h2', null, 'Riwayat perubahan'),
      dta.versions.length ? h('div', { class: 'table-wrap' }, h('table', { class: 'responsive' }, h('thead', null, h('tr', null, ['Waktu', 'Oleh', 'Kolom', 'Sebelum', 'Sesudah'].map((t) => h('th', { text: t })))),
        h('tbody', null, dta.versions.map((v) => h('tr', null, h('td', { dataset: { label: 'Waktu' }, text: dt(v.at) }), h('td', { dataset: { label: 'Oleh' }, text: v.by }), h('td', { dataset: { label: 'Kolom' }, text: v.field }),
          h('td', { dataset: { label: 'Sebelum' } }, h('span', { class: 'small mono', text: v.oldValue || '–' })), h('td', { dataset: { label: 'Sesudah' } }, h('span', { class: 'small mono', text: v.newValue || '–' }))))))) : h('p', { class: 'muted' }, 'Belum ada perubahan.')));
    if (dta.codes.length) body.appendChild(h('section', { class: 'card' }, h('h2', null, 'Versi desain kode'), h('ul', null, dta.codes.map((cd) => h('li', null, (cd.format === 'qr' ? 'QR' : 'Code 128') + ' v' + cd.version + ' · ' + dt(cd.createdAt) + ' · ' + cd.design.size + 'px · ' + cd.design.fg + '/' + cd.design.bg + ' ', h('a', { href: '#/qr?link=' + l.id + '&asset=' + cd.id }, 'Buka'))))));
  });
  load();
}
function qrContent(l, mode) { return mode === 'slug' ? l.slug : l.shortUrl + (l.shortUrl.indexOf('?') >= 0 ? '&q=1' : '?q=1'); }

/* ================= QR & Barcode ================= */
Pages.qr = (c, r) => {
  c.appendChild(pageHead('QR & Barcode', 'Desain, uji pindai, dan unduh QR/Code 128 untuk shortlink Anda.'));
  const body = h('div');
  c.appendChild(body);
  loadInto(body, () => callApi('link.list', { page: 1, pageSize: 100 }), async (pg) => {
    if (!pg.rows.length) return body.appendChild(emptyState('qr', 'Belum ada shortlink', 'QR dibuat dari shortlink agar tujuan bisa diubah tanpa cetak ulang.', can.edit() ? h('a', { class: 'btn primary', href: '#/links?new=1' }, 'Buat shortlink') : null));
    let link = pg.rows.find((x) => x.id === r.params.link) || pg.rows[0];
    let asset = null;
    if (r.params.asset) { try { const full = await callApi('link.get', { id: link.id }); asset = full.codes.find((x) => x.id === r.params.asset) || null; } catch (e) { asset = null; } }
    const dz = Object.assign({ size: 512, margin: 4, fg: '#000000', bg: '#ffffff', ecl: 'M', logo: false, content: 'short', label: '' }, asset ? asset.design : {});
    let format = asset ? asset.format : 'qr';
    let logoImg = null, logoUrl = '';
    const sel = h('select', { id: 'qr-link', 'aria-label': 'Pilih shortlink' }, pg.rows.map((l) => h('option', { value: l.id, selected: l.id === link.id ? true : null }, l.title + ' (/' + l.slug + ')')));
    const ctrl = h('form', { novalidate: true, class: 'form-grid', onsubmit: (e) => e.preventDefault() },
      h('div', { class: 'field span-2' }, h('label', { for: 'qr-link' }, 'Shortlink'), sel),
      field('format', 'Format kode', { type: 'select', value: format, options: [['qr', 'QR Code'], ['code128', 'Barcode Code 128']] }),
      field('content', 'Isi kode', { type: 'select', value: dz.content, options: [['short', 'URL pendek (disarankan)'], ['slug', 'Slug saja (untuk sistem internal)']] }),
      field('size', 'Ukuran (px)', { type: 'number', min: 128, max: 2048, step: 32, value: dz.size }),
      field('margin', 'Margin / zona tenang (modul)', { type: 'number', min: 0, max: 16, value: dz.margin }),
      field('fg', 'Warna kode', { type: 'color', value: dz.fg }), field('bg', 'Warna latar', { type: 'color', value: dz.bg }),
      field('ecl', 'Koreksi error (QR)', { type: 'select', value: dz.ecl, options: [['L', 'L — 7%'], ['M', 'M — 15%'], ['Q', 'Q — 25%'], ['H', 'H — 30% (untuk logo)']] }),
      h('div', { class: 'field' }, h('label', { for: 'qr-logo' }, 'Logo tengah (opsional, QR)'), h('input', { id: 'qr-logo', type: 'file', accept: 'image/png,image/jpeg,image/svg+xml' }), h('div', { class: 'hint' }, 'Logo diproses di perangkat Anda, tidak diunggah.')),
      field('label', 'Teks di bawah barcode', { maxlength: 60, value: dz.label, placeholder: '(kosongkan = isi kode)' }));
    const cv = h('canvas', { 'aria-label': 'Pratinjau kode' });
    const checks = h('ul', { class: 'small', style: 'padding-left:18px' });
    const testRes = h('div', { 'aria-live': 'polite', class: 'small' });
    const dl = (kind) => async (e) => withBusy(e.currentTarget, async () => {
      try {
        const name = 'kode-' + link.slug + '-' + format;
        const text = textNow();
        if (kind === 'png') downloadBlob(await new Promise((res) => cv.toBlob(res, 'image/png')), name + '.png');
        else if (kind === 'svg') downloadBlob(new Blob([format === 'qr' ? await qrSvg(text, designNow(), logoUrl) : code128Svg(text, designNow())], { type: 'image/svg+xml' }), name + '.svg');
        else downloadBlob(new Blob([await imagesToPdf(cv.toDataURL('image/png'), link.title + '\n' + text)], { type: 'application/pdf' }), name + '.pdf');
      } catch (er) { toastErr(er); }
    });
    const saveBtn = can.edit() ? h('button', { class: 'btn', onclick: (e) => withBusy(e.currentTarget, async () => {
      try { const res = await callApi('code.save', { linkId: link.id, format: format, design: designNow() }); toast('Desain disimpan sebagai versi ' + res.version + '.', 'ok'); } catch (er) { toastErr(er); }
    }) }, 'Simpan versi desain') : null;
    body.appendChild(h('div', { class: 'grid grid-2' }, h('section', { class: 'card' }, h('h2', null, 'Pengaturan'), ctrl),
      h('section', { class: 'card' }, h('div', { class: 'card-head' }, h('h2', null, 'Pratinjau'), h('button', { class: 'btn sm', onclick: (e) => withBusy(e.currentTarget, testScan) }, icon('scan', 16), 'Uji pindai')),
        h('div', { class: 'qr-stage' }, cv), testRes, h('h3', { style: 'margin-top:12px' }, 'Pemeriksaan keterbacaan'), checks,
        h('div', { class: 'row', style: 'margin-top:10px' }, h('button', { class: 'btn primary', onclick: dl('png') }, icon('download', 16), 'PNG'), h('button', { class: 'btn', onclick: dl('svg') }, 'SVG'), h('button', { class: 'btn', onclick: dl('pdf') }, 'PDF'), saveBtn))));
    function designNow() {
      const f = formData(ctrl);
      return { size: Math.min(2048, Math.max(128, Number(f.size) || 512)), margin: Math.min(16, Math.max(0, Number(f.margin) || 0)), fg: f.fg, bg: f.bg, ecl: f.ecl, logo: !!logoImg && format === 'qr', content: f.content, label: f.label };
    }
    function textNow() { return qrContent(link, designNow().content); }
    async function redraw() {
      format = formData(ctrl).format;
      $('#f-ecl', ctrl).disabled = format !== 'qr';
      clear(testRes);
      try {
        const dsg = designNow();
        clear(checks);
        if (format === 'qr') {
          const info = await drawQr(cv, textNow(), dsg, logoImg);
          qrChecks(Object.assign({}, dsg, { ecl: info.ecl }), info.n).forEach((x) => checks.appendChild(h('li', { class: x.level === 'bad' ? 'err' : '' }, (x.level === 'info' ? 'ℹ ' : x.level === 'bad' ? '✕ ' : '⚠ ') + x.text)));
          checks.appendChild(h('li', null, '✓ Versi QR: ' + ((info.n - 17) / 4) + ' (' + info.n + '×' + info.n + ' modul), ' + info.moduleSize + ' px/modul.'));
        } else {
          const info = drawCode128(cv, textNow(), Object.assign({}, dsg, { label: dsg.label || textNow() }));
          if (contrastRatio(dsg.fg, dsg.bg) < 4.5) checks.appendChild(h('li', { class: 'err' }, '✕ Kontras warna kurang dari 4,5:1.'));
          if (info.moduleSize < 2) checks.appendChild(h('li', { class: 'err' }, '✕ Garis terlalu tipis (' + info.moduleSize + ' px). Perbesar ukuran atau pakai isi "slug".'));
          checks.appendChild(h('li', null, '✓ ' + info.modules + ' modul, ' + info.moduleSize + ' px/modul. Code 128 cocok untuk pemindai laser/kasir.'));
        }
      } catch (e) { clear(checks).appendChild(h('li', { class: 'err' }, errMsg(e))); }
    }
    async function testScan() {
      try {
        const res = await decodeSource(cv);
        const expected = textNow();
        if (!res) testRes.replaceChildren(h('div', { class: 'callout ' + (format === 'qr' ? 'bad' : 'warn') }, format === 'qr' ? '✕ Kode tidak terbaca oleh pemindai uji. Naikkan kontras, ukuran, atau margin.' : 'Pemindai uji browser ini tidak mendukung Code 128. Uji dengan pemindai fisik/ponsel.'));
        else testRes.replaceChildren(h('div', { class: 'callout ' + (res.text === expected ? 'ok' : 'bad') }, res.text === expected ? '✓ Terbaca dengan benar: ' + res.text : '✕ Hasil pindai berbeda: ' + res.text));
      } catch (e) { toastErr(e); }
    }
    ctrl.addEventListener('input', debounce(redraw, 200));
    ctrl.addEventListener('change', redraw);
    sel.addEventListener('change', () => { link = pg.rows.find((x) => x.id === sel.value); redraw(); });
    $('#qr-logo', ctrl).addEventListener('change', async (e) => {
      const f = e.target.files[0];
      if (!f) { logoImg = null; logoUrl = ''; return redraw(); }
      if (f.size > 1048576) { toast('Logo maksimal 1 MB.', 'bad'); e.target.value = ''; return; }
      try { logoImg = await fileToImage(f); logoUrl = await new Promise((res) => { const rd = new FileReader(); rd.onload = () => res(rd.result); rd.readAsDataURL(f); }); redraw(); }
      catch (er) { toastErr(er); }
    });
    redraw();
  });
};

/* ================= Analitik ================= */
Pages.analytics = (c, r) => {
  const st = { days: Number(r.params.days) || 30, linkId: r.params.link || '' };
  c.appendChild(pageHead('Analitik', 'Statistik agregat & ramah privasi: tanpa alamat IP dan tanpa fingerprint perangkat.'));
  const filters = h('div', { class: 'toolbar' });
  const days = h('select', { 'aria-label': 'Rentang waktu' }, [[7, '7 hari'], [30, '30 hari'], [90, '90 hari'], [365, '1 tahun']].map((o) => h('option', { value: o[0], selected: o[0] === st.days ? true : null }, o[1])));
  const linkSel = h('select', { 'aria-label': 'Pilih shortlink' }, h('option', { value: '' }, 'Semua shortlink'));
  const exportBtn = ['admin', 'editor', 'auditor'].indexOf(State.me.role) >= 0 ? h('button', { class: 'btn', onclick: (e) => withBusy(e.currentTarget, async () => {
    try { const x = await callApi('link.exportClicks', { days: st.days, linkId: st.linkId }); downloadCsv('klik-' + st.days + 'hari.csv', x.header, x.rows); } catch (er) { toastErr(er); }
  }) }, icon('download', 16), 'Ekspor CSV') : null;
  filters.append(days, linkSel, exportBtn || '');
  const body = h('div');
  c.append(h('div', { class: 'card' }, filters), body);
  callApi('link.list', { page: 1, pageSize: 100 }).then((pg) => pg.rows.forEach((l) => linkSel.appendChild(h('option', { value: l.id, selected: l.id === st.linkId ? true : null }, l.title + ' (/' + l.slug + ')')))).catch(() => {});
  const load = () => loadInto(body, () => callApi('link.stats', { days: st.days, linkId: st.linkId }), (s) => {
    if (s.analyticsMode !== 'full') body.appendChild(h('div', { class: 'callout info', style: 'margin-top:16px' }, 'Mode analitik ruang kerja: ' + (s.analyticsMode === 'off' ? 'nonaktif — klik tidak dicatat.' : 'minimal — hanya jumlah klik, tanpa perangkat/browser.')));
    body.appendChild(h('div', { class: 'grid grid-kpi', style: 'margin-top:16px' },
      h('div', { class: 'card kpi' }, h('div', { class: 'label' }, 'Total klik'), h('div', { class: 'value', text: num(s.total) })),
      h('div', { class: 'card kpi' }, h('div', { class: 'label' }, 'Dari pindaian QR'), h('div', { class: 'value', text: num(s.totalQr) }), h('div', { class: 'sub', text: s.total ? Math.round(s.totalQr / s.total * 100) + '% dari total' : '' })),
      h('div', { class: 'card kpi' }, h('div', { class: 'label' }, 'Rata-rata per hari'), h('div', { class: 'value', text: (s.total / s.days).toFixed(1).replace('.', ',') }))));
    body.appendChild(h('section', { class: 'card', style: 'margin-top:16px' }, h('h2', null, 'Klik per hari'),
      barChart(s.series.map((x) => ({ label: d(x.date), short: x.date.slice(8) + '/' + x.date.slice(5, 7), value: x.total })), { label: 'Klik per hari, ' + s.days + ' hari terakhir', unit: ' klik' })));
    body.appendChild(h('div', { class: 'grid grid-3', style: 'margin-top:16px' },
      h('section', { class: 'card' }, h('h2', null, 'Perangkat'), hbars(s.devices, s.total)), h('section', { class: 'card' }, h('h2', null, 'Sistem operasi'), hbars(s.os, s.total)),
      h('section', { class: 'card' }, h('h2', null, 'Browser'), hbars(s.browsers, s.total)), h('section', { class: 'card' }, h('h2', null, 'Sumber'), hbars(s.sources, s.total)),
      h('section', { class: 'card' }, h('h2', null, 'Kampanye'), hbars(s.campaigns, s.total)),
      h('section', { class: 'card' }, h('h2', null, 'Referrer'), hbars(s.referrers, s.total), h('p', { class: 'hint' }, 'Referrer hanya tersedia bila memakai domain pendek kustom (proxy).'))));
    if (s.topLinks.length) body.appendChild(h('section', { class: 'card', style: 'margin-top:16px' }, h('h2', null, 'Shortlink teratas'), hbars(s.topLinks.map((t) => ({ key: t.title + ' (/' + t.slug + ')', count: t.count })), s.total)));
  });
  days.addEventListener('change', () => { st.days = Number(days.value); load(); });
  linkSel.addEventListener('change', () => { st.linkId = linkSel.value; load(); });
  load();
};
