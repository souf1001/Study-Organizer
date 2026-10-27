// Antworten fremder Server nur bis zu einer Höchstgröße lesen – nie unbegrenzt in den Speicher.

export async function readLimited(response: Response, maxBytes: number, what: string): Promise<Uint8Array> {
  const tooBig = () => new Error(`${what} ist zu groß (höchstens ${Math.round(maxBytes / 1024 / 1024)} MB).`)
  if (Number(response.headers.get('content-length') ?? 0) > maxBytes) throw tooBig()
  if (!response.body) return new Uint8Array()
  const chunks: Uint8Array[] = []
  let total = 0
  // Abbruch mitten in der Schleife beendet auch den Download
  for await (const chunk of response.body) {
    total += chunk.length
    if (total > maxBytes) throw tooBig()
    chunks.push(chunk)
  }
  if (typeof Buffer !== 'undefined' && typeof Buffer.concat === 'function') {
    return Buffer.concat(chunks)
  }
  const result = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    result.set(chunk, offset)
    offset += chunk.length
  }
  return result
}
