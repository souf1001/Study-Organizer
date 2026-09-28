// Schutz vor Zugriffen auf interne Netze (SSRF): Der Server ruft im Auftrag der Nutzer fremde
// Adressen ab (Kalender-Abos, Moodle, KI-Anbieter). Private, lokale und Metadaten-Adressen sind tabu –
// auch nach Weiterleitungen und bei DNS-Namen, die auf interne IPs zeigen.
import { lookup, type LookupAddress } from 'node:dns'
import { BlockList, isIP } from 'node:net'
import { Agent, fetch as undiciFetch } from 'undici'
import { config } from './config'

const blocked = new BlockList()
for (const [net, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const) {
  blocked.addSubnet(net, prefix, 'ipv4')
}
for (const [net, prefix] of [
  ['::', 128],
  ['::1', 128],
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8],
] as const) {
  blocked.addSubnet(net, prefix, 'ipv6')
}

export function isBlockedAddress(address: string): boolean {
  const family = isIP(address)
  if (family === 4) return blocked.check(address, 'ipv4')
  if (family === 6) {
    // IPv4 in IPv6 (::ffff:127.0.0.1) wie IPv4 behandeln
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address)
    return mapped ? blocked.check(mapped[1], 'ipv4') : blocked.check(address, 'ipv6')
  }
  return true
}

const agent = new Agent({
  connect: {
    lookup(hostname, options, callback) {
      lookup(hostname, { ...options, all: true }, (error, addresses: LookupAddress[]) => {
        if (error) return callback(error, '', 4)
        const bad = addresses.find((a) => isBlockedAddress(a.address))
        if (bad || addresses.length === 0) return callback(new Error(`Adresse nicht erlaubt: ${hostname}`), '', 4)
        if ((options as { all?: boolean }).all) return (callback as unknown as (e: null, a: LookupAddress[]) => void)(null, addresses)
        callback(null, addresses[0].address, addresses[0].family)
      })
    },
  },
})

export function assertAllowedUrl(url: URL): void {
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('Nur http(s)-Adressen sind erlaubt.')
  const host = url.hostname.replace(/^\[|\]$/g, '')
  if (host === 'localhost' || host.endsWith('.localhost') || (isIP(host) && isBlockedAddress(host))) {
    throw new Error('Interne Adressen sind auf dem Server nicht erlaubt.')
  }
}

const MAX_REDIRECTS = 5

/** fetch mit SSRF-Schutz; Weiterleitungen werden einzeln geprüft */
export const safeFetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
  if (config.allowPrivateNetwork) return fetch(input, init)
  let url = new URL(input instanceof Request ? input.url : String(input))
  let request = init
  for (let i = 0; i <= MAX_REDIRECTS; i++) {
    assertAllowedUrl(url)
    const response = await undiciFetch(url, { ...(request as object), redirect: 'manual', dispatcher: agent } as Parameters<typeof undiciFetch>[1])
    const location = response.headers.get('location')
    if (response.status >= 300 && response.status < 400 && location) {
      url = new URL(location, url)
      // Nach 303 bzw. bei POST-Weiterleitung wie Browser: GET ohne Body
      if (response.status === 303 || ((response.status === 301 || response.status === 302) && request.method === 'POST')) {
        request = { ...request, method: 'GET', body: undefined }
      }
      continue
    }
    return response as unknown as Response
  }
  throw new Error('Zu viele Weiterleitungen.')
}) as typeof fetch
