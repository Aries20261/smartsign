import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage, type PDFImage } from 'pdf-lib';
import qrcode from 'qrcode-generator';
import { APP } from './config';
import { fmtIdDate } from './util';

const A4: [number, number] = [595.28, 841.89];
/** Font standar PDF hanya mendukung WinAnsi; karakter lain diganti agar tidak gagal. */
export function pdfSafe(s: unknown): string {
  return String(s == null ? '' : s).replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/[–—]/g, '-').replace(/…/g, '...')
    // eslint-disable-next-line no-control-regex
    .replace(/[^\x20-\x7E -ÿ]/g, '?');
}

/** Penulis halaman sederhana dengan pembungkusan baris dan halaman baru otomatis. */
class Writer {
  page!: PDFPage;
  y = 0;
  constructor(public doc: PDFDocument, public font: PDFFont, public bold: PDFFont, public mono: PDFFont) { this.newPage(); }
  newPage() { this.page = this.doc.addPage(A4); this.y = A4[1] - 50; }
  ensure(h: number) { if (this.y - h < 50) this.newPage(); }
  wrap(text: string, f: PDFFont, size: number, width: number): string[] {
    const out: string[] = [];
    for (const para of pdfSafe(text).split('\n')) {
      let line = '';
      for (const word of para.split(/(\s+)/)) {
        const cand = line + word;
        if (f.widthOfTextAtSize(cand, size) <= width) { line = cand; continue; }
        if (line.trim()) out.push(line.trimEnd());
        let w = word.trimStart();
        while (f.widthOfTextAtSize(w, size) > width) { // pecah kata sangat panjang (mis. hash)
          let n = w.length;
          while (n > 1 && f.widthOfTextAtSize(w.slice(0, n), size) > width) n--;
          out.push(w.slice(0, n)); w = w.slice(n);
        }
        line = w;
      }
      out.push(line.trimEnd());
    }
    return out;
  }
  text(t: string, o: { size?: number; font?: PDFFont; x?: number; width?: number; color?: [number, number, number]; gap?: number } = {}) {
    const size = o.size || 10, f = o.font || this.font, x = o.x ?? 50, width = o.width ?? A4[0] - x - 50;
    for (const line of this.wrap(t, f, size, width)) {
      this.ensure(size + 4);
      this.page.drawText(line, { x, y: this.y - size, size, font: f, color: rgb(...(o.color || [0.07, 0.09, 0.15])) });
      this.y -= size + 3;
    }
    this.y -= o.gap ?? 4;
  }
  kv(k: string, v: string, mono = false) {
    const size = 9;
    const lines = this.wrap(v, mono ? this.mono : this.font, mono ? 8 : size, 330);
    this.ensure(lines.length * 12 + 6);
    this.page.drawText(pdfSafe(k), { x: 50, y: this.y - size, size, font: this.bold, color: rgb(0.2, 0.25, 0.35) });
    lines.forEach((l, i) => this.page.drawText(l, { x: 215, y: this.y - size - i * 12, size: mono ? 8 : size, font: mono ? this.mono : this.font, color: rgb(0.07, 0.09, 0.15) }));
    this.y -= Math.max(1, lines.length) * 12 + 4;
  }
  rule() { this.ensure(10); this.page.drawLine({ start: { x: 50, y: this.y }, end: { x: A4[0] - 50, y: this.y }, thickness: 0.5, color: rgb(0.8, 0.82, 0.86) }); this.y -= 10; }
}

async function fonts(doc: PDFDocument) {
  return { font: await doc.embedFont(StandardFonts.Helvetica), bold: await doc.embedFont(StandardFonts.HelveticaBold), mono: await doc.embedFont(StandardFonts.Courier) };
}
export function drawQr(page: PDFPage, text: string, x: number, y: number, size: number) {
  const q = qrcode(0, 'M');
  qrcode.stringToBytes = qrcode.stringToBytesFuncs['UTF-8'];
  q.addData(text, 'Byte');
  q.make();
  const n = q.getModuleCount(), quiet = 4, cell = size / (n + quiet * 2);
  page.drawRectangle({ x, y, width: size, height: size, color: rgb(1, 1, 1) });
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) {
    if (q.isDark(r, c)) page.drawRectangle({ x: x + (c + quiet) * cell, y: y + size - (r + quiet + 1) * cell, width: cell + 0.05, height: cell + 0.05, color: rgb(0, 0, 0) });
  }
}

export type CertSigner = { nama: string; email: string; signedAt: string; authMethod: string; signatureHash: string; png: Uint8Array | null };
export type CertEvent = { at: string; type: string; actor: string; hash: string };
export type CertDoc = { title: string; code: string; fileName: string; pageCount: number; originalHash: string; sentAt: string; completedAt: string; verifyUrl: string };

