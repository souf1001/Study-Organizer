import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ BrowserWindow: class {} }))
const { parseLaunchToken } = await import('../src/main/moodle-sso')

const md5 = (v: string) => createHash('md5').update(v).digest('hex')
const encode = (v: string) => Buffer.from(v).toString('base64')

describe('Moodle-SSO', () => {
  const site = 'https://lernen.h-da.de'
  it('liest den Token bei gültiger Signatur', () => {
    const url = `moodlemobile://token=${encode(`${md5(site + 'abc')}:::tok123:::private`)}`
    expect(parseLaunchToken(url, site, 'abc')).toBe('tok123')
  })
  it('lehnt falsche Signaturen ab', () => {
    const url = `moodlemobile://token=${encode(`${md5('https://evil.example' + 'abc')}:::tok123`)}`
    expect(() => parseLaunchToken(url, site, 'abc')).toThrow()
  })
  it('ignoriert andere Adressen', () => {
    expect(parseLaunchToken('https://lernen.h-da.de/my/', site, 'abc')).toBeNull()
  })
})
