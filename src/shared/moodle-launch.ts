// Moodle sign-in through the university login page (SSO/Shibboleth), the same way the official
// Moodle app does it: we open Moodle's launch page, the user signs in, and Moodle finally
// redirects to moodlemobile://token=<base64>. The app intercepts that redirect.
import { md5Hex } from './md5'

/** Random value that ties Moodle's answer to our request */
export function createPassport(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(8))
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
}

export function moodleLaunchUrl(site: string, passport: string): string {
  return `${site}/admin/tool/mobile/launch.php?service=moodle_mobile_app&passport=${passport}&urlscheme=moodlemobile`
}

export const MOODLE_LAUNCH_SCHEME = 'moodlemobile://'

/**
 * Reads the token from the redirect and checks its signature md5(wwwroot + passport).
 * Returns null for addresses that are not a token redirect.
 */
export function parseLaunchToken(url: string, site: string, passport: string): string | null {
  const match = /^moodlemobile:\/\/token=([A-Za-z0-9+/=_-]+)/.exec(url)
  if (!match) return null
  const base64 = match[1].replace(/-/g, '+').replace(/_/g, '/')
  const [signature, token] = atob(base64).split(':::')
  const siteVariants = [site, site.replace(/^https:/, 'http:')]
  if (!token || !siteVariants.some((variant) => md5Hex(variant + passport) === signature)) {
    throw new Error('Die Antwort von Moodle konnte nicht bestätigt werden.')
  }
  return token
}
