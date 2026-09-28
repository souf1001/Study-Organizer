// Kopiert Hilfsdateien von pdf.js (Schrift-Tabellen, Dekoder) in den öffentlichen Ordner der Oberfläche.
import { cpSync, existsSync, mkdirSync } from 'node:fs'

const source = 'node_modules/pdfjs-dist'
const target = 'src/renderer/public/pdfjs'
mkdirSync(target, { recursive: true })
for (const dir of ['cmaps', 'standard_fonts', 'wasm', 'iccs']) {
  if (existsSync(`${source}/${dir}`)) cpSync(`${source}/${dir}`, `${target}/${dir}`, { recursive: true })
}
console.log('pdf.js-Dateien kopiert nach', target)
