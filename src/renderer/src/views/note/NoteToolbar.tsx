// Werkzeugleiste der Notiz: Textformatierung oder Zeichenwerkzeuge.
import { useState } from 'react'
import { createPortal } from 'react-dom'
import { useEditorState, type Editor } from '@tiptap/react'
import {
  AlignCenter,
  AlignLeft,
  AlignRight,
  Baseline,
  Bold,
  CheckSquare,
  Code,
  Eraser,
  Highlighter,
  ImageIcon,
  Italic,
  Link,
  List,
  ListOrdered,
  PenLine,
  Plus,
  Quote,
  Redo2,
  Sigma,
  Strikethrough,
  Table,
  Trash2,
  Type,
  Underline,
  Undo2,
  Minus,
  ArrowDownToLine,
  Hand,
  Subscript,
  Superscript,
  StickyNote,
} from 'lucide-react'
import type { FontId, PaperColorId, PaperId } from '@shared/types'
import { IconButton } from '@/ui/Button'
import { Segmented } from '@/ui/Field'
import { showMenu } from '@/ui/Menu'
import { prompt } from '@/ui/Dialogs'
import type { EditorActions } from './extensions'
import type { InkTool, InkToolId } from './ink'
import { FONTS, MARKER_COLORS, PEN_COLORS, PEN_SIZES } from './paper'
import { PaperColorPicker, PaperPicker } from './PaperPicker'

const TEXT_COLORS = [
  { label: 'Standard', value: '' },
  { label: 'Grau', value: '#787774' },
  { label: 'Rot', value: '#d44c47' },
  { label: 'Orange', value: '#d9730d' },
  { label: 'Grün', value: '#448361' },
  { label: 'Blau', value: '#337ea9' },
  { label: 'Lila', value: '#9065b0' },
]

const HIGHLIGHTS = [
  { label: 'Keine', value: '' },
  { label: 'Gelb', value: '#fbf3a4' },
  { label: 'Grün', value: '#cdeccd' },
  { label: 'Blau', value: '#cfe7f7' },
  { label: 'Rosa', value: '#f9d6e6' },
  { label: 'Orange', value: '#fbdcc0' },
]

const SIZES = ['', '12px', '14px', '16px', '18px', '20px', '24px', '28px', '32px']

function Swatch({ color }: { color: string }) {
  return <span className="menu-swatch" style={{ background: color || 'transparent' }} />
}

