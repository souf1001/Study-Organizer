// TipTap-Erweiterungen für Notizen inkl. Slash-Menü („/“).
import { Extension, type Editor } from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'
import { TextStyleKit } from '@tiptap/extension-text-style'
import { Highlight } from '@tiptap/extension-highlight'
import { TaskItem, TaskList } from '@tiptap/extension-list'
import { Placeholder, CharacterCount } from '@tiptap/extensions'
import { TextAlign } from '@tiptap/extension-text-align'
import { TableKit } from '@tiptap/extension-table'
import { Image } from '@tiptap/extension-image'
import { Mathematics } from '@tiptap/extension-mathematics'
import { Subscript } from '@tiptap/extension-subscript'
import { Superscript } from '@tiptap/extension-superscript'
import { Typography } from '@tiptap/extension-typography'
import { Suggestion } from '@tiptap/suggestion'
import { PluginKey } from '@tiptap/pm/state'
import type { Node as PMNode } from '@tiptap/pm/model'
import { create } from 'zustand'
import {
  CheckSquare,
  Code2,
  Heading1,
  Heading2,
  Heading3,
  ImageIcon,
  List,
  ListOrdered,
  Minus,
  Quote,
  Sigma,
  Table,
  Type,
  type LucideIcon,
} from 'lucide-react'

/** Aktionen, die die Notiz-Ansicht bereitstellt (brauchen Upload bzw. Dialoge) */
export interface EditorActions {
  insertImage: () => void
  editMath: (kind: 'inline' | 'block', latex?: string, pos?: number) => void
}

export interface SlashItem {
  title: string
  hint: string
  keywords: string
  icon: LucideIcon
  run: (editor: Editor, actions: EditorActions) => void
}

export const SLASH_ITEMS: SlashItem[] = [
  { title: 'Text', hint: 'Normaler Absatz', keywords: 'text absatz paragraph', icon: Type, run: (e) => e.chain().focus().setParagraph().run() },
  { title: 'Überschrift 1', hint: 'Große Überschrift', keywords: 'h1 titel heading', icon: Heading1, run: (e) => e.chain().focus().setHeading({ level: 1 }).run() },
  { title: 'Überschrift 2', hint: 'Mittlere Überschrift', keywords: 'h2 heading', icon: Heading2, run: (e) => e.chain().focus().setHeading({ level: 2 }).run() },
  { title: 'Überschrift 3', hint: 'Kleine Überschrift', keywords: 'h3 heading', icon: Heading3, run: (e) => e.chain().focus().setHeading({ level: 3 }).run() },
  { title: 'Aufzählung', hint: 'Liste mit Punkten', keywords: 'liste bullet ul', icon: List, run: (e) => e.chain().focus().toggleBulletList().run() },
  { title: 'Nummerierte Liste', hint: '1. 2. 3.', keywords: 'liste nummer ordered ol', icon: ListOrdered, run: (e) => e.chain().focus().toggleOrderedList().run() },
  { title: 'Checkliste', hint: 'Aufgaben zum Abhaken', keywords: 'todo aufgabe task check', icon: CheckSquare, run: (e) => e.chain().focus().toggleTaskList().run() },
  { title: 'Zitat', hint: 'Hervorgehobener Block', keywords: 'quote zitat', icon: Quote, run: (e) => e.chain().focus().toggleBlockquote().run() },
  { title: 'Code', hint: 'Code-Block', keywords: 'code programm', icon: Code2, run: (e) => e.chain().focus().toggleCodeBlock().run() },
  { title: 'Formel', hint: 'LaTeX, eigene Zeile', keywords: 'mathe latex formel math', icon: Sigma, run: (_e, a) => a.editMath('block') },
  { title: 'Formel im Text', hint: 'LaTeX im Satz', keywords: 'mathe latex inline math', icon: Sigma, run: (_e, a) => a.editMath('inline') },
  { title: 'Tabelle', hint: '3 × 3', keywords: 'tabelle table', icon: Table, run: (e) => e.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run() },
  { title: 'Bild', hint: 'Foto oder Grafik einfügen', keywords: 'bild foto image', icon: ImageIcon, run: (_e, a) => a.insertImage() },
  { title: 'Trennlinie', hint: 'Horizontale Linie', keywords: 'linie divider hr', icon: Minus, run: (e) => e.chain().focus().setHorizontalRule().run() },
]

