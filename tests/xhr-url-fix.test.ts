import { describe, expect, it } from 'vitest'
import { passXhrUrlsAsStrings } from '../src/shared/xhr-url-fix'

describe('XHR URL fix for the Android native HTTP patch', () => {
  it('passes URL objects to open() as strings', () => {
    const received: unknown[] = []
    // Behaves like Capacitor's patched open(): it calls startsWith on the URL
    const prototype = {
      open(method: string, url: string) {
        received.push(method, url.startsWith('blob:'), url)
      },
    } as unknown as XMLHttpRequest

    passXhrUrlsAsStrings(prototype)
    prototype.open('GET', new URL('blob:https://localhost/1234'))

    expect(received).toEqual(['GET', true, 'blob:https://localhost/1234'])
  })
})