function TextTools({ editor, actions }: { editor: Editor; actions: EditorActions }) {
  const state = useEditorState({
    editor,
    selector: ({ editor: e }) => ({
      bold: e.isActive('bold'),
      italic: e.isActive('italic'),
      underline: e.isActive('underline'),
      strike: e.isActive('strike'),
      code: e.isActive('code'),
      sub: e.isActive('subscript'),
      sup: e.isActive('superscript'),
      bullet: e.isActive('bulletList'),
      ordered: e.isActive('orderedList'),
      task: e.isActive('taskList'),
      block: e.isActive('heading', { level: 1 }) ? 'h1' : e.isActive('heading', { level: 2 }) ? 'h2' : e.isActive('heading', { level: 3 }) ? 'h3' : 'p',
      font: (e.getAttributes('textStyle').fontFamily as string | undefined) ?? '',
      size: (e.getAttributes('textStyle').fontSize as string | undefined) ?? '',
      canUndo: e.can().undo(),
      canRedo: e.can().redo(),
    }),
  })
  const chain = () => editor.chain().focus()

  const setLink = async () => {
    const previous = editor.getAttributes('link').href as string | undefined
    const url = await prompt({ title: 'Link', initial: previous ?? 'https://', confirmLabel: 'Übernehmen' })
    if (url === null) return
    if (!url || url === 'https://') chain().extendMarkRange('link').unsetLink().run()
    else chain().extendMarkRange('link').setLink({ href: url }).run()
  }

  return (
    <>
      <select
        className="toolbar-select"
        aria-label="Absatzformat"
        value={state.block}
        onChange={(e) => {
          const v = e.target.value
          if (v === 'p') chain().setParagraph().run()
          else chain().setHeading({ level: Number(v.slice(1)) as 1 | 2 | 3 }).run()
        }}
      >
        <option value="p">Text</option>
        <option value="h1">Überschrift 1</option>
        <option value="h2">Überschrift 2</option>
        <option value="h3">Überschrift 3</option>
      </select>
      <select
        className="toolbar-select"
        aria-label="Schriftart"
        value={state.font}
        onChange={(e) => (e.target.value ? chain().setFontFamily(e.target.value).run() : chain().unsetFontFamily().run())}
      >
        <option value="">Schrift</option>
        {FONTS.map((f) => (
          <option key={f.id} value={f.css}>
            {f.label}
          </option>
        ))}
      </select>
      <select
        className="toolbar-select narrow"
        aria-label="Schriftgröße"
        value={state.size}
        onChange={(e) => (e.target.value ? chain().setFontSize(e.target.value).run() : chain().unsetFontSize().run())}
      >
        {SIZES.map((s) => (
          <option key={s} value={s}>
            {s ? s.replace('px', '') : 'Größe'}
          </option>
        ))}
      </select>
      <span className="toolbar-sep" />
      <IconButton label="Fett" pressed={state.bold} onClick={() => chain().toggleBold().run()}><Bold /></IconButton>
      <IconButton label="Kursiv" pressed={state.italic} onClick={() => chain().toggleItalic().run()}><Italic /></IconButton>
      <IconButton label="Unterstrichen" pressed={state.underline} onClick={() => chain().toggleUnderline().run()}><Underline /></IconButton>
      <IconButton label="Durchgestrichen" pressed={state.strike} onClick={() => chain().toggleStrike().run()}><Strikethrough /></IconButton>
      <IconButton
        label="Textfarbe"
        onClick={(e) =>
          showMenu(e.currentTarget, TEXT_COLORS.map((c) => ({
            label: c.label,
            icon: <Swatch color={c.value} />,
            onClick: () => (c.value ? chain().setColor(c.value).run() : chain().unsetColor().run()),
          })))
        }
      >
        <Baseline />
      </IconButton>
      <IconButton
        label="Markieren"
        onClick={(e) =>
          showMenu(e.currentTarget, HIGHLIGHTS.map((c) => ({
            label: c.label,
            icon: <Swatch color={c.value} />,
            onClick: () => (c.value ? chain().setHighlight({ color: c.value }).run() : chain().unsetHighlight().run()),
          })))
        }
      >
        <Highlighter />
      </IconButton>
      <span className="toolbar-sep" />
      <IconButton label="Aufzählung" pressed={state.bullet} onClick={() => chain().toggleBulletList().run()}><List /></IconButton>
      <IconButton label="Nummerierte Liste" pressed={state.ordered} onClick={() => chain().toggleOrderedList().run()}><ListOrdered /></IconButton>
      <IconButton label="Checkliste" pressed={state.task} onClick={() => chain().toggleTaskList().run()}><CheckSquare /></IconButton>
      <IconButton
        label="Ausrichtung"
        onClick={(e) =>
          showMenu(e.currentTarget, [
            { label: 'Links', icon: <AlignLeft />, onClick: () => chain().setTextAlign('left').run() },
            { label: 'Zentriert', icon: <AlignCenter />, onClick: () => chain().setTextAlign('center').run() },
            { label: 'Rechts', icon: <AlignRight />, onClick: () => chain().setTextAlign('right').run() },
          ])
        }
      >
        <AlignLeft />
      </IconButton>
      <IconButton
        label="Einfügen"
        onClick={(e) =>
          showMenu(e.currentTarget, [
            { label: 'Bild', icon: <ImageIcon />, onClick: actions.insertImage },
            { label: 'Tabelle', icon: <Table />, onClick: () => chain().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run() },
            { label: 'Formel', icon: <Sigma />, onClick: () => actions.editMath('block') },
            { label: 'Formel im Text', icon: <Sigma />, onClick: () => actions.editMath('inline') },
            { label: 'Link', icon: <Link />, onClick: () => void setLink() },
            { label: 'Zitat', icon: <Quote />, onClick: () => chain().toggleBlockquote().run() },
            { label: 'Code', icon: <Code />, onClick: () => chain().toggleCodeBlock().run() },
            { label: 'Trennlinie', icon: <Minus />, onClick: () => chain().setHorizontalRule().run() },
            { separator: true },
            { label: 'Tiefgestellt', icon: <Subscript />, onClick: () => chain().toggleSubscript().run() },
            { label: 'Hochgestellt', icon: <Superscript />, onClick: () => chain().toggleSuperscript().run() },
          ])
        }
      >
        <Plus />
      </IconButton>
      <span className="toolbar-sep" />
      <IconButton label="Rückgängig" disabled={!state.canUndo} onClick={() => chain().undo().run()}><Undo2 /></IconButton>
      <IconButton label="Wiederholen" disabled={!state.canRedo} onClick={() => chain().redo().run()}><Redo2 /></IconButton>
    </>
  )
}

interface DrawToolsProps {
  tool: InkTool
  onTool: (tool: InkTool) => void
  penOnly: boolean
  onPenOnly: (value: boolean) => void
  canUndo: boolean
  canRedo: boolean
  onUndo: () => void
  onRedo: () => void
  onExtend: () => void
  onClear: () => void
}

