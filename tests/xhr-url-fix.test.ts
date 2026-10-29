import { describe, expect, it } from 'vitest'
import { passXhrUrlsAsStrings } from '../src/shared/xhr-url-fix'

describe('XHR URL fix for the Android native HTTP patch', () => {
  it('passes URL objects to open() as strings, even though open() is replaced per request', () => {
    const received: unknown[] = []
    // Behaves like Capacitor's patched XMLHttpRequest: the constructor assigns a new open()
    // to the prototype every time, and that open() calls startsWith on the URL
    class FakeXhr {
      constructor() {
        FakeXhr.prototype.open = function (method: string, url: string) {
          received.push(method, url.startsWith('blob:'), url)
        }
      }
      open(_method: string, _url: string): void {}
    }
    const target = { XMLHttpRequest: FakeXhr as unknown as new () => XMLHttpRequest }

    passXhrUrlsAsStrings(target)
    for (const id of ['1', '2']) {
      new target.XMLHttpRequest().open('GET', new URL(`blob:https://localhost/${id}`))
    }

    expect(received).toEqual([
      'GET',
      true,
      'blob:https://localhost/1',
      'GET',
      true,
      'blob:https://localhost/2',
    ])
    expect((target.XMLHttpRequest as unknown as { DONE: number }).DONE).toBe(4)
    expect(new target.XMLHttpRequest()).toBeInstanceOf(FakeXhr)
  })
})
