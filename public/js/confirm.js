/* Meneruskan hasil tautan email bawaan Supabase (token di fragmen URL) ke aplikasi. */
(function () {
  var f = new URLSearchParams((location.hash || '').replace(/^#/, ''));
  var q = new URLSearchParams(location.search);
  try { history.replaceState(null, '', location.pathname); } catch (e) { /* abaikan */ }
  function go(notice) { location.replace('/?notice=' + encodeURIComponent(notice)); }
  var err = f.get('error_description') || q.get('error_description');
  if (err) return go('Tautan tidak valid atau sudah kedaluwarsa. Silakan minta tautan baru.');
  var type = f.get('type') || '';
  if (type === 'recovery' && f.get('access_token') && f.get('refresh_token')) {
    fetch('/auth/confirm', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json', 'x-requested-with': 'smartsign' },
      body: JSON.stringify({ access_token: f.get('access_token'), refresh_token: f.get('refresh_token') }) })
      .then(function (r) { if (r.ok) location.replace('/reset'); else go('Tautan reset tidak valid atau sudah kedaluwarsa.'); })
      .catch(function () { go('Koneksi gagal. Coba buka tautan lagi.'); });
    return;
  }
  if (type === 'email_change') return go('Alamat email berhasil diperbarui.');
  if (type === 'signup' || type === 'invite' || type === 'magiclink' || f.get('access_token')) return go('Email terverifikasi. Silakan masuk.');
  go('Tautan tidak valid atau sudah kedaluwarsa. Silakan minta tautan baru.');
})();
