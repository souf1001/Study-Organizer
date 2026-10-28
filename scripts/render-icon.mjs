// Renders build/icon.svg to build/icon.png (1024 x 1024). electron-builder derives .icns and .ico from it.
import { readFileSync } from 'node:fs'
import { chromium } from '@playwright/test'

const svg = readFileSync('build/icon.svg', 'utf8')
// Use a preinstalled Chromium if available (e.g. in CI containers)
const executablePath = process.env.CHROMIUM_PATH
const browser = await chromium.launch(executablePath ? { executablePath } : {})
const page = await browser.newPage({ viewport: { width: 1024, height: 1024 } })
await page.setContent(`<body style="margin:0;background:transparent">${svg}</body>`)
await page.locator('svg').screenshot({ path: 'build/icon.png', omitBackground: true })
await browser.close()
console.log('Created build/icon.png')
