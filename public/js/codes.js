/* SmartSign: QR, Code 128, pemindaian, PDF, pad tanda tangan */
'use strict';
/* ============ QR, Code 128, pemindaian, PDF, pad tanda tangan ============ */

/* ---------- QR ---------- */
async function qrMatrix(text, ecl) {
  await loadLib('qr');
  qrcode.stringToBytes = qrcode.stringToBytesFuncs['UTF-8'];
  const q = qrcode(0, ecl || 'M');
  q.addData(text, 'Byte');
  q.make();
  const n = q.getModuleCount();
  return { n: n, dark: (r, c) => q.isDark(r, c) };
}
function luminance(hex) {
  const c = [1, 3, 5].map((i) => parseInt(hex.substr(i, 2), 16) / 255).map((v) => v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4));
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}
function contrastRatio(a, b) { const la = luminance(a), lb = luminance(b); return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05); }
/** Pemeriksaan keterbacaan dasar QR (FR-CODE-003). */
function qrChecks(design, n) {
  const out = [];
  const cr = contrastRatio(design.fg, design.bg);
  if (luminance(design.fg) > luminance(design.bg)) out.push({ level: 'warn', text: 'Warna modul lebih terang dari latar (QR terbalik). Sebagian pemindai tidak bisa membacanya.' });
  if (cr < 3) out.push({ level: 'bad', text: 'Kontras warna terlalu rendah (' + cr.toFixed(1) + ':1). Gunakan minimal 4,5:1.' });
  else if (cr < 4.5) out.push({ level: 'warn', text: 'Kontras ' + cr.toFixed(1) + ':1 — disarankan minimal 4,5:1 agar mudah dipindai.' });
  if (design.margin < 2) out.push({ level: 'warn', text: 'Zona tenang (margin) kurang dari 2 modul; disarankan 4 modul.' });
  const modPx = Math.floor(design.size / (n + design.margin * 2));
  if (modPx < 3) out.push({ level: 'bad', text: 'Ukuran modul hanya ' + modPx + ' px. Perbesar ukuran gambar.' });
  if (design.logo && design.ecl !== 'H') out.push({ level: 'warn', text: 'Logo aktif: tingkat koreksi otomatis dinaikkan ke H (30%).' });
  out.push({ level: 'info', text: 'Ukuran cetak minimal yang disarankan: ' + Math.max(2, Math.ceil((n + design.margin * 2) * 0.33 / 10)) + ' cm (≈0,33 mm per modul).' });
  return out;
}
async function drawQr(canvas, text, design, logoImg) {
  const ecl = design.logo ? 'H' : design.ecl;
  const m = await qrMatrix(text, ecl);
  const total = m.n + design.margin * 2;
  const mod = Math.max(1, Math.floor(design.size / total));
  const px = mod * total;
  canvas.width = px; canvas.height = px;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = design.bg; ctx.fillRect(0, 0, px, px);
  ctx.fillStyle = design.fg;
  for (let r = 0; r < m.n; r++) for (let c = 0; c < m.n; c++) if (m.dark(r, c)) ctx.fillRect((c + design.margin) * mod, (r + design.margin) * mod, mod, mod);
  if (design.logo && logoImg) {
    const box = Math.floor(m.n * 0.22) * mod; // ≤ ~5% luas → aman dengan ECL H
    const x = Math.floor((px - box) / 2), y = x;
    ctx.fillStyle = design.bg; ctx.fillRect(x - mod, y - mod, box + mod * 2, box + mod * 2);
    const ratio = Math.min(box / logoImg.width, box / logoImg.height);
    const w = logoImg.width * ratio, hh = logoImg.height * ratio;
    ctx.drawImage(logoImg, x + (box - w) / 2, y + (box - hh) / 2, w, hh);
  }
  return { n: m.n, moduleSize: mod, px: px, ecl: ecl };
}
async function qrSvg(text, design, logoDataUrl) {
  const ecl = design.logo ? 'H' : design.ecl;
  const m = await qrMatrix(text, ecl);
  const total = m.n + design.margin * 2;
  let path = '';
  for (let r = 0; r < m.n; r++) for (let c = 0; c < m.n; c++) if (m.dark(r, c)) path += 'M' + (c + design.margin) + ' ' + (r + design.margin) + 'h1v1h-1z';
  let logo = '';
  if (design.logo && logoDataUrl) {
    const box = Math.floor(m.n * 0.22), x = (total - box) / 2;
    logo = '<rect x="' + (x - 1) + '" y="' + (x - 1) + '" width="' + (box + 2) + '" height="' + (box + 2) + '" fill="' + design.bg + '"/>' +
      '<image href="' + escapeHtml(logoDataUrl) + '" x="' + x + '" y="' + x + '" width="' + box + '" height="' + box + '" preserveAspectRatio="xMidYMid meet"/>';
  }
  return '<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + total + ' ' + total + '" width="' + design.size + '" height="' + design.size +
    '" shape-rendering="crispEdges"><rect width="100%" height="100%" fill="' + design.bg + '"/><path fill="' + design.fg + '" d="' + path + '"/>' + logo + '</svg>';
}

