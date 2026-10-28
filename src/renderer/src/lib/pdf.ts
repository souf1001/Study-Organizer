// pdf.js setup: worker and helper files (CMaps, standard fonts, image decoders) served from /pdfjs.
//
// The legacy build is used on purpose: the regular pdf.js build relies on very new browser
// functions (Map.getOrInsert, Math.sumPrecise, URL.parse …). Electron always has them, but the
// Android WebView of a tablet may be older, and PDFs then failed to open with
// "… is not a function". The legacy build brings replacements for most of these functions;
// polyfills.ts adds the rest.
//
// The worker runs our own entry point, so the polyfills are loaded there too. One worker serves
// all documents.
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs'

pdfjs.GlobalWorkerOptions.workerPort = new Worker(new URL('./pdf-worker.ts', import.meta.url), {
  type: 'module',
})

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

/** Text of all pages, separated by page markers, for search and AI. */
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
