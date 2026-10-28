// Entry point of the pdf.js worker: loads the polyfills before pdf.js, which then connects
// itself to the page through the worker's message port.
import './polyfills'
import 'pdfjs-dist/legacy/build/pdf.worker.mjs'
