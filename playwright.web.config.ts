// End-to-End-Test der Web-Version im Browser. Vorher: npm run web:build
import { mkdtempSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { defineConfig } from '@playwright/test'

const port = 3457

export default defineConfig({
  testDir: 'tests/e2e-web',
  timeout: 120_000,
  workers: 1,
  reporter: 'list',
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    viewport: { width: 1440, height: 900 },
    // Vorinstalliertes Chromium nutzen, falls angegeben (z. B. in Containern)
    launchOptions: process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {},
  },
  webServer: {
    command: 'node out/server/index.js',
    url: `http://127.0.0.1:${port}/api/auth/status`,
    reuseExistingServer: false,
    env: {
      NODE_ENV: 'production',
      PORT: String(port),
      DATA_DIR: mkdtempSync(path.join(os.tmpdir(), 'web-e2e-')),
      SECRET_KEY: 'a'.repeat(64),
      COOKIE_SECURE: 'false',
      USER_QUOTA_MB: '50',
    },
  },
})
