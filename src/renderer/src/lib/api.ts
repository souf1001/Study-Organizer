// Access to the data layer. In the desktop app the implementation comes from the preload script.
import type { Api } from '@shared/api'

declare global {
  interface Window {
    studyApi?: Api
  }
}

if (!window.studyApi) throw new Error('Study Organizer muss in der Desktop-App gestartet werden.')

export const api: Api = window.studyApi
