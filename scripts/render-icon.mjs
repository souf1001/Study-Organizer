// Rendert build/icon.svg zu build/icon.png (1024 × 1024). electron-builder erzeugt daraus .icns und .ico.
import { readFileSync } from 'node:fs'
import { chromium } from '@playwright/test'

const svg = readFileSync('build/icon.svg', 'utf8')
// Vorinstalliertes Chromium nutzen, falls vorhanden (z. B. in CI-Containern)
const executablePath = process.env.CHROMIUM_PATH
const browser = await chromium.launch(executablePath ? { executablePath } : {})
const page = await browser.newPage({ viewport: { width: 1024, height: 1024 } })
await page.setContent(`<body style="margin:0;background:transparent">${svg}</body>`)
await page.locator('svg').screenshot({ path: 'build/icon.png', omitBackground: true })
await browser.close()
console.log('build/icon.png erstellt')
