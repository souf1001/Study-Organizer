/**
 * Closes unbalanced Markdown constructs (code fences, math, inline code, bold, links),
 * e.g. in AI answers that were cut off.
 */
export function repairMarkdown(md: string): string {
  let repaired = md.trim()
  const codeMatches = repaired.match(/```/g) || []
  if (codeMatches.length % 2 !== 0) repaired += '\n```'
  const mathMatches = repaired.match(/\$\$/g) || []
  if (mathMatches.length % 2 !== 0) repaired += '\n$$'

  // Inline checks only look at text outside code blocks
  const outsideCode = repaired.replace(/```[\s\S]*?```/g, '')

  // Inline code (single backticks)
  const inlineTicks = (outsideCode.match(/(?<!`)`(?!`)/g) || []).length
  if (inlineTicks % 2 !== 0) repaired += '`'

  // Inline math ($)
  const outsideMath = outsideCode.replace(/\$\$[\s\S]*?\$\$/g, '')
  const inlineDollars = (outsideMath.match(/(?<!\\)\$/g) || []).length
  if (inlineDollars % 2 !== 0) repaired += '$'

  // Bold (**)
  const boldMatches = (outsideCode.match(/\*\*/g) || []).length
  if (boldMatches % 2 !== 0) repaired += '**'

  // Unfinished link: [text](url
  if (/\[[^\]]*\]\([^)]*$/.test(repaired)) repaired += ')'

  return repaired
}
