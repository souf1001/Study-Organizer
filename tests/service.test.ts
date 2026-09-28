import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { isSafeToOpen, titleFromFileName } from '../src/backend/files'
import { createService, type Secrets } from '../src/backend/service'
import { Store } from '../src/backend/store'

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
  dir = await mkdtemp(path.join(os.tmpdir(), 'service-'))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('Dateien öffnen', () => {
  it('erlaubt Dokumente und Medien, aber keine Programme oder Skripte', () => {
    expect(isSafeToOpen('a.pdf')).toBe(true)
    expect(isSafeToOpen('a.pptx')).toBe(true)
    expect(isSafeToOpen('a.mp4')).toBe(true)
    for (const bad of ['a.exe', 'a.lnk', 'a.bat', 'a.js', 'a.vbs', 'a.hta', 'a.command', 'a.app', 'a.sh', 'a.jar', 'a']) {
      expect(isSafeToOpen(bad)).toBe(false)
    }
  })

  it('zeigt bei unbekannten Typen die echte Endung im Titel', () => {
    expect(titleFromFileName('Vorlesung_05.pdf')).toBe('Vorlesung 05')
    expect(titleFromFileName('Vorlesung_05.pdf.exe')).toBe('Vorlesung 05.pdf.exe')
  })
})

describe('Gebundene Geheimnisse', () => {
  it('schickt einen Key nicht an eine nachträglich geänderte Adresse', async () => {
    const store = await Store.open(dir)
    const secrets = memorySecrets()
    const service = createService(store, secrets)
    const settings = store.get().settings
    store.update({ settings: { ...settings, ai: { ...settings.ai, enabled: true, provider: 'custom', baseUrl: 'https://ki.example.de/v1', model: 'm' } } })
    await service.aiSetKey('custom', 'geheim')
    expect(await service.aiHasKey('custom')).toBe(true)

    // Umleiten auf einen fremden Server schlägt fehl, bevor irgendetwas gesendet wird
    const s2 = store.get().settings
    store.update({ settings: { ...s2, ai: { ...s2.ai, baseUrl: 'https://angreifer.example/v1' } } })
    await expect(service.aiStream({ system: '', messages: [{ role: 'user', content: 'x' }] }, () => undefined, new AbortController().signal)).rejects.toThrow(
      'Adresse hat sich geändert',
    )
  })

  it('bindet den Moodle-Token an die Moodle-Adresse', async () => {
    const store = await Store.open(dir)
    const secrets = memorySecrets()
    secrets.data.set('moodle', JSON.stringify({ value: 'tok', target: 'https://lernen.h-da.de' }))
    const settings = store.get().settings
    store.update({ settings: { ...settings, moodle: { ...settings.moodle, url: 'https://angreifer.example', userId: 1 } } })
    const service = createService(store, secrets, { fetchImpl: (async () => Response.json([])) as unknown as typeof fetch })
    await expect(service.moodleCourses()).rejects.toThrow('Adresse hat sich geändert')
  })
})
