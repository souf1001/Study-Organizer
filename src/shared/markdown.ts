/**
 * Hilfsfunktionen zur Validierung und Reparatur von Markdown (z. B. bei gekürzten KI-Antworten).
 */
export function repairMarkdown(md: string): string {
  let repaired = md.trim()
  const codeMatches = repaired.match(/```/g) || []
  if (codeMatches.length % 2 !== 0) repaired += '\n```'
  const mathMatches = repaired.match(/\$\$/g) || []
  if (mathMatches.length % 2 !== 0) repaired += '\n$$'

  // Text außerhalb von Code-Blöcken für Inline-Prüfungen
  const outsideCode = repaired.replace(/```[\s\S]*?```/g, '')

  // Inline-Code (einzelne Backticks)
  const inlineTicks = (outsideCode.match(/(?<!`)`(?!`)/g) || []).length
  if (inlineTicks % 2 !== 0) repaired += '`'

  // Inline-Math ($)
  const outsideMath = outsideCode.replace(/\$\$[\s\S]*?\$\$/g, '')
  const inlineDollars = (outsideMath.match(/(?<!\\)\$/g) || []).length
  if (inlineDollars % 2 !== 0) repaired += '$'

  // Fett-Formatierung (**)
  const boldMatches = (outsideCode.match(/\*\*/g) || []).length
  if (boldMatches % 2 !== 0) repaired += '**'

  // Unvollständige Links [Text](URL
  if (/\[[^\]]*\]\([^)]*$/.test(repaired)) repaired += ')'

  return repaired
}