/* ---------- Code 128 (set B) ---------- */
const C128 = ['212222', '222122', '222221', '121223', '121322', '131222', '122213', '122312', '132212', '221213', '221312', '231212', '112232', '122132', '122231', '113222',
  '123122', '123221', '223211', '221132', '221231', '213212', '223112', '312131', '311222', '321122', '321221', '312212', '322112', '322211', '212123', '212321', '232121',
  '111323', '131123', '131321', '112313', '132113', '132311', '211313', '231113', '231311', '112133', '112331', '132131', '113123', '113321', '133121', '313121', '211331',
  '231131', '213113', '213311', '213131', '311123', '311321', '331121', '312113', '312311', '332111', '314111', '221411', '431111', '111224', '111422', '121124', '121421',
  '141122', '141221', '112214', '112412', '122114', '122411', '142112', '142211', '241211', '221114', '413111', '241112', '134111', '111242', '121142', '121241', '114212',
  '124112', '124211', '411212', '421112', '421211', '212141', '214121', '412121', '111143', '111341', '131141', '114113', '114311', '411113', '411311', '113141', '114131',
  '311141', '411131', '211412', '211214', '211232', '2331112'];
function code128Modules(text) {
  const vals = [104];
  for (const ch of text) { const c = ch.charCodeAt(0); if (c < 32 || c > 126) throw { message: 'Code 128 hanya mendukung karakter ASCII yang dapat dicetak.' }; vals.push(c - 32); }
  let sum = 104;
  for (let i = 1; i < vals.length; i++) sum += vals[i] * i;
  vals.push(sum % 103, 106);
  const bars = [];
  vals.forEach((v) => C128[v].split('').forEach((w, i) => bars.push({ dark: i % 2 === 0, w: Number(w) })));
  return bars;
}
function drawCode128(canvas, text, design) {
  const bars = code128Modules(text);
  const modules = bars.reduce((s, b) => s + b.w, 0) + 20; // zona tenang 10 modul tiap sisi
  const mod = Math.max(1, Math.floor(design.size / modules));
  const barH = Math.max(40, Math.round(mod * modules * 0.28));
  const label = design.label !== '' ? 18 : 0;
  canvas.width = mod * modules; canvas.height = barH + 16 + label;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = design.bg; ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = design.fg;
  let x = 10 * mod;
  bars.forEach((b) => { if (b.dark) ctx.fillRect(x, 8, b.w * mod, barH); x += b.w * mod; });
  if (label) { ctx.font = '14px ' + getComputedStyle(document.body).fontFamily; ctx.textAlign = 'center'; ctx.fillText(text.length > 60 ? text.slice(0, 57) + '…' : text, canvas.width / 2, barH + 26); }
  return { modules: modules, moduleSize: mod };
}
function code128Svg(text, design) {
  const bars = code128Modules(text);
  const modules = bars.reduce((s, b) => s + b.w, 0) + 20;
  let x = 10, rects = '';
  bars.forEach((b) => { if (b.dark) rects += '<rect x="' + x + '" y="0" width="' + b.w + '" height="40"/>'; x += b.w; });
  return '<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + modules + ' 40" width="' + design.size + '" height="' + Math.round(design.size * 40 / modules) +
    '" shape-rendering="crispEdges" preserveAspectRatio="none"><rect width="100%" height="100%" fill="' + design.bg + '"/><g fill="' + design.fg + '">' + rects + '</g></svg>';
}

