// Access to the data layer. The desktop app provides it through the preload script; on Android
// (and in a plain browser) the backend runs inside the page itself.
import type { Api } from '@shared/api'

declare global {
  interface Window {
    studyApi?: Api
  }
}

/** Available after `initApi()`; main.tsx calls it before the first render */
export let api: Api = window.studyApi as Api

export async function initApi(): Promise<void> {
  if (window.studyApi) return
  // Loaded on demand so the desktop app never runs any of the mobile code
  const { createMobileApi } = await import('../mobile/mobile-api')
  api = await createMobileApi()
  window.studyApi = api
}
