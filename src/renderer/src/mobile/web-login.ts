// Bridge to the native WebLogin plugin (android/.../WebLoginPlugin.java).
//
// It shows a full-screen in-app browser for university logins that need a real browser
// (Moodle SSO/Shibboleth, TUCaN). Cookies stay inside the app. The page can either finish by
// redirecting to a custom scheme (Moodle's moodlemobile://token=…) or by downloading files
// (TUCaN's calendar export), which the plugin captures and hands back to us.
import { registerPlugin } from '@capacitor/core'

export interface WebLoginOptions {
  url: string
  /** Title shown in the browser's toolbar */
  title: string
  /** Short instructions shown under the title */
  hint?: string
  /** Finish as soon as the page navigates to an address starting with this prefix */
  interceptPrefix?: string
  /** Capture downloads instead of finishing; the user taps "Fertig" when done */
  captureDownloads?: boolean
}

export interface CapturedDownload {
  fileName: string
  mimeType: string
  /** Base64 encoded file content */
  data: string
}

export interface WebLoginResult {
  /** The intercepted address (only with `interceptPrefix`) */
  redirectUrl?: string
  /** Captured files (only with `captureDownloads`) */
  downloads: CapturedDownload[]
}

interface WebLoginPlugin {
  open(options: WebLoginOptions): Promise<WebLoginResult>
}

export const WebLogin = registerPlugin<WebLoginPlugin>('WebLogin')