/* ---------- Pemindaian (BarcodeDetector bawaan, fallback jsQR) ---------- */
let detectorPromise = null;
function getDetector() {
  if (detectorPromise) return detectorPromise;
  detectorPromise = (async () => {
    if (!('BarcodeDetector' in window)) return null;
    try {
      const supported = await BarcodeDetector.getSupportedFormats();
      const want = ['qr_code', 'code_128', 'ean_13', 'ean_8', 'code_39', 'data_matrix', 'pdf417', 'upc_a'].filter((f) => supported.indexOf(f) >= 0);
      return want.length ? new BarcodeDetector({ formats: want }) : null;
    } catch (e) { return null; }
  })();
  return detectorPromise;
}
/** source: canvas | video | ImageBitmap. Mengembalikan {text, format} atau null. */
async function decodeSource(source, canvas) {
  const det = await getDetector();
  if (det) {
    try { const r = await det.detect(source); if (r && r.length) return { text: r[0].rawValue, format: r[0].format }; } catch (e) { /* lanjut jsQR */ }
  }
  await loadLib('jsqr');
  const cv = canvas || document.createElement('canvas');
  const w = source.videoWidth || source.width, hh = source.videoHeight || source.height;
  if (!w || !hh) return null;
  const scale = Math.min(1, 1024 / Math.max(w, hh));
  cv.width = Math.round(w * scale); cv.height = Math.round(hh * scale);
  const ctx = cv.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(source, 0, 0, cv.width, cv.height);
  const img = ctx.getImageData(0, 0, cv.width, cv.height);
  const r = jsQR(img.data, img.width, img.height, { inversionAttempts: 'attemptBoth' });
  return r ? { text: r.data, format: 'qr_code' } : null;
}
function fileToImage(file) {
  return new Promise((res, rej) => {
    if (!/^image\/(png|jpe?g|gif|webp|bmp)$/.test(file.type)) return rej({ message: 'Gunakan gambar PNG, JPG, GIF, WEBP, atau BMP.' });
    if (file.size > 8 * 1048576) return rej({ message: 'Ukuran gambar maksimal 8 MB.' });
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); res(img); };
    img.onerror = () => { URL.revokeObjectURL(url); rej({ message: 'Gambar tidak dapat dibaca.' }); };
    img.src = url;
  });
}

/* ---------- PDF (pdf.js untuk tampilan, pdf-lib untuk PDF final) ---------- */
async function pdfOpen(bytes) {
  const lib = await loadPdfjs();
  // isEvalSupported:false menutup celah eksekusi skrip lewat font PDF berbahaya.
  return lib.getDocument({ data: bytes, isEvalSupported: false, enableXfa: false, disableAutoFetch: true }).promise;
}
async function renderPdfPage(pdf, n, maxWidth) {
  const page = await pdf.getPage(n);
  const base = page.getViewport({ scale: 1 });
  const cssW = Math.min(maxWidth, base.width * 1.6);
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const vp = page.getViewport({ scale: (cssW / base.width) * dpr });
  const canvas = h('canvas', { width: Math.floor(vp.width), height: Math.floor(vp.height), 'aria-label': 'Halaman ' + n });
  await page.render({ canvas: canvas, canvasContext: canvas.getContext('2d'), viewport: vp }).promise;
  return { canvas: canvas, rotate: page.rotate || 0, width: base.width, height: base.height };
}
function pdfSafeText(s) { return String(s == null ? '' : s).replace(/[^\x20-\x7E -ÿ]/g, '?'); }
async function imagesToPdf(pngDataUrl, caption) {
  await loadLib('pdflib');
  const { PDFDocument, StandardFonts, rgb } = PDFLib;
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([595.28, 841.89]);
  const img = await pdf.embedPng(b64ToBytes(pngDataUrl.split(',')[1]));
  const maxW = 360, r = Math.min(maxW / img.width, 500 / img.height);
  const w = img.width * r, hh = img.height * r;
  page.drawImage(img, { x: (595.28 - w) / 2, y: 841.89 - 120 - hh, width: w, height: hh });
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  page.drawText(pdfSafeText(caption || ''), { x: 60, y: 841.89 - 150 - hh, size: 11, font: font, color: rgb(0.1, 0.1, 0.1), maxWidth: 475, lineHeight: 14 });
  return pdf.save();
}

