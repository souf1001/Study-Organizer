// Zugriff auf die Datenhaltung. In der Desktop-App kommt die Umsetzung aus dem Preload-Skript.
import type { Api } from '@shared/api'

declare global {
  interface Window {
    studyApi?: Api
  }
}

if (!window.studyApi) throw new Error('Study Organizer muss in der Desktop-App gestartet werden.')

export const api: Api = window.studyApi
