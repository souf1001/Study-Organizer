// Zugriff auf die Datenhaltung: in der Desktop-App aus dem Preload-Skript, im Browser per HTTP.
import type { Api } from '@shared/api'
import { webApi } from './web-api'

declare global {
  interface Window {
    studyApi?: Api
  }
}

export const api: Api = window.studyApi ?? webApi

export const isWeb = api.platform === 'web'

/** Beschriftung für „Datei mit anderem Programm öffnen“ */
export const openFileLabel = isWeb ? 'Herunterladen' : 'Mit Standard-App öffnen'
