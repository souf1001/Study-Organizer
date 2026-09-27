// Dateitypen erkennen und sichere Dateinamen prüfen.
import type { FileType } from '../shared/types'

const TYPES: Record<string, [mime: string, type: FileType]> = {
  pdf: ['application/pdf', 'pdf'],
  mp4: ['video/mp4', 'video'],
  m4v: ['video/mp4', 'video'],
  webm: ['video/webm', 'video'],
  mov: ['video/quicktime', 'video'],
  mkv: ['video/x-matroska', 'video'],
  ogv: ['video/ogg', 'video'],
  mp3: ['audio/mpeg', 'audio'],
  m4a: ['audio/mp4', 'audio'],
  aac: ['audio/aac', 'audio'],
  wav: ['audio/wav', 'audio'],
  ogg: ['audio/ogg', 'audio'],
  opus: ['audio/opus', 'audio'],
  flac: ['audio/flac', 'audio'],
  png: ['image/png', 'image'],
  jpg: ['image/jpeg', 'image'],
  jpeg: ['image/jpeg', 'image'],
  gif: ['image/gif', 'image'],
  webp: ['image/webp', 'image'],
  avif: ['image/avif', 'image'],
  bmp: ['image/bmp', 'image'],
  svg: ['image/svg+xml', 'image'],
  txt: ['text/plain', 'text'],
  md: ['text/markdown', 'text'],
  csv: ['text/csv', 'text'],
  json: ['application/json', 'text'],
  tex: ['text/plain', 'text'],
  py: ['text/plain', 'text'],
  java: ['text/plain', 'text'],
  c: ['text/plain', 'text'],
  h: ['text/plain', 'text'],
  cpp: ['text/plain', 'text'],
  js: ['text/plain', 'text'],
  ts: ['text/plain', 'text'],
  sql: ['text/plain', 'text'],
  r: ['text/plain', 'text'],
  m: ['text/plain', 'text'],
  ipynb: ['application/json', 'text'],
}

export function extensionOf(name: string): string {
  const match = /\.([A-Za-z0-9]{1,10})$/.exec(name)
  return match ? match[1].toLowerCase() : ''
}

export function detectFile(name: string): { ext: string; mime: string; fileType: FileType } {
  const ext = extensionOf(name)
  const known = TYPES[ext]
  return known
    ? { ext, mime: known[0], fileType: known[1] }
    : { ext, mime: 'application/octet-stream', fileType: 'other' }
}

export function mimeForFileName(fileName: string): string {
  return detectFile(fileName).mime
}

const SAFE_ID = /^[A-Za-z0-9_-]{1,64}$/
const SAFE_FILE_NAME = /^[A-Za-z0-9_-]{1,64}(\.[A-Za-z0-9]{1,10})?$/

/** Schützt vor Pfad-Tricks wie '../' in IDs, die als Dateinamen dienen */
export function assertId(id: unknown): asserts id is string {
  if (typeof id !== 'string' || !SAFE_ID.test(id)) throw new Error('Ungültige ID')
}

export function assertFileName(name: unknown): asserts name is string {
  if (typeof name !== 'string' || !SAFE_FILE_NAME.test(name)) throw new Error('Ungültiger Dateiname')
}

/** Titel aus Dateinamen: Endung weg, Unterstriche zu Leerzeichen */
export function titleFromFileName(name: string): string {
  const base = name.replace(/\.[^.]+$/, '').replace(/[_]+/g, ' ').trim()
  return base || name
}