/** Sertifikat penyelesaian (dibuat di server saat penanda tangan terakhir selesai). */
export async function buildCertificate(d: CertDoc, signers: CertSigner[], events: CertEvent[], chain: { ok: boolean; count: number; head: string }): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const f = await fonts(doc);
  const w = new Writer(doc, f.font, f.bold, f.mono);
  w.text(APP.NAME + ' - Sertifikat Penyelesaian Tanda Tangan', { size: 16, font: f.bold, color: [0.11, 0.31, 0.85], gap: 2 });
  w.text('Diterbitkan otomatis oleh server pada ' + fmtIdDate(new Date().toISOString(), true), { size: 9, color: [0.4, 0.45, 0.5], gap: 10 });
  w.kv('Judul dokumen', d.title);
  w.kv('Kode verifikasi', d.code);
  w.kv('Berkas asli', d.fileName + ' (' + d.pageCount + ' halaman)');
  w.kv('SHA-256 dokumen asli', d.originalHash, true);
  w.kv('Dikirim', fmtIdDate(d.sentAt, true));
  w.kv('Selesai', fmtIdDate(d.completedAt, true));
  w.kv('Rantai bukti', (chain.ok ? 'Utuh (' + chain.count + ' peristiwa)' : 'PERLU PEMERIKSAAN') + '\nHead: ' + chain.head, true);
  w.rule();
  w.text('Jenis tanda tangan: ' + APP.ASSURANCE_LABEL + '. Gambar tanda tangan bukan tanda tangan digital kriptografis. Bukti terdiri atas autentikasi OTP email, ' +
    'persetujuan eksplisit (versi ' + APP.CONSENT_VERSION + '), waktu server, dan hash SHA-256 dokumen. Untuk kebutuhan hukum tinggi gunakan tanda tangan elektronik ' +
    'tersertifikasi dari PSrE sesuai UU ITE dan PP 71/2019.', { size: 9, gap: 10 });
  w.text('Penanda tangan', { size: 12, font: f.bold });
  for (let i = 0; i < signers.length; i++) {
    const s = signers[i];
    w.ensure(80);
    const top = w.y;
    w.text((i + 1) + '. ' + s.nama + ' <' + s.email + '>', { size: 10, font: f.bold, width: 300, gap: 1 });
    w.text('Waktu: ' + fmtIdDate(s.signedAt, true), { size: 9, width: 300, gap: 1 });
    w.text('Autentikasi: ' + (s.authMethod === 'otp_code' ? 'OTP email + kode akses' : 'OTP email'), { size: 9, width: 300, gap: 1 });
    w.text('SHA-256 gambar: ' + s.signatureHash, { size: 7, font: f.mono, width: 300, gap: 6 });
    if (s.png) {
      try {
        const img: PDFImage = await doc.embedPng(s.png);
        const r = Math.min(180 / img.width, 50 / img.height);
        w.page.drawImage(img, { x: 370, y: top - 55, width: img.width * r, height: img.height * r });
      } catch { /* gambar rusak: dilewati */ }
    }
    w.y = Math.min(w.y, top - 62);
  }
  w.rule();
  w.text('Jejak audit', { size: 12, font: f.bold });
  for (const e of events) w.text(fmtIdDate(e.at, true) + '  |  ' + e.type + '  |  ' + e.actor + '  |  ' + e.hash.slice(0, 16) + '...', { size: 8, gap: 1 });
  w.y -= 8;
  w.text('Verifikasi keaslian: ' + d.verifyUrl, { size: 9 });
  w.ensure(130);
  drawQr(w.page, d.verifyUrl, 50, w.y - 120, 110);
  doc.setTitle(pdfSafe('Sertifikat ' + d.code));
  doc.setProducer(APP.NAME);
  doc.setCreationDate(new Date());
  return doc.save();
}

