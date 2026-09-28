// Notiz: Text (TipTap) + Handschrift-Ebene + Papier. Speichert automatisch.
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { EditorContent, useEditor, type Editor } from '@tiptap/react'
import 'katex/dist/katex.min.css'
import { emptyNote } from '@shared/defaults'
import type { Item, NoteDoc, Stroke } from '@shared/types'
import { api } from '@/lib/api'
import { pickFiles } from '@/lib/actions'
import { putRecord, updateSettings, useDb } from '@/lib/db'
import { confirm, prompt } from '@/ui/Dialogs'
import { toastError } from '@/ui/Toast'
import { buildExtensions, useSlash, type EditorActions } from './extensions'
import { InkLayer } from './InkLayer'
import { inkBottom, type InkTool } from './ink'
import { NoteToolbar } from './NoteToolbar'
import { fontCss, paperTone } from './paper'
import './note.css'
import './paper.css'

const SAVE_DELAY = 500

// Noch nicht bestätigte Speicherungen. Wird eine Notiz neu geöffnet (z. B. beim Teilen des
// Bildschirms), bevor das Speichern fertig ist, gilt der Stand von hier.
const pendingSaves = new Map<string, NoteDoc>()

function writeNote(id: string, doc: NoteDoc): void {
  pendingSaves.set(id, doc)
  api
    .writeNote(id, doc)
    .catch(toastError)
    .finally(() => pendingSaves.get(id) === doc && pendingSaves.delete(id))
}
const HISTORY_LIMIT = 60
const EXTEND_BY = 800

function SlashMenu() {
  const { open, items, index, rect, select } = useSlash()
  if (!open || !rect || items.length === 0) return null
  const top = Math.min(rect.bottom + 6, window.innerHeight - 340)
  return createPortal(
    <div className="menu slash-menu" style={{ left: rect.left, top }} role="listbox">
      {items.map((item, i) => (
        <button
          key={item.title}
          type="button"
          role="option"
          aria-selected={i === index}
          className="menu-item slash-item"
          onMouseDown={(e) => {
            e.preventDefault()
            select(item)
          }}
          onMouseEnter={() => useSlash.setState({ index: i })}
        >
          <span className="slash-icon"><item.icon /></span>
          <span>
            <span className="slash-title">{item.title}</span>
            <span className="slash-hint">{item.hint}</span>
          </span>
        </button>
      ))}
    </div>,
    document.body,
  )
}

/** Breite des Bereichs beobachten, um die Seite bei Bedarf zu verkleinern */
function useWidth(ref: React.RefObject<HTMLElement | null>): number {
  const [width, setWidth] = useState(0)
  useLayoutEffect(() => {
    if (!ref.current) return
    const observer = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width))
    observer.observe(ref.current)
    return () => observer.disconnect()
  }, [ref])
  return width
}

