// Converts a note (TipTap/ProseMirror JSON) to Markdown, so notes can be read as plain files
// in the documents folder, e.g. by coding agents or other editors.
import type { NoteDoc } from './types'

interface PMNode {
  type?: string
  text?: string
  attrs?: Record<string, unknown>
  marks?: { type: string; attrs?: Record<string, unknown> }[]
  content?: PMNode[]
}

function inline(nodes: PMNode[] | undefined): string {
  return (nodes ?? [])
    .map((node) => {
      if (node.type === 'hardBreak') return '  \n'
      if (node.type === 'inlineMath') return `$${String(node.attrs?.latex ?? '')}$`
      if (node.type === 'image') return `![${String(node.attrs?.alt ?? 'Bild')}]()`
      if (node.type !== 'text') return inline(node.content)
      let text = node.text ?? ''
      const marks = new Set((node.marks ?? []).map((m) => m.type))
      if (marks.has('code')) return `\`${text}\``
      if (marks.has('bold')) text = `**${text}**`
      if (marks.has('italic')) text = `*${text}*`
      if (marks.has('strike')) text = `~~${text}~~`
      if (marks.has('highlight')) text = `==${text}==`
      const link = node.marks?.find((m) => m.type === 'link')
      if (link) text = `[${text}](${String(link.attrs?.href ?? '')})`
      return text
    })
    .join('')
}

const indent = (text: string, prefix: string) =>
  text
    .split('\n')
    .map((line) => (line ? prefix + line : line))
    .join('\n')

function list(node: PMNode, marker: (index: number) => string): string {
  return (node.content ?? [])
    .map((entry, index) => {
      const checkbox = entry.type === 'taskItem' ? (entry.attrs?.checked ? '[x] ' : '[ ] ') : ''
      const head = marker(index) + checkbox
      const body = blocks(entry.content)
      return head + indent(body, ' '.repeat(head.length - checkbox.length)).trimStart()
    })
    .join('\n')
}

function table(node: PMNode): string {
  const rows = (node.content ?? []).map((row) =>
    (row.content ?? []).map((cell) =>
      blocks(cell.content).replace(/\n+/g, ' ').replace(/\|/g, '\\|'),
    ),
  )
  if (rows.length === 0) return ''
  const width = Math.max(...rows.map((r) => r.length))
  const line = (cells: string[]) =>
    `| ${Array.from({ length: width }, (_, i) => cells[i] ?? '').join(' | ')} |`
  return [line(rows[0]), line(new Array(width).fill('---')), ...rows.slice(1).map(line)].join('\n')
}

function block(node: PMNode): string {
  switch (node.type) {
    case 'heading':
      return `${'#'.repeat(Number(node.attrs?.level ?? 1))} ${inline(node.content)}`
    case 'paragraph':
      return inline(node.content)
    case 'bulletList':
    case 'taskList':
      return list(node, () => '- ')
    case 'orderedList': {
      const start = Number(node.attrs?.start ?? 1)
      return list(node, (i) => `${start + i}. `)
    }
    case 'blockquote':
      return indent(blocks(node.content), '> ')
    case 'codeBlock':
      return `\`\`\`${String(node.attrs?.language ?? '')}\n${inline(node.content)}\n\`\`\``
    case 'blockMath':
      return `$$\n${String(node.attrs?.latex ?? '')}\n$$`
    case 'horizontalRule':
      return '---'
    case 'table':
      return table(node)
    case 'image':
      return inline([node])
    default:
      return node.content ? blocks(node.content) : inline([node])
  }
}

function blocks(nodes: PMNode[] | undefined): string {
  return (nodes ?? [])
    .map(block)
    .filter((text) => text.trim() !== '')
    .join('\n\n')
}

/** Markdown for a note; falls back to the plain text when there is no structured content */
export function noteToMarkdown(title: string, doc: NoteDoc | null): string {
  let body: string
  try {
    body = doc?.content ? blocks((doc.content as PMNode).content) : ''
  } catch {
    body = ''
  }
  if (!body.trim()) body = doc?.text?.trim() ?? ''
  return `# ${title}\n\n${body}\n`
}
