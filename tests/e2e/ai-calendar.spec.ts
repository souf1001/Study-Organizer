// AI (via a mock provider) and calendar subscription in the real app.
/// <reference lib="dom" />
import { mkdtempSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import type { Api } from '../../src/shared/api'
import { createDefaultDb, newModule, newSlot } from '../../src/shared/defaults'
import { buildSemester } from '../../src/shared/semester'
import { launchApp, samplePdf } from './helpers'
import { startMockServer } from './mock-server'

const shots = process.env.SCREENSHOT_DIR
const shot = async (page: Page, name: string) => {
  if (shots) await page.screenshot({ path: path.join(shots, `${name}.png`) })
}
const mod = process.platform === 'darwin' ? 'Meta' : 'Control'

test('AI summary, chat with context and calendar subscription', async () => {
  const mock = await startMockServer()
  const dataDir = mkdtempSync(path.join(os.tmpdir(), 'study-ai-'))

  // Prepared data: setup done, one semester, one module, AI via the mock provider
  const db = createDefaultDb()
  const semester = {
    ...buildSemester('hda', 'winter', 2026),
    id: 'sem1',
    createdAt: new Date().toISOString(),
  }
  const module = newModule(semester.id, {
    name: 'Analysis 1',
    code: 'ANA1',
    schedule: [newSlot({ weekday: 1, start: '08:15', end: '09:45', room: 'D14/0.04' })],
  })
  db.onboarded = true
  db.profile.name = 'Soufian'
  db.activeSemesterId = semester.id
  db.semesters.push(semester)
  db.modules.push(module)
  db.settings.ai = {
    ...db.settings.ai,
    enabled: true,
    provider: 'custom',
    baseUrl: `${mock.url}/v1`,
    model: 'mock-model',
  }
  writeFileSync(path.join(dataDir, 'db.json'), JSON.stringify(db))

  const { app, page } = await launchApp(dataDir)
  page.on('console', (m) => m.type() === 'error' && console.log('renderer:', m.text()))
  page.on('pageerror', (e) => console.log('pageerror:', e.message))
  await page.setViewportSize({ width: 1440, height: 900 })
  await expect(page.getByRole('heading', { name: /Soufian/ })).toBeVisible()

  // ---- Calendar subscription ----
  await page.locator('.sidebar .nav-item', { hasText: 'Einstellungen' }).click()
  await page.locator('.settings-nav .nav-item', { hasText: 'Moodle' }).click()
  await page.getByPlaceholder('Name, z. B. Moodle').fill('Moodle h_da')
  await page
    .getByPlaceholder('https://… oder webcal://…')
    .fill(`${mock.url}/export.ics?userid=1&authtoken=geheim`)
  await page.getByRole('button', { name: 'Abonnieren' }).click()
  await expect(page.getByText(/2 Termine/)).toBeVisible()
  await expect(page.getByText('authtoken')).toHaveCount(0)
  await shot(page, '20-subscription')

  // Events show up in the calendar (list) and the exam is assigned to the module
  await page.locator('.sidebar .nav-item', { hasText: 'Kalender' }).click()
  await page.getByRole('button', { name: 'Monat' }).click()
  if (
    !(await page
      .locator('.cal-chip', { hasText: 'Klausur Analysis 1' })
      .isVisible()
      .catch(() => false))
  ) {
    await page.getByRole('button', { name: 'Weiter' }).click()
  }
  if (
    !(await page
      .locator('.cal-chip', { hasText: 'Klausur Analysis 1' })
      .isVisible()
      .catch(() => false))
  ) {
    await page.getByRole('button', { name: 'Zurück' }).click()
  }
  await expect(page.locator('.cal-chip', { hasText: 'Klausur Analysis 1' })).toBeVisible()
  await shot(page, '21-calendar-month')
  await page.getByRole('button', { name: 'Woche' }).click()
  if (
    !(await page
      .locator('.cal-event', { hasText: 'Analysis 1' })
      .first()
      .isVisible()
      .catch(() => false))
  ) {
    await page.getByRole('button', { name: 'Weiter' }).click()
  }
  if (
    !(await page
      .locator('.cal-event', { hasText: 'Analysis 1' })
      .first()
      .isVisible()
      .catch(() => false))
  ) {
    await page.getByRole('button', { name: 'Zurück' }).click()
  }
  await expect(page.locator('.cal-event', { hasText: 'Analysis 1' }).first()).toBeVisible()
  await shot(page, '22-calendar-week')

  // ---- Lecture folder with slides ----
  await page.locator('.sidebar .tree-row', { hasText: 'Analysis 1' }).click()
  await page.getByRole('tab', { name: /Termine/ }).click()
  await page.locator('.session-row').first().click()
  await page.evaluate(
    async (bytes) => {
      const api = (window as unknown as { studyApi: Api }).studyApi
      const data = await api.loadDb()
      const folder = data.folders[0]
      const file = new File([new Uint8Array(bytes)], 'Folien_Grenzwerte.pdf', {
        type: 'application/pdf',
      })
      await api.addFiles({ moduleId: folder.moduleId, folderId: folder.id }, [file])
    },
    [...samplePdf(['Grenzwerte von Folgen', 'Monotonie und Beschraenktheit'])],
  )
  await page.reload()
  await expect(page.locator('.item-row', { hasText: 'Folien Grenzwerte' })).toBeVisible()

  // ---- Summary ----
  await page.getByRole('button', { name: 'Zusammenfassen' }).click()
  await expect(page.locator('.pane')).toHaveCount(2)
  await expect(page.locator('.note-prose h2', { hasText: 'Überblick' })).toBeVisible()
  await expect(page.locator('.note-prose [data-type="inline-math"]').first()).toBeVisible()
  const summaryRequest = mock.requests.find((r) => r.path.endsWith('/chat/completions'))!
  expect(summaryRequest.body).toContain('Grenzwerte von Folgen')
  await shot(page, '23-summary')

  // ---- Chat with the open panes as context ----
  await page.locator('.pane-header button[aria-label="Bereich schließen"]').last().click()
  await page.locator('.sidebar .nav-item', { hasText: 'KI-Chat' }).click({ modifiers: [mod] })
  await expect(page.locator('.chat')).toBeVisible()
  await page.locator('.chat-input').fill('Was ist das Thema der Vorlesung?')
  await page.keyboard.press('Enter')
  await expect(page.locator('.chat-markdown strong', { hasText: 'Grenzwerte' })).toBeVisible()
  await expect(page.locator('.chat-markdown .katex').first()).toBeVisible()
  const chatRequest = mock.requests.filter((r) => r.path.endsWith('/chat/completions')).at(-1)!
  expect(chatRequest.body).toContain('Was ist das Thema der Vorlesung?')
  await shot(page, '24-chat')

  await app.close()
  await mock.close()
})