export type FinalSigner = { nama: string; email: string; signedAt: string; authMethod: string; fields: any[]; fieldValues: Record<string, string>; png: Uint8Array | null };
/** PDF final: tanda tangan ditempel pada posisi field + halaman bukti dengan QR verifikasi. */
export async function buildFinalPdf(original: Uint8Array, d: CertDoc & { certHash: string }, signers: FinalSigner[]): Promise<Uint8Array> {
  const pdf = await PDFDocument.load(original, { updateMetadata: false });
  const f = await fonts(pdf);
  const pages = pdf.getPages();
  for (const s of signers) {
    const png = s.png ? await pdf.embedPng(s.png).catch(() => null) : null;
    for (const fl of s.fields || []) {
      const page = pages[fl.page - 1];
      if (!page) continue;
      const { width: W, height: H } = page.getSize();
      const x = fl.x * W, y = H - (fl.y + fl.h) * H, w = fl.w * W, hh = fl.h * H;
      if ((fl.type === 'signature' || fl.type === 'initial') && png) {
        const r = Math.min(w / png.width, (hh * 0.8) / png.height);
        page.drawImage(png, { x: x + (w - png.width * r) / 2, y: y + hh * 0.2 + (hh * 0.8 - png.height * r) / 2, width: png.width * r, height: png.height * r });
        page.drawText(pdfSafe('Ditandatangani elektronik: ' + s.nama + ' - ' + fmtIdDate(s.signedAt).slice(0, 11)), { x, y: y + 1, size: Math.max(4, Math.min(7, hh * 0.15)), font: f.font, color: rgb(0.2, 0.2, 0.45) });
      } else {
        const v = fl.type === 'name' ? s.nama : s.fieldValues?.[fl.id] || '';
        const size = Math.max(6, Math.min(12, hh * 0.6));
        page.drawText(pdfSafe(v), { x: x + 2, y: y + (hh - size) / 2 + 1, size, font: f.font, color: rgb(0, 0, 0), maxWidth: w - 4 });
      }
    }
  }
  const w = new Writer(pdf, f.font, f.bold, f.mono);
  w.text('Lembar Bukti Tanda Tangan Elektronik', { size: 16, font: f.bold, gap: 10 });
  w.kv('Judul', d.title);
  w.kv('Kode verifikasi', d.code);
  w.kv('Selesai', fmtIdDate(d.completedAt, true));
  w.kv('SHA-256 dokumen asli', d.originalHash, true);
  w.kv('SHA-256 sertifikat', d.certHash, true);
  w.kv('Jenis tanda tangan', APP.ASSURANCE_LABEL);
  w.rule();
  w.text('Penanda tangan', { size: 11, font: f.bold });
  signers.forEach((s, i) => w.text((i + 1) + '. ' + s.nama + ' (' + s.email + ') - ' + fmtIdDate(s.signedAt, true) + ' - ' + (s.authMethod === 'otp_code' ? 'OTP email + kode akses' : 'OTP email'), { size: 9, gap: 2 }));
  w.y -= 8;
  w.text('Halaman ini ditambahkan server setelah semua pihak menandatangani. Periksa keaslian dengan memindai QR atau membuka:', { size: 9 });
  w.text(d.verifyUrl, { size: 8, font: f.mono });
  w.ensure(160);
  drawQr(w.page, d.verifyUrl, 50, w.y - 150, 140);
  pdf.setTitle(pdfSafe(d.title + ' (ditandatangani)'));
  pdf.setProducer(APP.NAME);
  pdf.setSubject('Kode verifikasi ' + d.code);
  return pdf.save();
}

/** Laporan hasil verifikasi (dari scanner). */
export async function buildVerificationReport(r: { id: string; checkedAt: string; objectType: string; input: string; result: string; reasonCode: string; detail: Record<string, unknown> }, by: string): Promise<Uint8Array> {
  const LABEL: Record<string, string> = { valid: 'VALID', invalid: 'TIDAK VALID', expired: 'KEDALUWARSA', unable: 'TIDAK DAPAT DIVERIFIKASI', review: 'PERLU PEMERIKSAAN' };
  const doc = await PDFDocument.create();
  const f = await fonts(doc);
  const w = new Writer(doc, f.font, f.bold, f.mono);
  w.text(APP.NAME + ' - Laporan Hasil Verifikasi', { size: 16, font: f.bold, color: [0.11, 0.31, 0.85], gap: 10 });
  w.text(LABEL[r.result] || r.result, { size: 18, font: f.bold, gap: 10 });
  w.kv('ID catatan', String(r.id));
  w.kv('Waktu pemeriksaan', fmtIdDate(r.checkedAt, true));
  w.kv('Jenis objek', r.objectType);
  w.kv('Isi yang diperiksa', r.input, true);
  w.kv('Kode alasan', r.reasonCode);
  w.kv('Diperiksa oleh', by);
  for (const [k, v] of Object.entries(r.detail || {})) if (v !== '' && v != null) w.kv(k, typeof v === 'object' ? JSON.stringify(v) : String(v), true);
  w.rule();
  w.text('Laporan dibuat otomatis. Hasil "tidak dapat diverifikasi" atau "perlu pemeriksaan" bukan pernyataan bahwa objek valid. Gambar hasil pindai tidak disimpan.', { size: 8 });
  doc.setTitle('Laporan verifikasi ' + r.id);
  doc.setProducer(APP.NAME);
  return doc.save();
}
