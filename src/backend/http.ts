// Reads responses from remote servers only up to a size limit, never unbounded into memory.
// Uses only web standard APIs, so it works in Node/Electron as well as in the Android WebView.

function concatBytes(chunks: Uint8Array[], total: number): Uint8Array {
  const result = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    result.set(chunk, offset)
    offset += chunk.length
  }
  return result
}

export async function readLimited(
  response: Response,
  maxBytes: number,
  what: string,
): Promise<Uint8Array> {
  const tooBig = () =>
    new Error(`${what} ist zu groß (höchstens ${Math.round(maxBytes / 1024 / 1024)} MB).`)
  if (Number(response.headers.get('content-length') ?? 0) > maxBytes) throw tooBig()
  if (!response.body) return new Uint8Array()

  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.length
      if (total > maxBytes) {
        await reader.cancel()
        throw tooBig()
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }
  return concatBytes(chunks, total)
}