function DrawTools(p: DrawToolsProps) {
  const set = (values: Partial<InkTool>) => p.onTool({ ...p.tool, ...values })
  const pick = (id: InkToolId) =>
    set({ tool: id, color: id === 'marker' && !MARKER_COLORS.includes(p.tool.color) ? MARKER_COLORS[0] : id === 'pen' && MARKER_COLORS.includes(p.tool.color) ? 'ink' : p.tool.color })
  const colors = p.tool.tool === 'marker' ? MARKER_COLORS : PEN_COLORS
  return (
    <>
      <IconButton label="Stift" pressed={p.tool.tool === 'pen'} onClick={() => pick('pen')}><PenLine /></IconButton>
      <IconButton label="Textmarker" pressed={p.tool.tool === 'marker'} onClick={() => pick('marker')}><Highlighter /></IconButton>
      <IconButton label="Radierer" pressed={p.tool.tool === 'eraser'} onClick={() => pick('eraser')}><Eraser /></IconButton>
      <span className="toolbar-sep" />
      {p.tool.tool !== 'eraser' &&
        colors.map((c) => (
          <button
            key={c}
            type="button"
            className="ink-color"
            aria-label={`Farbe ${c}`}
            aria-pressed={p.tool.color === c}
            style={{ background: c === 'ink' ? 'var(--text)' : c }}
            onClick={() => set({ color: c })}
          />
        ))}
      <span className="toolbar-sep" />
      {PEN_SIZES.map((s) => (
        <button key={s} type="button" className="ink-size" aria-label={`Stärke ${s}`} aria-pressed={p.tool.size === s} onClick={() => set({ size: s })}>
          <span style={{ width: s + 2, height: s + 2 }} />
        </button>
      ))}
      <span className="toolbar-sep" />
      <IconButton label="Nur Stift zeichnet (Finger scrollt)" pressed={p.penOnly} onClick={() => p.onPenOnly(!p.penOnly)}><Hand /></IconButton>
      <IconButton label="Rückgängig" disabled={!p.canUndo} onClick={p.onUndo}><Undo2 /></IconButton>
      <IconButton label="Wiederholen" disabled={!p.canRedo} onClick={p.onRedo}><Redo2 /></IconButton>
      <IconButton label="Seite verlängern" onClick={p.onExtend}><ArrowDownToLine /></IconButton>
      <IconButton label="Alle Zeichnungen löschen" onClick={p.onClear}><Trash2 /></IconButton>
    </>
  )
}

interface PaperSettings {
  paper: PaperId
  paperColor: PaperColorId
  font: FontId
}

function PaperButton({ value, onChange }: { value: PaperSettings; onChange: (v: Partial<PaperSettings>) => void }) {
  const [anchor, setAnchor] = useState<DOMRect | null>(null)
  return (
    <>
      <IconButton label="Papier & Schrift" onClick={(e) => setAnchor(anchor ? null : e.currentTarget.getBoundingClientRect())}>
        <StickyNote />
      </IconButton>
      {anchor &&
        createPortal(
          <div className="overlay transparent" onMouseDown={(e) => e.target === e.currentTarget && setAnchor(null)}>
            <div className="popover paper-popover" style={{ top: anchor.bottom + 6, right: Math.max(8, window.innerWidth - anchor.right) }}>
              <div className="popover-label">Papier</div>
              <PaperPicker value={value.paper} onChange={(paper) => onChange({ paper })} />
              <div className="popover-label">Papierfarbe</div>
              <PaperColorPicker value={value.paperColor} onChange={(paperColor) => onChange({ paperColor })} />
              <div className="popover-label">Schrift der Notiz</div>
              <select className="select" value={value.font} onChange={(e) => onChange({ font: e.target.value as FontId })}>
                {FONTS.map((f) => (
                  <option key={f.id} value={f.id}>
                    {f.label}
                  </option>
                ))}
              </select>
            </div>
          </div>,
          document.body,
        )}
    </>
  )
}

export interface NoteToolbarProps extends Omit<DrawToolsProps, 'tool' | 'onTool'> {
  editor: Editor
  actions: EditorActions
  drawing: boolean
  onDrawing: (drawing: boolean) => void
  tool: InkTool
  onTool: (tool: InkTool) => void
  paper: PaperSettings
  onPaper: (v: Partial<PaperSettings>) => void
}

export function NoteToolbar(props: NoteToolbarProps) {
  return (
    <div className="note-toolbar">
      <Segmented
        value={props.drawing ? 'draw' : 'text'}
        onChange={(v) => props.onDrawing(v === 'draw')}
        options={[
          { value: 'text', label: 'Text', icon: <Type /> },
          { value: 'draw', label: 'Zeichnen', icon: <PenLine /> },
        ]}
      />
      <span className="toolbar-sep" />
      <div className="toolbar-tools">
        {props.drawing ? <DrawTools {...props} /> : <TextTools editor={props.editor} actions={props.actions} />}
      </div>
      <span className="spacer" />
      <PaperButton value={props.paper} onChange={props.onPaper} />
    </div>
  )
}
