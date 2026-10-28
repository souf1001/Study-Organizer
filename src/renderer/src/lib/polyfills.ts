// Replacements for browser functions that pdf.js (and the app) use but that an older Android
// WebView lacks. In Electron they all exist and nothing is replaced. Loaded first, both in
// the page (main.tsx) and in the pdf.js worker (pdf-worker.ts).
//
// The pdf.js legacy build already covers Map.getOrInsert, Math.sumPrecise, URL.parse and the
// like; these are the ones it leaves out.

// The TypeScript types declare these functions as always present, so each one is checked
// through a loosely typed view of its owner.

// Chrome 119
const promiseStatics = Promise as unknown as { withResolvers?: unknown }
if (!promiseStatics.withResolvers) {
  promiseStatics.withResolvers = function withResolvers<T>() {
    let resolve!: (value: T | PromiseLike<T>) => void
    let reject!: (reason?: unknown) => void
    const promise = new Promise<T>((res, rej) => {
      resolve = res
      reject = rej
    })
    return { promise, resolve, reject }
  }
}

// Chrome 132
for (const prototype of [Response.prototype, Blob.prototype]) {
  if (!prototype.bytes) {
    prototype.bytes = async function bytes(this: Response | Blob) {
      return new Uint8Array(await this.arrayBuffer())
    } as typeof prototype.bytes
  }
}

// Chrome 124: `for await (const chunk of readableStream)`
const streamPrototype = ReadableStream.prototype as unknown as {
  [Symbol.asyncIterator]?: (this: ReadableStream) => AsyncGenerator<unknown>
}
if (!streamPrototype[Symbol.asyncIterator]) {
  streamPrototype[Symbol.asyncIterator] = async function* iterate(this: ReadableStream) {
    const reader = this.getReader()
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) return
        yield value
      }
    } finally {
      reader.releaseLock()
    }
  }
}

// Chrome 116
if (typeof AbortSignal !== 'undefined' && !AbortSignal.any) {
  AbortSignal.any = function any(signals: AbortSignal[]) {
    const controller = new AbortController()
    for (const signal of signals) {
      if (signal.aborted) {
        controller.abort(signal.reason)
        break
      }
      signal.addEventListener('abort', () => controller.abort(signal.reason), { once: true })
    }
    return controller.signal
  }
}

export {}
