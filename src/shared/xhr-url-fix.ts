// Workaround for Capacitor's native HTTP patch on Android: its XMLHttpRequest.open() calls
// url.startsWith(), so it only accepts string URLs. Libraries such as pdf.js pass URL objects
// (e.g. for blob: addresses of stored files), which failed with "url.startsWith is not a
// function". Capacitor's fetch() patch handles URL objects; only XHR needs this.

type Open = (this: XMLHttpRequest, method: string, url: string | URL, ...rest: unknown[]) => void

/** Wraps `open` of the given prototype so it always receives a string URL */
export function passXhrUrlsAsStrings(prototype: XMLHttpRequest): void {
  const open = prototype.open as Open
  prototype.open = function (
    this: XMLHttpRequest,
    method: string,
    url: string | URL,
    ...rest: unknown[]
  ) {
    return open.call(this, method, String(url), ...rest)
  } as XMLHttpRequest['open']
}
