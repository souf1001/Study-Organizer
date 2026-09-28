// Schein-Server für Tests: OpenAI-kompatible KI-Schnittstelle (mit Streaming) und ein iCal-Kalender.
import http from 'node:http'
import type { AddressInfo } from 'node:net'

export interface MockServer {
  url: string
  requests: { path: string; body: string }[]
  close: () => Promise<void>
}

const ICS = `BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//Moodle//NONSGML Moodle//EN
BEGIN:VEVENT
UID:42@moodle
SUMMARY:Klausur Analysis 1
DTSTART:20261015T080000Z
DTEND:20261015T100000Z
CATEGORIES:ANA1
END:VEVENT
BEGIN:VEVENT
UID:43@moodle
SUMMARY:Übungsblatt 2 ist fällig
DTSTART:20261014T215900Z
DTEND:20261014T215900Z
CATEGORIES:ANA1
END:VEVENT
END:VCALENDAR`

const ANSWER = ['## Überblick\n', 'Es ging um **Grenzwerte** von Folgen.\n\n', '## Kernaussagen\n', '- Eine Folge konvergiert gegen $a$, wenn $|a_n - a| < \\varepsilon$.\n', '- Beschränkte monotone Folgen konvergieren.\n']

export async function startMockServer(): Promise<MockServer> {
  const requests: MockServer['requests'] = []
  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', (chunk) => (body += chunk))
    req.on('end', () => {
      const path = new URL(req.url ?? '/', 'http://localhost').pathname
      requests.push({ path, body })
      if (path.endsWith('/models')) {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        return res.end(JSON.stringify({ object: 'list', data: [{ id: 'mock-model', object: 'model', created: 0, owned_by: 'test' }] }))
      }
      if (path.endsWith('/chat/completions')) {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' })
        for (const content of ANSWER) {
          const chunk = { id: 'c1', object: 'chat.completion.chunk', created: 0, model: 'mock-model', choices: [{ index: 0, delta: { content }, finish_reason: null }] }
          res.write(`data: ${JSON.stringify(chunk)}\n\n`)
        }
        res.write('data: [DONE]\n\n')
        return res.end()
      }
      if (path.endsWith('.ics')) {
        res.writeHead(200, { 'Content-Type': 'text/calendar; charset=utf-8' })
        return res.end(ICS)
      }
      res.writeHead(404)
      res.end()
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  }
}
