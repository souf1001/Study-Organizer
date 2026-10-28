import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createService, type Secrets } from '../src/backend/service'
import { Store } from '../src/backend/store'
import { md5Hex } from '../src/shared/md5'
import { parseLaunchToken } from '../src/shared/moodle-launch'
import { newModule } from '../src/shared/defaults'
import { summarizeSetupFile, type SetupExportOptions } from '../src/shared/setup-bundle'

function memorySecrets(): Secrets & { data: Map<string, string> } {
  const data = new Map<string, string>()
  return {
    data,
    get: async (name) => data.get(name) ?? null,
    set: async (name, value) => void data.set(name, value),
    remove: async (name) => void data.delete(name),
  }
}

let dir: string
beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'setup-'))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

/** A source device with one module, a note, a file, a Moodle connection and an AI key */
async function sourceDevice() {
  const store = await Store.open(path.join(dir, 'source'))
  const secrets = memorySecrets()
  const service = createService(store, secrets)
  store.update({ onboarded: true, profile: { ...store.get().profile, name: 'Soufian' } })
  const settings = store.get().settings
  store.update({
    settings: {
      ...settings,
      ai: { ...settings.ai, provider: 'openai', enabled: true },
      moodle: { ...settings.moodle, url: 'https://moodle.example', siteName: 'Moodle', userId: 7 },
    },
  })
  await secrets.set(
    'moodle',
    JSON.stringify({ value: 'token-123', target: 'https://moodle.example' }),
  )
  await secrets.set(
    'ai:openai',
    JSON.stringify({ value: 'sk-test', target: 'https://api.openai.com/v1' }),
  )

  const module = newModule('sem-1', { name: 'Analysis' })
  store.put('modules', module)
  const file = await store.addFile(
    { moduleId: module.id, folderId: null },
    { name: 'slides.pdf', type: 'application/pdf', bytes: new Uint8Array([1, 2, 3, 250]) },
  )
  const now = new Date().toISOString()
  const note = {
    ...file,
    id: 'note-1',
    kind: 'note' as const,
    fileName: null,
    fileType: null,
    title: 'Notiz',
  }
  store.put('items', { ...note, createdAt: now, updatedAt: now })
  await store.writeNote('note-1', {
    content: null,
    strokes: [],
    paper: 'plain',
    paperColor: 'auto',
    font: 'inter',
    height: 0,
    text: 'Grenzwerte',
  })
  return { store, secrets, service, module, file }
}

async function targetDevice() {
  const store = await Store.open(path.join(dir, 'target'))
  const secrets = memorySecrets()
  return { store, secrets, service: createService(store, secrets) }
}

const exportText = async (
  service: Awaited<ReturnType<typeof sourceDevice>>['service'],
  options: SetupExportOptions,
) => JSON.stringify(await service.setupExport(options))

describe('MD5', () => {
  it('matches Node crypto for empty, short and multi-block input', () => {
    for (const input of ['', 'abc', 'https://lernen.h-da.de0123456789abcdef', 'ä'.repeat(100)]) {
      expect(md5Hex(input)).toBe(createHash('md5').update(input).digest('hex'))
    }
  })
})

describe('Moodle launch token', () => {
  it('accepts base64url encoded tokens', () => {
    const site = 'https://moodle.example'
    const payload = Buffer.from(`${md5Hex(site + 'pp')}:::tok???`).toString('base64url')
    expect(parseLaunchToken(`moodlemobile://token=${payload}`, site, 'pp')).toBe('tok???')
  })
})

describe('Setup transfer', () => {
  it('moves settings and credentials without touching local study data', async () => {
    const source = await sourceDevice()
    const target = await targetDevice()
    target.store.put('modules', newModule('sem-x', { name: 'Lokales Modul' }))

    const text = await exportText(source.service, { scope: 'settings', includeCredentials: true })
    const result = await target.service.setupImport(text)

    expect(result.credentials).toBe(2)
    expect(target.store.get().onboarded).toBe(true)
    expect(target.store.get().profile.name).toBe('Soufian')
    expect(target.store.get().settings.moodle.url).toBe('https://moodle.example')
    expect(target.store.get().modules.map((m) => m.name)).toEqual(['Lokales Modul'])
    expect(await target.secrets.get('moodle')).toBe(await source.secrets.get('moodle'))
  })

  it('keeps the local Moodle connection when the file carries no credentials', async () => {
    const source = await sourceDevice()
    const target = await targetDevice()
    const settings = target.store.get().settings
    target.store.update({
      settings: {
        ...settings,
        moodle: { ...settings.moodle, url: 'https://local.example', userId: 1 },
      },
    })

    await target.service.setupImport(
      await exportText(source.service, { scope: 'settings', includeCredentials: false }),
    )

    expect(target.store.get().settings.moodle.url).toBe('https://local.example')
    expect(target.secrets.data.size).toBe(0)
  })

  it('replaces all data including notes and files for scope "everything"', async () => {
    const source = await sourceDevice()
    const target = await targetDevice()
    target.store.put('modules', newModule('sem-x', { name: 'Wird ersetzt' }))

    const text = await exportText(source.service, { scope: 'everything', includeCredentials: true })
    const result = await target.service.setupImport(text)

    expect(result.modules).toBe(1)
    expect(target.store.get().modules[0].name).toBe('Analysis')
    expect((await target.store.readNote('note-1'))?.text).toBe('Grenzwerte')
    expect(await target.store.readFile(source.file.fileName!)).toEqual(
      new Uint8Array([1, 2, 3, 250]),
    )
    expect(await target.store.search('grenzwert')).toHaveLength(1)
  })

  it('leaves notes and files out of scope "study"', async () => {
    const source = await sourceDevice()
    const target = await targetDevice()
    await target.service.setupImport(
      await exportText(source.service, { scope: 'study', includeCredentials: false }),
    )
    expect(target.store.get().modules).toHaveLength(1)
    expect(target.store.get().items).toHaveLength(0)
  })

  it('encrypts with a password and rejects a wrong one', async () => {
    const source = await sourceDevice()
    const target = await targetDevice()
    const text = await exportText(source.service, {
      scope: 'settings',
      includeCredentials: true,
      password: 'geheim',
    })

    expect(text).not.toContain('token-123')
    expect(summarizeSetupFile(text)).toEqual({ encrypted: true, scope: null, exportedAt: null })
    await expect(target.service.setupImport(text)).rejects.toThrow('Passwort')
    await expect(target.service.setupImport(text, 'falsch')).rejects.toThrow('Falsches Passwort')
    await target.service.setupImport(text, 'geheim')
    expect(await target.secrets.get('ai:openai')).toContain('sk-test')
  })

  it('rejects files that are not setup files', async () => {
    const target = await targetDevice()
    await expect(target.service.setupImport('{"hello":1}')).rejects.toThrow('keine Study-Organizer')
    await expect(target.service.setupImport('not json')).rejects.toThrow('keine Study-Organizer')
  })
})
