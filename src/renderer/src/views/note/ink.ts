// Handschrift: Striche als SVG-Pfade (perfect-freehand) und Radierer-Treffertest.
import { getStroke } from 'perfect-freehand'
import type { Stroke } from '@shared/types'

export type InkToolId = 'pen' | 'marker' | 'eraser'

export interface InkTool {
  tool: InkToolId
  color: string
  size: number
}

function triples(points: number[]): [number, number, number][] {
  const result: [number, number, number][] = []
  for (let i = 0; i + 2 < points.length; i += 3) result.push([points[i], points[i + 1], points[i + 2]])
  return result
}

const average = (a: number, b: number) => (a + b) / 2

function svgPath(outline: number[][]): string {
  if (outline.length < 4) return ''
  let a = outline[0]
  let b = outline[1]
  const c = outline[2]
  let d = `M${a[0].toFixed(1)},${a[1].toFixed(1)} Q${b[0].toFixed(1)},${b[1].toFixed(1)} ${average(b[0], c[0]).toFixed(1)},${average(b[1], c[1]).toFixed(1)} T`
  for (let i = 2; i < outline.length - 1; i++) {
    a = outline[i]
    b = outline[i + 1]
    d += `${average(a[0], b[0]).toFixed(1)},${average(a[1], b[1]).toFixed(1)} `
  }
  return `${d}Z`
}

export function strokePath(stroke: Stroke): string {
  const points = triples(stroke.points)
  const realPressure = points.some((p) => p[2] !== 0.5 && p[2] !== 0)
  const marker = stroke.tool === 'marker'
  return svgPath(
    getStroke(points, {
      size: marker ? stroke.size * 5 : stroke.size * 1.7,
      thinning: marker ? 0 : 0.55,
      smoothing: 0.55,
      streamline: 0.45,
      simulatePressure: !realPressure && !marker,
      start: { cap: true },
      end: { cap: true },
      last: true,
    }),
  )
}

/** Striche, die der Radierer an Position (x, y) berührt */
export function hitStrokes(strokes: Stroke[], x: number, y: number, radius: number): Set<string> {
  const hits = new Set<string>()
  for (const stroke of strokes) {
    const reach = radius + stroke.size * (stroke.tool === 'marker' ? 2.5 : 1)
    for (let i = 0; i + 1 < stroke.points.length; i += 3) {
      const dx = stroke.points[i] - x
      const dy = stroke.points[i + 1] - y
      if (dx * dx + dy * dy <= reach * reach) {
        hits.add(stroke.id)
        break
      }
    }
  }
  return hits
}

/** Unterkante aller Striche (zum automatischen Verlängern der Seite) */
export function inkBottom(strokes: Stroke[]): number {
  let max = 0
  for (const s of strokes) for (let i = 1; i < s.points.length; i += 3) max = Math.max(max, s.points[i])
  return max
}
