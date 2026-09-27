// studyfile://files/<name> liefert gespeicherte Dateien an die Oberfläche aus.
// Unterstützt Range-Anfragen, damit man in Videos springen kann.
import { createReadStream, promises as fs } from 'node:fs'
import { Readable } from 'node:stream'
import { protocol } from 'electron'
import { mimeForFileName } from '../backend/files'
import type { Store } from '../backend/store'

export const FILE_SCHEME = 'studyfile'

export function registerSchemePrivileges(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: FILE_SCHEME,
      privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true },
    },
  ])
}

function body(file: string, start: number, end: number): ReadableStream {
  return Readable.toWeb(createReadStream(file, { start, end })) as ReadableStream
}

export function handleFileProtocol(store: Store): void {
  protocol.handle(FILE_SCHEME, async (request) => {
    const url = new URL(request.url)
    let file: string
    try {
      if (url.hostname !== 'files') throw new Error()
      file = store.filePath(decodeURIComponent(url.pathname.slice(1)))
    } catch {
      return new Response('Not found', { status: 404 })
    }
    const stat = await fs.stat(file).catch(() => null)
    if (!stat?.isFile()) return new Response('Not found', { status: 404 })

    const headers: Record<string, string> = {
      'Content-Type': mimeForFileName(file),
      'Accept-Ranges': 'bytes',
      'Access-Control-Allow-Origin': '*',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; img-src data:; style-src 'unsafe-inline'; sandbox",
    }
    if (stat.size === 0) return new Response('', { status: 200, headers })

    const range = /^bytes=(\d*)-(\d*)$/.exec(request.headers.get('range') ?? '')
    if (!range || (!range[1] && !range[2])) {
      headers['Content-Length'] = String(stat.size)
      return new Response(body(file, 0, stat.size - 1), { status: 200, headers })
    }
    const start = range[1] ? Number(range[1]) : Math.max(0, stat.size - Number(range[2]))
    const end = range[1] && range[2] ? Math.min(Number(range[2]), stat.size - 1) : stat.size - 1
    if (start >= stat.size || start > end) {
      return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${stat.size}` } })
    }
    headers['Content-Range'] = `bytes ${start}-${end}/${stat.size}`
    headers['Content-Length'] = String(end - start + 1)
    return new Response(body(file, start, end), { status: 206, headers })
  })
}
