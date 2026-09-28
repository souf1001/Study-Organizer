// pdf.js einrichten: Worker und Hilfsdateien (Schrift-Tabellen, Bild-Dekoder) aus /pdfjs.
import * as pdfjs from 'pdfjs-dist'
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl

const assets = new URL('pdfjs/', document.baseURI).href

export function openPdf(url: string): pdfjs.PDFDocumentLoadingTask {
  return pdfjs.getDocument({
    url,
    cMapUrl: `${assets}cmaps/`,
    cMapPacked: true,
    standardFontDataUrl: `${assets}standard_fonts/`,
    wasmUrl: `${assets}wasm/`,
    iccUrl: `${assets}iccs/`,
  })
}

/** Text aller Seiten, getrennt durch Seitenmarken – für Suche und KI */
export async function extractPdfText(url: string, maxPages = 400): Promise<string> {
  const task = openPdf(url)
  const pdf = await task.promise
  try {
    const pages: string[] = []
    for (let n = 1; n <= Math.min(pdf.numPages, maxPages); n++) {
      const page = await pdf.getPage(n)
      const content = await page.getTextContent()
      const text = content.items
        .map((item) => ('str' in item ? item.str + (item.hasEOL ? '\n' : ' ') : ''))
        .join('')
        .replace(/[ \t]+/g, ' ')
        .trim()
      pages.push(`[Seite ${n}]\n${text}`)
      page.cleanup()
    }
    return pages.join('\n\n')
  } finally {
    await task.destroy()
  }
}

export { pdfjs }
