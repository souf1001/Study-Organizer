// PDF-Ansicht (Vorlesungsfolien): Seiten werden erst beim Hinscrollen gerendert.
// Text ist markierbar, und mit dem Stift kann man direkt auf die Folien schreiben.
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react'
import { ExternalLink, Minus, PenLine, Plus, ScanLine } from 'lucide-react'
import type { PDFDocumentProxy, RenderTask } from 'pdfjs-dist'
import type { Annotations, Item, Stroke } from '@shared/types'
import { api, openFileLabel } from '@/lib/api'
import { openPdf, pdfjs } from '@/lib/pdf'
import { updateSettings, useDb } from '@/lib/db'
import { IconButton } from '@/ui/Button'
import { toastError } from '@/ui/Toast'
import { InkLayer } from '../note/InkLayer'
import type { InkTool } from '../note/ink'
import { InkToolbar } from './InkToolbar'

interface Size {
  width: number
  height: number
}

function PdfPage({
  pdf,
  number,
  scale,
  estimate,
  strokes,
  tool,
  penOnly,
  onStrokes,
}: {
  pdf: PDFDocumentProxy
  number: number
  scale: number
  estimate: Size
  strokes: Stroke[]
  tool: InkTool | null
  penOnly: boolean
  onStrokes: (page: number, strokes: Stroke[]) => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const textRef = useRef<HTMLDivElement>(null)
  const [visible, setVisible] = useState(false)
  const [size, setSize] = useState<Size>(estimate)

  useEffect(() => {
    const observer = new IntersectionObserver(([entry]) => entry.isIntersecting && setVisible(true), { rootMargin: '1200px 0px' })
    if (ref.current) observer.observe(ref.current)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    if (!visible) return
    let task: RenderTask | null = null
    let cancelled = false
    void (async () => {
      const page = await pdf.getPage(number)
      if (cancelled) return
      const base = page.getViewport({ scale: 1 })
      setSize({ width: base.width, height: base.height })
      const viewport = page.getViewport({ scale })
      const ratio = window.devicePixelRatio || 1
      const canvas = canvasRef.current!
      canvas.width = Math.floor(viewport.width * ratio)
      canvas.height = Math.floor(viewport.height * ratio)
      task = page.render({ canvas, viewport, transform: ratio !== 1 ? [ratio, 0, 0, ratio, 0, 0] : undefined })
      await task.promise.catch(() => undefined)
      if (cancelled || !textRef.current) return
      textRef.current.replaceChildren()
      await new pdfjs.TextLayer({ textContentSource: page.streamTextContent(), container: textRef.current, viewport }).render()
    })().catch(() => undefined)
    return () => {
      cancelled = true
      task?.cancel()
    }
  }, [visible, pdf, number, scale])

  const style = { width: size.width * scale, height: size.height * scale, '--scale-factor': scale } as CSSProperties
  return (
    <div ref={ref} className="pdf-page" data-page={number} style={style}>
      <canvas ref={canvasRef} />
      <div ref={textRef} className="textLayer" />
      <InkLayer
        width={size.width}
        height={size.height}
        displayScale={scale}
        strokes={strokes}
        tool={tool}
        penOnly={penOnly}
        onChange={(next) => onStrokes(number, next)}
      />
    </div>
  )
}

export function PdfViewer({ item }: { item: Item }) {
  const settings = useDb().settings.editor
  const [pdf, setPdf] = useState<PDFDocumentProxy | null>(null)
  const [first, setFirst] = useState<Size>({ width: 842, height: 595 })
  const [zoom, setZoom] = useState<number | 'fit'>('fit')
  const [width, setWidth] = useState(0)
  const [page, setPage] = useState(1)
  const [annotations, setAnnotations] = useState<Annotations>({ pages: {} })
  const [drawing, setDrawing] = useState(false)
  const [tool, setTool] = useState<InkTool>({ tool: 'marker', color: '#ffd84d', size: 3.5 })
  const scrollRef = useRef<HTMLDivElement>(null)
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const url = api.fileUrl(item)
  useEffect(() => {
    let cancelled = false
    const task = openPdf(url)
    task.promise
      .then(async (loaded) => {
        const firstPage = await loaded.getPage(1)
        const v = firstPage.getViewport({ scale: 1 })
        if (cancelled) return
        setFirst({ width: v.width, height: v.height })
        setPdf(loaded)
      })
      .catch((e: Error) => !cancelled && toastError(new Error(`PDF konnte nicht geöffnet werden: ${e.message}`)))
    void api.readAnnotations(item.id).then((a) => !cancelled && a && setAnnotations(a))
    return () => {
      cancelled = true
      void task.destroy()
    }
  }, [url, item.id])

  useLayoutEffect(() => {
    if (!scrollRef.current) return
    const observer = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width))
    observer.observe(scrollRef.current)
    return () => observer.disconnect()
  }, [])

  const scale = zoom === 'fit' ? Math.max(0.3, (width - 48) / first.width) : zoom

  const changeStrokes = useCallback(
    (pageNumber: number, strokes: Stroke[]) => {
      setAnnotations((current) => {
        const next = { pages: { ...current.pages, [pageNumber]: strokes } }
        if (saveTimer.current) clearTimeout(saveTimer.current)
        saveTimer.current = setTimeout(() => void api.writeAnnotations(item.id, next).catch(toastError), 600)
        return next
      })
    },
    [item.id],
  )

  const onScroll = () => {
    const el = scrollRef.current
    if (!el) return
    const pages = el.querySelectorAll<HTMLElement>('.pdf-page')
    const middle = el.scrollTop + el.clientHeight / 3
    for (const p of pages) {
      if (p.offsetTop + p.offsetHeight > middle) {
        setPage(Number(p.dataset.page))
        break
      }
    }
  }

  const goTo = (n: number) => {
    const target = scrollRef.current?.querySelector<HTMLElement>(`[data-page="${n}"]`)
    target?.scrollIntoView({ block: 'start' })
  }

  const zoomBy = (factor: number) => setZoom(Math.min(4, Math.max(0.3, Math.round(scale * factor * 100) / 100)))

  return (
    <div className="file-view">
      <div className="file-toolbar">
        <span className="small muted tabular">
          <input
            className="page-input"
            aria-label="Seite"
            value={page}
            onChange={(e) => setPage(Number(e.target.value) || 1)}
            onKeyDown={(e) => e.key === 'Enter' && goTo(page)}
          />{' '}
          / {pdf?.numPages ?? '–'}
        </span>
        <span className="toolbar-sep" />
        <IconButton label="Verkleinern" onClick={() => zoomBy(1 / 1.15)}><Minus /></IconButton>
        <span className="small muted tabular zoom-label">{Math.round(scale * 100)} %</span>
        <IconButton label="Vergrößern" onClick={() => zoomBy(1.15)}><Plus /></IconButton>
        <IconButton label="An Breite anpassen" pressed={zoom === 'fit'} onClick={() => setZoom('fit')}><ScanLine /></IconButton>
        <span className="toolbar-sep" />
        <IconButton label="Auf Folien schreiben" pressed={drawing} onClick={() => setDrawing(!drawing)}><PenLine /></IconButton>
        {drawing && (
          <InkToolbar tool={tool} onTool={setTool} penOnly={settings.penOnly} onPenOnly={(penOnly) => updateSettings('editor', { penOnly })} />
        )}
        <span className="spacer" />
        <IconButton label={openFileLabel} onClick={() => void api.openFile(item).catch(toastError)}><ExternalLink /></IconButton>
      </div>
      <div className="pdf-scroll" ref={scrollRef} onScroll={onScroll}>
        {pdf &&
          Array.from({ length: pdf.numPages }, (_, i) => (
            <PdfPage
              key={i}
              pdf={pdf}
              number={i + 1}
              scale={scale}
              estimate={first}
              strokes={annotations.pages[i + 1] ?? []}
              tool={drawing ? tool : null}
              penOnly={settings.penOnly}
              onStrokes={changeStrokes}
            />
          ))}
      </div>
    </div>
  )
}
