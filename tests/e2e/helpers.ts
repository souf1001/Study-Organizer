import { mkdtempSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { _electron as electron, type ElectronApplication, type Page } from '@playwright/test'

export async function launchApp(dataDir = mkdtempSync(path.join(os.tmpdir(), 'study-e2e-'))): Promise<{ app: ElectronApplication; page: Page; dataDir: string }> {
  // STUDY_E2E_EXECUTABLE: fertig verpackte App testen (z. B. release/linux-unpacked/study-organizer)
  const executablePath = process.env.STUDY_E2E_EXECUTABLE
  const args = executablePath ? [] : ['out/main/index.js']
  if (process.getuid?.() === 0 || process.env.CI) args.unshift('--no-sandbox')
  const app = await electron.launch({
    executablePath,
    args,
    env: { ...process.env, STUDY_ORGANIZER_DATA: dataDir, ELECTRON_RENDERER_URL: '' },
  })
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  return { app, page, dataDir }
}

/** Kleines, gültiges PDF mit einer Textzeile pro Seite */
export function samplePdf(lines: string[]): Buffer {
  const objects: string[] = []
  const pageIds = lines.map((_, i) => 3 + i * 2)
  objects[1] = '<< /Type /Catalog /Pages 2 0 R >>'
  objects[2] = `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${lines.length} >>`
  const fontId = 3 + lines.length * 2
  lines.forEach((line, i) => {
    const pageId = pageIds[i]
    const stream = `BT /F1 40 Tf 60 420 Td (${line}) Tj ET BT /F1 18 Tf 60 360 Td (Beispiel-Folie ${i + 1}) Tj ET`
    objects[pageId] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 842 595] /Contents ${pageId + 1} 0 R /Resources << /Font << /F1 ${fontId} 0 R >> >> >>`
    objects[pageId + 1] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`
  })
  objects[fontId] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'
  let pdf = '%PDF-1.4\n'
  const offsets: number[] = []
  for (let id = 1; id < objects.length; id++) {
    offsets[id] = pdf.length
    pdf += `${id} 0 obj\n${objects[id]}\nendobj\n`
  }
  const xref = pdf.length
  pdf += `xref\n0 ${objects.length}\n0000000000 65535 f \n`
  for (let id = 1; id < objects.length; id++) pdf += `${String(offsets[id]).padStart(10, '0')} 00000 n \n`
  pdf += `trailer\n<< /Size ${objects.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return Buffer.from(pdf, 'latin1')
}
