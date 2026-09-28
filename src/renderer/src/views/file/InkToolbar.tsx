// Kompakte Stiftauswahl für PDFs und Bilder.
import { Eraser, Hand, Highlighter, PenLine } from 'lucide-react'
import { IconButton } from '@/ui/Button'
import type { InkTool, InkToolId } from '../note/ink'
import { MARKER_COLORS, PEN_COLORS } from '../note/paper'

export function InkToolbar({
  tool,
  onTool,
  penOnly,
  onPenOnly,
}: {
  tool: InkTool
  onTool: (t: InkTool) => void
  penOnly: boolean
  onPenOnly: (v: boolean) => void
}) {
  const pick = (id: InkToolId) =>
    onTool({ ...tool, tool: id, color: id === 'marker' ? MARKER_COLORS[0] : id === 'pen' ? '#d9423a' : tool.color })
  const colors = tool.tool === 'marker' ? MARKER_COLORS : PEN_COLORS
  return (
    <>
      <IconButton label="Textmarker" pressed={tool.tool === 'marker'} onClick={() => pick('marker')}><Highlighter /></IconButton>
      <IconButton label="Stift" pressed={tool.tool === 'pen'} onClick={() => pick('pen')}><PenLine /></IconButton>
      <IconButton label="Radierer" pressed={tool.tool === 'eraser'} onClick={() => pick('eraser')}><Eraser /></IconButton>
      {tool.tool !== 'eraser' &&
        colors.map((c) => (
          <button
            key={c}
            type="button"
            className="ink-color"
            aria-label={`Farbe ${c}`}
            aria-pressed={tool.color === c}
            style={{ background: c === 'ink' ? 'var(--text)' : c }}
            onClick={() => onTool({ ...tool, color: c })}
          />
        ))}
      <IconButton label="Nur Stift zeichnet (Finger scrollt)" pressed={penOnly} onClick={() => onPenOnly(!penOnly)}><Hand /></IconButton>
    </>
  )
}