function NoteEditor({ item, initial }: { item: Item; initial: NoteDoc }) {
  const settings = useDb().settings.editor
  const [meta, setMeta] = useState(() => ({ paper: initial.paper, paperColor: initial.paperColor, font: initial.font, height: initial.height }))
  const [strokes, setStrokes] = useState<Stroke[]>(initial.strokes)
  const [drawing, setDrawing] = useState(false)
  const [tool, setTool] = useState<InkTool>({ tool: 'pen', color: settings.penColor, size: settings.penSize })
  const [history, setHistory] = useState<{ undo: Stroke[][]; redo: Stroke[][] }>({ undo: [], redo: [] })
  const [title, setTitle] = useState(item.title)
  const [contentHeight, setContentHeight] = useState(0)
  const scrollRef = useRef<HTMLDivElement>(null)
  const pageRef = useRef<HTMLDivElement>(null)
  const editorRef = useRef<Editor | null>(null)
  const available = useWidth(scrollRef)

  // ---- Speichern (verzögert, beim Verlassen sofort) ----
  const latest = useRef<NoteDoc>(initial)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const flush = useCallback(() => {
    if (!timer.current) return
    clearTimeout(timer.current)
    timer.current = null
    writeNote(item.id, latest.current)
  }, [item.id])
  const save = useCallback(
    (patch: Partial<NoteDoc>) => {
      latest.current = { ...latest.current, ...patch }
      if (timer.current) clearTimeout(timer.current)
      timer.current = setTimeout(flush, SAVE_DELAY)
    },
    [flush],
  )
  useEffect(() => {
    window.addEventListener('pagehide', flush)
    return () => {
      window.removeEventListener('pagehide', flush)
      flush()
    }
  }, [flush])

  // ---- Titel ----
  const titleTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const changeTitle = (value: string) => {
    setTitle(value)
    if (titleTimer.current) clearTimeout(titleTimer.current)
    titleTimer.current = setTimeout(() => putRecord('items', { ...item, title: value.trim() || 'Unbenannte Notiz', updatedAt: new Date().toISOString() }), 400)
  }

  // ---- Aktionen für Slash-Menü und Werkzeugleiste ----
  const actions = useMemo<EditorActions>(
    () => ({
      insertImage: () =>
        void pickFiles('image/*').then(async (files) => {
          const images = await api.addFiles({ moduleId: item.moduleId, folderId: item.folderId, attachedTo: item.id }, files)
          for (const image of images) editorRef.current?.chain().focus().setImage({ src: api.fileUrl(image), alt: image.title }).run()
        }),
      editMath: async (kind, latex, pos) => {
        const value = await prompt({ title: kind === 'block' ? 'Formel (LaTeX)' : 'Formel im Text (LaTeX)', initial: latex ?? '', placeholder: 'z. B. \\int_0^1 x^2 \\, dx', confirmLabel: 'Übernehmen' })
        const editor = editorRef.current
        if (!editor || value === null) return
        const chain = editor.chain().focus()
        if (pos === undefined) {
          if (kind === 'block') chain.insertBlockMath({ latex: value }).run()
          else chain.insertInlineMath({ latex: value }).run()
        } else if (kind === 'block') chain.setNodeSelection(pos).updateBlockMath({ latex: value }).run()
        else chain.setNodeSelection(pos).updateInlineMath({ latex: value }).run()
      },
    }),
    [item.id, item.moduleId, item.folderId],
  )

  // Eingefügte oder hineingezogene Bilder als Anhang speichern
  const insertImageFiles = useCallback(
    (files: File[]) => {
      const images = files.filter((f) => f.type.startsWith('image/'))
      if (images.length === 0) return false
      void api
        .addFiles({ moduleId: item.moduleId, folderId: item.folderId, attachedTo: item.id }, images)
        .then((added) => added.forEach((image) => editorRef.current?.chain().focus().setImage({ src: api.fileUrl(image), alt: image.title }).run()))
        .catch(toastError)
      return true
    },
    [item.id, item.moduleId, item.folderId],
  )

  const editor = useEditor({
    extensions: buildExtensions(actions),
    content: initial.content ?? '',
    editorProps: {
      attributes: { spellcheck: String(settings.spellcheck), class: 'note-prose' },
      handlePaste: (_view, event) => insertImageFiles([...(event.clipboardData?.files ?? [])]),
      handleDrop: (_view, event) => insertImageFiles([...((event as DragEvent).dataTransfer?.files ?? [])]),
    },
    onUpdate: ({ editor: e }) => save({ content: e.getJSON(), text: e.getText({ blockSeparator: '\n' }) }),
  })
  editorRef.current = editor

  // Seitenhöhe = gespeicherte Mindesthöhe oder Inhalt, je nachdem was größer ist
  useLayoutEffect(() => {
    if (!pageRef.current) return
    const observer = new ResizeObserver(() => setContentHeight(pageRef.current?.scrollHeight ?? 0))
    observer.observe(pageRef.current.querySelector('.note-prose') ?? pageRef.current)
    return () => observer.disconnect()
  }, [editor])

  // ---- Zeichnen ----
  const pageWidth = settings.wide ? 1000 : 800
  const fixed = drawing || strokes.length > 0
  // In schmalen Bereichen wird die Seite verkleinert, aber nicht unleserlich klein
  const scale = fixed && available > 0 ? Math.max(0.6, Math.min(1, (available - 32) / pageWidth)) : 1
  const pageHeight = Math.max(meta.height, contentHeight + 200)

  const changeStrokes = (next: Stroke[], recordHistory = true) => {
    if (recordHistory) setHistory((h) => ({ undo: [...h.undo, strokes].slice(-HISTORY_LIMIT), redo: [] }))
    setStrokes(next)
    const bottom = inkBottom(next)
    const height = bottom > meta.height - 300 ? meta.height + EXTEND_BY : meta.height
    if (height !== meta.height) setMeta((m) => ({ ...m, height }))
    save({ strokes: next, height })
  }

  const undo = () => {
    const previous = history.undo.at(-1)
    if (!previous) return
    setHistory((h) => ({ undo: h.undo.slice(0, -1), redo: [strokes, ...h.redo] }))
    changeStrokes(previous, false)
  }
  const redo = () => {
    const next = history.redo[0]
    if (!next) return
    setHistory((h) => ({ undo: [...h.undo, strokes], redo: h.redo.slice(1) }))
    changeStrokes(next, false)
  }

  useEffect(() => {
    if (!drawing) return
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.key.toLowerCase() !== 'z') return
      e.preventDefault()
      if (e.shiftKey) redo()
      else undo()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  const changePaper = (values: Partial<typeof meta>) => {
    setMeta((m) => ({ ...m, ...values }))
    save(values)
  }

  if (!editor) return null
  const tone = paperTone(meta.paperColor)
  const words = editor.storage.characterCount?.words?.() ?? 0

  return (
    <div className="note-view">
      <NoteToolbar
        editor={editor}
        actions={actions}
        drawing={drawing}
        onDrawing={(value) => {
          setDrawing(value)
          if (value) editor.commands.blur()
        }}
        tool={tool}
        onTool={setTool}
        penOnly={settings.penOnly}
        onPenOnly={(penOnly) => updateSettings('editor', { penOnly })}
        canUndo={history.undo.length > 0}
        canRedo={history.redo.length > 0}
        onUndo={undo}
        onRedo={redo}
        onExtend={() => changePaper({ height: pageHeight + EXTEND_BY })}
        onClear={() =>
          void confirm({ title: 'Alle Zeichnungen löschen?', confirmLabel: 'Löschen', danger: true }).then((ok) => ok && changeStrokes([]))
        }
        paper={meta}
        onPaper={changePaper}
      />
      <div className="note-scroll" ref={scrollRef}>
        <div
          ref={pageRef}
          className={`note-page paper paper-${meta.paper} ${fixed ? 'fixed' : ''}`}
          data-color={meta.paperColor}
          data-tone={tone}
          style={{
            width: fixed ? pageWidth : undefined,
            maxWidth: fixed ? undefined : pageWidth,
            minHeight: pageHeight,
            zoom: scale,
            fontFamily: fontCss(meta.font),
            fontSize: settings.fontSize,
          }}
        >
          <input
            className="note-title input-bare"
            value={title}
            placeholder="Unbenannte Notiz"
            aria-label="Titel"
            onChange={(e) => changeTitle(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                editor.commands.focus('start')
              }
            }}
          />
          <EditorContent editor={editor} />
          <InkLayer
            width={fixed ? pageWidth : (pageRef.current?.clientWidth ?? pageWidth)}
            height={pageHeight}
            strokes={strokes}
            tool={drawing ? tool : null}
            penOnly={settings.penOnly}
            onChange={changeStrokes}
          />
        </div>
        <div className="note-footer small faint">{words} Wörter</div>
      </div>
      <SlashMenu />
    </div>
  )
}

export function NoteView({ item }: { item: Item }) {
  const editorSettings = useDb().settings.editor
  const [doc, setDoc] = useState<NoteDoc | null>(null)
  useEffect(() => {
    let active = true
    const pending = pendingSaves.get(item.id)
    if (pending) {
      setDoc(pending)
      return
    }
    api
      .readNote(item.id)
      .then((d) => active && setDoc(d ?? emptyNote(editorSettings)))
      .catch(toastError)
    return () => {
      active = false
    }
    // Nur beim Wechsel der Notiz neu laden
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [item.id])
  if (!doc) return null
  return <NoteEditor item={item} initial={doc} />
}
