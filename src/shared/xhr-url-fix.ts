// Workaround for Capacitor's native HTTP patch on Android: its XMLHttpRequest.open() calls
// url.startsWith(), so it only accepts string URLs. Libraries such as pdf.js pass URL objects
// (e.g. for blob: addresses of stored files), which failed with "url.startsWith is not a
// function". Capacitor's fetch() patch handles URL objects; only XHR needs this.
//
// Capacitor assigns its open() to XMLHttpRequest.prototype again every time a request is
// created, so patching the prototype once does not last. Instead, every new request gets its
// own open() that converts the URL and then calls Capacitor's.

type Open = (this: XMLHttpRequest, method: string, url: string | URL, ...rest: unknown[]) => void
type XhrConstructor = new () => XMLHttpRequest

/** Replaces `XMLHttpRequest` on `target` so every request's open() receives a string URL */
export function passXhrUrlsAsStrings(target: { XMLHttpRequest: XhrConstructor }): void {
  const Original = target.XMLHttpRequest
  function StringUrlXMLHttpRequest(): XMLHttpRequest {
    const xhr = new Original()
    const open = xhr.open as Open
    xhr.open = function (
      this: XMLHttpRequest,
      method: string,
      url: string | URL,
      ...rest: unknown[]
    ) {
      return open.call(this, method, String(url), ...rest)
    } as XMLHttpRequest['open']
    return xhr
  }
  StringUrlXMLHttpRequest.prototype = Original.prototype
  // Constants like XMLHttpRequest.DONE
  const states = ['UNSENT', 'OPENED', 'HEADERS_RECEIVED', 'LOADING', 'DONE']
  states.forEach((name, value) => Object.defineProperty(StringUrlXMLHttpRequest, name, { value }))
  target.XMLHttpRequest = StringUrlXMLHttpRequest as unknown as XhrConstructor
}
