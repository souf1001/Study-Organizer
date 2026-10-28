import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ BrowserWindow: class {} }))
const { parseLaunchToken } = await import('../src/main/moodle-sso')

const md5 = (v: string) => createHash('md5').update(v).digest('hex')
const encode = (v: string) => Buffer.from(v).toString('base64')

describe('Moodle-SSO', () => {
  const site = 'https://lernen.h-da.de'
  it('reads the token when the signature is valid', () => {
    const url = `moodlemobile://token=${encode(`${md5(site + 'abc')}:::tok123:::private`)}`
    expect(parseLaunchToken(url, site, 'abc')).toBe('tok123')
  })
  it('rejects invalid signatures', () => {
    const url = `moodlemobile://token=${encode(`${md5('https://evil.example' + 'abc')}:::tok123`)}`
    expect(() => parseLaunchToken(url, site, 'abc')).toThrow()
  })
  it('ignores other addresses', () => {
    expect(parseLaunchToken('https://lernen.h-da.de/my/', site, 'abc')).toBeNull()
  })
})
