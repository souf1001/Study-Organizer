// Zeichenebene über Notizen und PDF-Seiten. Unterstützt Stift mit Druckstufen, Maus und Touch.
import { memo, useRef, useState, type PointerEvent } from 'react'
import type { Stroke } from '@shared/types'
import { hitStrokes, strokePath, type InkTool } from './ink'

const StrokePath = memo(function StrokePath({ stroke }: { stroke: Stroke }) {
  const marker = stroke.tool === 'marker'
  return (
    <path
      d={strokePath(stroke)}
      className={marker ? 'ink-marker' : undefined}
      fill={stroke.color === 'ink' ? 'var(--ink)' : stroke.color}
      opacity={marker ? 0.4 : 1}
    />
  )
})

const round = (n: number, digits = 1) => Math.round(n * 10 ** digits) / 10 ** digits

interface InkLayerProps {
  /** Größe im Koordinatensystem der Striche */
  width: number
  height: number
  /** Anzeigegröße = width × displayScale (z. B. PDF-Zoom) */
  displayScale?: number
  strokes: Stroke[]
  /** null = nicht im Zeichenmodus (Klicks gehen an den Inhalt darunter) */
  tool: InkTool | null
  penOnly: boolean
  onChange: (strokes: Stroke[]) => void
}

export function InkLayer({ width, height, displayScale = 1, strokes, tool, penOnly, onChange }: InkLayerProps) {
  const svgRef = useRef<SVGSVGElement>(null)
  const [current, setCurrent] = useState<Stroke | null>(null)
  const erasing = useRef(false)

  const toPoint = (e: { clientX: number; clientY: number; pressure: number; pointerType: string }) => {
    const rect = svgRef.current!.getBoundingClientRect()
    const scale = rect.width / width
    const pressure = e.pointerType === 'pen' ? e.pressure || 0.5 : 0.5
    return [round((e.clientX - rect.left) / scale), round((e.clientY - rect.top) / scale), round(pressure, 2)]
  }

  const erase = (e: PointerEvent) => {
    const [x, y] = toPoint(e)
    const hits = hitStrokes(strokes, x, y, (tool?.size ?? 4) * 2 + 4)
    if (hits.size) onChange(strokes.filter((s) => !hits.has(s.id)))
  }

  const onPointerDown = (e: PointerEvent<SVGSVGElement>) => {
    if (!tool || e.button > 0) return
    if (penOnly && e.pointerType === 'touch') return
    e.preventDefault()
    e.currentTarget.setPointerCapture(e.pointerId)
    // Der Radierknopf eines Stifts (buttons === 32) radiert immer
    if (tool.tool === 'eraser' || e.buttons === 32) {
      erasing.current = true
      erase(e)
      return
    }
    setCurrent({ id: crypto.randomUUID(), tool: tool.tool, color: tool.color, size: tool.size, points: toPoint(e) })
  }

  const onPointerMove = (e: PointerEvent<SVGSVGElement>) => {
    if (erasing.current) return erase(e)
    if (!current) return
    const events = e.nativeEvent.getCoalescedEvents?.() ?? [e.nativeEvent]
    const added = events.flatMap((ev) => toPoint(ev))
    setCurrent((s) => (s ? { ...s, points: [...s.points, ...added] } : s))
  }

  const finish = () => {
    erasing.current = false
    if (current) onChange([...strokes, current])
    setCurrent(null)
  }

  return (
    <svg
      ref={svgRef}
      className={`ink-layer ${tool ? 'drawing' : ''} ${tool?.tool === 'eraser' ? 'erasing' : ''}`}
      width={width * displayScale}
      height={height * displayScale}
      viewBox={`0 0 ${width} ${height}`}
      style={{ touchAction: tool ? (penOnly ? 'pan-x pan-y' : 'none') : 'auto' }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={finish}
      onPointerCancel={finish}
    >
      {strokes.map((s) => (
        <StrokePath key={s.id} stroke={s} />
      ))}
      {current && <StrokePath stroke={current} />}
    </svg>
  )
}
