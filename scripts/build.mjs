import { build } from 'esbuild';
import { mkdir, copyFile } from 'node:fs/promises';
await mkdir('app/vendor', { recursive: true });
await build({ entryPoints: ['app/file-readers.js'], bundle: true, format: 'esm', platform: 'browser', target: 'es2022', outfile: 'app/vendor/file-readers.js', minify: true, legalComments: 'eof' });
await copyFile('node_modules/pdfjs-dist/build/pdf.worker.min.mjs', 'app/vendor/pdf.worker.min.mjs');
console.log('Browser file readers built.');