// Zustand des Slash-Menüs – gerendert von <SlashMenu /> in der Notiz-Ansicht
interface SlashState {
  open: boolean
  items: SlashItem[]
  index: number
  rect: DOMRect | null
  select: (item: SlashItem) => void
}

export const useSlash = create<SlashState>(() => ({ open: false, items: [], index: 0, rect: null, select: () => undefined }))

function filterItems(query: string): SlashItem[] {
  const q = query.toLowerCase()
  return SLASH_ITEMS.filter((i) => `${i.title} ${i.keywords}`.toLowerCase().includes(q)).slice(0, 12)
}

function slashCommand(actions: EditorActions) {
  return Extension.create({
    name: 'slashCommand',
    addProseMirrorPlugins() {
      return [
        Suggestion<SlashItem, SlashItem>({
          editor: this.editor,
          pluginKey: new PluginKey('slashCommand'),
          char: '/',
          items: ({ query }) => filterItems(query),
          command: ({ editor, range, props }) => {
            editor.chain().focus().deleteRange(range).run()
            props.run(editor, actions)
          },
          render: () => ({
            onStart: (props) =>
              useSlash.setState({ open: true, items: props.items, index: 0, rect: props.clientRect?.() ?? null, select: props.command }),
            onUpdate: (props) =>
              useSlash.setState((s) => ({
                items: props.items,
                index: Math.min(s.index, Math.max(0, props.items.length - 1)),
                rect: props.clientRect?.() ?? null,
                select: props.command,
              })),
            onKeyDown: ({ event }) => {
              const { items, index, select } = useSlash.getState()
              if (event.key === 'ArrowDown') useSlash.setState({ index: (index + 1) % Math.max(1, items.length) })
              else if (event.key === 'ArrowUp') useSlash.setState({ index: (index - 1 + items.length) % Math.max(1, items.length) })
              else if (event.key === 'Enter' && items[index]) select(items[index])
              else if (event.key === 'Escape') useSlash.setState({ open: false })
              else return false
              return true
            },
            onExit: () => useSlash.setState({ open: false }),
          }),
        }),
      ]
    },
  })
}

export function buildExtensions(actions: EditorActions) {
  return [
    StarterKit.configure({
      heading: { levels: [1, 2, 3] },
      link: { openOnClick: true, autolink: true, defaultProtocol: 'https' },
    }),
    TextStyleKit,
    Highlight.configure({ multicolor: true }),
    TaskList,
    TaskItem.configure({ nested: true }),
    TextAlign.configure({ types: ['heading', 'paragraph'] }),
    TableKit.configure({ table: { resizable: false } }),
    Image.configure({ allowBase64: false }),
    Subscript,
    Superscript,
    Typography.configure({ openDoubleQuote: '„', closeDoubleQuote: '“', openSingleQuote: '‚', closeSingleQuote: '‘' }),
    Mathematics.configure({
      katexOptions: { throwOnError: false },
      inlineOptions: { onClick: (node: PMNode, pos: number) => actions.editMath('inline', node.attrs.latex as string, pos) },
      blockOptions: { onClick: (node: PMNode, pos: number) => actions.editMath('block', node.attrs.latex as string, pos) },
    }),
    Placeholder.configure({
      placeholder: ({ node }) => (node.type.name === 'heading' ? 'Überschrift' : 'Schreibe etwas oder tippe „/“ für Befehle …'),
    }),
    CharacterCount,
    slashCommand(actions),
  ]
}