/* ---------- Pad tanda tangan ---------- */
function signaturePad(canvas) {
  const ctx = canvas.getContext('2d');
  let drawing = false, last = null, strokes = 0;
  const fit = () => { const r = canvas.getBoundingClientRect(); const dpr = window.devicePixelRatio || 1; canvas.width = Math.max(1, r.width * dpr); canvas.height = Math.max(1, r.height * dpr); ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.strokeStyle = '#0b1f66'; };
  fit();
  const pos = (e) => { const r = canvas.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top, p: e.pressure || 0.5 }; };
  canvas.addEventListener('pointerdown', (e) => { drawing = true; last = pos(e); canvas.setPointerCapture(e.pointerId); strokes++; e.preventDefault(); });
  canvas.addEventListener('pointermove', (e) => {
    if (!drawing) return;
    const p = pos(e);
    ctx.lineWidth = 1.6 + p.p * 2.2;
    ctx.beginPath(); ctx.moveTo(last.x, last.y);
    ctx.quadraticCurveTo(last.x, last.y, (last.x + p.x) / 2, (last.y + p.y) / 2); ctx.lineTo(p.x, p.y); ctx.stroke();
    last = p;
  });
  const end = () => { drawing = false; };
  canvas.addEventListener('pointerup', end); canvas.addEventListener('pointercancel', end);
  return {
    clear: () => { ctx.clearRect(0, 0, canvas.width, canvas.height); strokes = 0; },
    isEmpty: () => strokes === 0,
    resize: fit,
    toPng: () => trimCanvas(canvas)
  };
}
function trimCanvas(src) {
  const ctx = src.getContext('2d');
  const { width: w, height: hh } = src;
  const data = ctx.getImageData(0, 0, w, hh).data;
  let x0 = w, y0 = hh, x1 = 0, y1 = 0;
  for (let y = 0; y < hh; y++) for (let x = 0; x < w; x++) if (data[(y * w + x) * 4 + 3] > 10) { if (x < x0) x0 = x; if (y < y0) y0 = y; if (x > x1) x1 = x; if (y > y1) y1 = y; }
  if (x1 <= x0 || y1 <= y0) return null;
  const pad = 6, out = document.createElement('canvas');
  const cw = x1 - x0 + pad * 2, ch = y1 - y0 + pad * 2;
  const scale = Math.min(1, 900 / cw);
  out.width = Math.round(cw * scale); out.height = Math.round(ch * scale);
  out.getContext('2d').drawImage(src, x0 - pad, y0 - pad, cw, ch, 0, 0, out.width, out.height);
  return out.toDataURL('image/png');
}
function typedSignaturePng(name, style) {
  const cv = document.createElement('canvas');
  cv.width = 900; cv.height = 220;
  const ctx = cv.getContext('2d');
  const fonts = { a: 'italic 600 96px "Segoe Script","Brush Script MT","Lucida Handwriting",cursive', b: 'italic 500 90px Georgia,"Times New Roman",serif', c: '600 84px "Segoe Print","Comic Sans MS",cursive' };
  ctx.font = fonts[style] || fonts.a;
  ctx.fillStyle = '#0b1f66'; ctx.textBaseline = 'middle';
  let size = 96;
  while (ctx.measureText(name).width > 860 && size > 30) { size -= 6; ctx.font = (fonts[style] || fonts.a).replace(/\d+px/, size + 'px'); }
  ctx.fillText(name, 20, 115);
  return trimCanvas(cv);
}
