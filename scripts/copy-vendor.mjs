// Menyalin library klien dari node_modules ke public/vendor agar disajikan dari domain sendiri (tanpa CDN pihak ketiga).
import { mkdirSync, copyFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const files = [
  ['node_modules/qrcode-generator/qrcode.js', 'public/vendor/qrcode.js'],
  ['node_modules/jsqr/dist/jsQR.js', 'public/vendor/jsQR.js'],
  ['node_modules/pdfjs-dist/build/pdf.min.mjs', 'public/vendor/pdf.min.mjs'],
  ['node_modules/pdfjs-dist/build/pdf.worker.min.mjs', 'public/vendor/pdf.worker.min.mjs'],
  ['node_modules/pdf-lib/dist/pdf-lib.min.js', 'public/vendor/pdf-lib.min.js']
];
for (const [from, to] of files) {
  const src = join(root, from);
  if (!existsSync(src)) { console.warn('vendor: tidak ditemukan', from); continue; }
  mkdirSync(dirname(join(root, to)), { recursive: true });
  copyFileSync(src, join(root, to));
}
console.log('vendor: ' + files.length + ' berkas disalin ke public/vendor');
