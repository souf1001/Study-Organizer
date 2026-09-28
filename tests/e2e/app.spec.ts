// Durchläuft die wichtigsten Abläufe in der echten Electron-App.
/// <reference lib="dom" />
import path from 'node:path'
import type { Api } from '../../src/shared/api'
import { expect, test, type Page } from '@playwright/test'
import { launchApp, samplePdf } from './helpers'

const shots = process.env.SCREENSHOT_DIR
const shot = async (page: Page, name: string) => {
  if (shots) await page.screenshot({ path: path.join(shots, `${name}.png`) })
}

test('Einrichtung, Modul, Vorlesungsordner, Notiz, PDF, Split-Screen, Kalender', async () => {
  const { app, page } = await launchApp()
  await page.setViewportSize({ width: 1440, height: 900 })

  // ---- Ersteinrichtung ----
  await expect(page.getByText('Willkommen beim Study Organizer')).toBeVisible()
  await shot(page, '01-welcome')
  await page.getByRole('button', { name: 'Los geht’s' }).click()
  await page.getByPlaceholder('z. B. Soufian').fill('Soufian')
  await page.getByRole('button', { name: 'Weiter', exact: true }).click()
  await page.getByPlaceholder('Name der Hochschule').fill('Hochschule Darmstadt (h_da)')
  await page.getByPlaceholder('z. B. Informatik').fill('Informatik')
  await shot(page, '02-study')
  await page.getByRole('button', { name: 'Weiter', exact: true }).click()
  await expect(page.getByText('Dein aktuelles Semester')).toBeVisible()
  await shot(page, '03-semester')
  await page.getByRole('button', { name: 'Weiter', exact: true }).click()

  await page.getByPlaceholder('Modulname, z. B. Programmieren 1').fill('Analysis 1')
  await page.getByPlaceholder('Kürzel').first().fill('ANA1')
  await page.getByRole('button', { name: /Termine/ }).first().click()
  await page.getByRole('button', { name: 'Termin hinzufügen' }).click()
  await page.getByPlaceholder('Raum, z. B. D14/0.04').first().fill('D14/0.04')
  await page.getByRole('button', { name: 'Weiteres Modul' }).click()
  await page.getByPlaceholder('Modulname, z. B. Programmieren 1').nth(1).fill('Programmieren 2')
  await shot(page, '04-modules')
  await page.getByRole('button', { name: 'Weiter', exact: true }).click()
  await shot(page, '05-appearance')
  await page.getByRole('button', { name: 'Weiter', exact: true }).click()
  await shot(page, '06-ai')
  await page.getByRole('button', { name: 'Fertig' }).click()

  // ---- Startseite ----
  await expect(page.getByRole('heading', { name: /Soufian/ })).toBeVisible()
  await shot(page, '07-home')

  // ---- Modul & Termine ----
  await page.locator('.sidebar .tree-row', { hasText: 'Analysis 1' }).click()
  await expect(page.getByRole('heading', { name: 'Analysis 1' })).toBeVisible()
  await shot(page, '08-module')
  await page.getByRole('tab', { name: /Termine/ }).click()
  await shot(page, '09-sessions')
  await page.locator('.session-row').first().click()
  await expect(page.locator('.page-title')).toContainText('Vorlesung 1')
  await shot(page, '10-folder-empty')

  // ---- PDF hochladen (wie per Drag & Drop) ----
  await page.evaluate(async (bytes) => {
    const api = (window as unknown as { studyApi: Api }).studyApi
    const db = await api.loadDb()
    const folder = db.folders[0]
    const file = new File([new Uint8Array(bytes)], 'Folien_Kapitel_1.pdf', { type: 'application/pdf' })
    await api.addFiles({ moduleId: folder.moduleId, folderId: folder.id }, [file])
  }, [...samplePdf(['Kapitel 1: Grenzwerte', 'Folgen und Reihen', 'Konvergenz'])])
  // Datenbank neu laden, indem wir die Ansicht wechseln
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  await page.reload()
  await expect(page.locator('.item-row', { hasText: 'Folien Kapitel 1' })).toBeVisible()

  // ---- Notiz anlegen, schreiben, zeichnen ----
  await page.getByRole('button', { name: 'Neue Notiz' }).first().click()
  await page.locator('.note-title').fill('Grenzwerte – Mitschrift')
  await page.locator('.note-prose').click()
  await page.keyboard.type('Eine Folge konvergiert, wenn ')
  await page.keyboard.press('Enter')
  await page.keyboard.type('/')
  await expect(page.locator('.slash-menu')).toBeVisible()
  await shot(page, '11-slash-menu')
  await page.keyboard.type('check')
  await page.keyboard.press('Enter')
  await page.keyboard.type('Übungsblatt 1 rechnen')
  await page.getByRole('button', { name: 'Zeichnen' }).click()
  const box = (await page.locator('.ink-layer').boundingBox())!
  await page.mouse.move(box.x + 120, box.y + 400)
  await page.mouse.down()
  for (let i = 0; i < 30; i++) await page.mouse.move(box.x + 120 + i * 8, box.y + 400 + Math.sin(i / 3) * 25)
  await page.mouse.up()
  await expect(page.locator('.ink-layer path')).toHaveCount(1)
  await shot(page, '12-note')

  // ---- Split-Screen: PDF neben der Notiz ----
  await page.locator('.sidebar .tree-row', { hasText: 'Analysis 1' }).locator('.chevron').click()
  await page.locator('.sidebar .tree-row', { hasText: 'Vorlesung 1' }).locator('.chevron').click()
  await page.locator('.sidebar .tree-row', { hasText: 'Folien Kapitel 1' }).click({ modifiers: [process.platform === 'darwin' ? 'Meta' : 'Control'] })
  await expect(page.locator('.pane')).toHaveCount(2)
  await expect(page.locator('.pdf-page canvas').first()).toBeVisible()
  await page.waitForTimeout(800)
  await shot(page, '13-split')

  // ---- Kalender ----
  await page.locator('.sidebar .nav-item', { hasText: 'Kalender' }).click({ modifiers: [process.platform === 'darwin' ? 'Meta' : 'Control'] })
  await expect(page.locator('.pane')).toHaveCount(3)
  await shot(page, '14-three-panes')
  await page.locator('.pane-header button[aria-label="Bereich schließen"]').first().click()
  await page.locator('.pane-header button[aria-label="Bereich schließen"]').first().click()
  await page.locator('.sidebar .nav-item', { hasText: 'Kalender' }).click()
  await expect(page.locator('.cal-toolbar')).toBeVisible()
  await shot(page, '15-calendar')

  // ---- Einstellungen & Dunkelmodus ----
  await page.locator('.sidebar .nav-item', { hasText: 'Einstellungen' }).click()
  await page.locator('.settings-nav .nav-item', { hasText: 'KI' }).click()
  await shot(page, '16-settings-ai')
  await page.locator('.settings-nav .nav-item', { hasText: 'Moodle' }).click()
  await shot(page, '17-settings-integrations')
  await page.locator('.settings-nav .nav-item', { hasText: 'Darstellung' }).click()
  await page.getByRole('button', { name: 'Dunkel' }).click()
  await page.locator('.sidebar .nav-item', { hasText: 'Heute' }).click()
  await shot(page, '18-home-dark')

  // ---- Suche ----
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+K' : 'Control+K')
  await page.keyboard.type('Grenz')
  await expect(page.locator('.palette-item').first()).toBeVisible()
  await shot(page, '19-palette')
  await page.keyboard.press('Escape')

  await app.close()
})
