// Web-Version: Registrieren, einrichten, Folien hochladen, Notiz schreiben, Split-Screen.
import path from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { samplePdf } from '../e2e/helpers'

const shots = process.env.SCREENSHOT_DIR
const shot = async (page: Page, name: string) => {
  if (shots) await page.screenshot({ path: path.join(shots, `${name}.png`) })
}

test('Konto anlegen und die App im Browser nutzen', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByRole('heading', { name: 'Study Organizer' })).toBeVisible()
  await shot(page, 'web-01-login')

  await page.getByRole('button', { name: 'Registrieren' }).click()
  await page.getByLabel('Vorname').fill('Soufian')
  await page.getByLabel('E-Mail').fill('soufian@h-da.de')
  await page.getByLabel('Passwort').fill('ein-sicheres-passwort')
  await page.getByRole('button', { name: 'Konto erstellen' }).click()

  // Einrichtung
  await expect(page.getByText('Willkommen beim Study Organizer')).toBeVisible()
  await expect(page.getByText('Deine Daten liegen geschützt in deinem Konto.')).toBeVisible()
  await page.getByRole('button', { name: 'Los geht’s' }).click()
  await page.getByPlaceholder('z. B. Soufian').fill('Soufian')
  await page.getByRole('button', { name: 'Weiter', exact: true }).click()
  await page.getByPlaceholder('Name der Hochschule').fill('Hochschule Darmstadt (h_da)')
  await page.getByPlaceholder('z. B. Informatik').fill('Informatik')
  await page.getByRole('button', { name: 'Weiter', exact: true }).click()
  await page.getByRole('button', { name: 'Weiter', exact: true }).click()
  await page.getByPlaceholder('Modulname, z. B. Programmieren 1').fill('Datenbanken')
  await page.getByRole('button', { name: /Termine/ }).first().click()
  await page.getByRole('button', { name: 'Termin hinzufügen' }).click()
  await page.getByPlaceholder('Raum, z. B. D14/0.04').first().fill('D19/2.12')
  await page.getByRole('button', { name: 'Weiter', exact: true }).click()
  await page.getByRole('button', { name: 'Weiter', exact: true }).click()
  await page.getByRole('button', { name: 'Fertig' }).click()
  await expect(page.getByRole('heading', { name: /Soufian/ })).toBeVisible()

  // Vorlesungsordner anlegen und Folien hochladen
  await page.locator('.sidebar .tree-row', { hasText: 'Datenbanken' }).click()
  await page.getByRole('tab', { name: /Termine/ }).click()
  await page.locator('.session-row').first().click()
  const chooser = page.waitForEvent('filechooser')
  await page.getByRole('button', { name: 'Dateien hochladen' }).click()
  await (await chooser).setFiles({ name: 'SQL_Grundlagen.pdf', mimeType: 'application/pdf', buffer: samplePdf(['SQL Grundlagen', 'SELECT und JOIN']) })
  await expect(page.locator('.item-row', { hasText: 'SQL Grundlagen' })).toBeVisible()

  // Notiz schreiben und neben den Folien öffnen
  await page.getByRole('button', { name: 'Neue Notiz' }).first().click()
  await page.locator('.note-title').fill('Mitschrift SQL')
  await page.locator('.note-prose').click()
  await page.keyboard.type('SELECT wählt Spalten aus, JOIN verbindet Tabellen.')
  await page.locator('.sidebar .tree-row', { hasText: 'Datenbanken' }).locator('.chevron').click()
  await page.locator('.sidebar .tree-row', { hasText: 'Vorlesung 1' }).locator('.chevron').click()
  await page.locator('.sidebar .tree-row', { hasText: 'SQL Grundlagen' }).click({ modifiers: ['Control'] })
  await expect(page.locator('.pdf-page canvas').first()).toBeVisible()
  await page.waitForTimeout(800)
  await shot(page, 'web-02-split')

  // Nach dem Neuladen ist alles noch da (serverseitig gespeichert)
  await page.waitForTimeout(700)
  await page.reload()
  await expect(page.locator('.note-prose')).toContainText('JOIN verbindet Tabellen')

  // Konto & Speicher
  await page.locator('.sidebar .nav-item', { hasText: 'Einstellungen' }).click()
  await page.locator('.settings-nav .nav-item', { hasText: 'Konto & Speicher' }).click()
  await expect(page.getByText('soufian@h-da.de')).toBeVisible()
  await expect(page.getByText(/von 50 MB belegt/)).toBeVisible()
  await shot(page, 'web-03-account')

  // Export: ZIP mit allen Daten
  await page.locator('.settings-nav .nav-item', { hasText: 'Export' }).click()
  const download = page.waitForEvent('download')
  await page.getByRole('button', { name: 'Export herunterladen' }).click()
  expect((await download).suggestedFilename()).toMatch(/^study-organizer-\d{4}-\d{2}-\d{2}\.zip$/)

  // Abmelden führt zurück zur Anmeldung
  await page.locator('.settings-nav .nav-item', { hasText: 'Konto & Speicher' }).click()
  await page.getByRole('button', { name: 'Abmelden' }).click()
  await expect(page.getByRole('button', { name: 'Anmelden' }).last()).toBeVisible()

  // Falsches Passwort: Fehlermeldung, Eingaben bleiben stehen
  await page.getByLabel('E-Mail').fill('soufian@h-da.de')
  await page.getByLabel('Passwort').fill('falsches-passwort')
  await page.getByRole('button', { name: 'Anmelden' }).last().click()
  await expect(page.getByText('E-Mail oder Passwort ist falsch.')).toBeVisible()
  await expect(page.getByLabel('E-Mail')).toHaveValue('soufian@h-da.de')

  // Richtiges Passwort: die zuletzt geöffnete Notiz ist wieder da
  await page.getByLabel('Passwort').fill('ein-sicheres-passwort')
  await page.getByRole('button', { name: 'Anmelden' }).last().click()
  await expect(page.locator('.note-prose')).toContainText('JOIN verbindet Tabellen')
})
