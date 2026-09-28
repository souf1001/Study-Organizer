// Papierarten, Papierfarben und Schriften für Notizen.
import type { FontId, PaperColorId, PaperId } from '@shared/types'

export const PAPERS: { id: PaperId; label: string }[] = [
  { id: 'plain', label: 'Blanko' },
  { id: 'lined', label: 'Liniert' },
  { id: 'college', label: 'Liniert mit Rand' },
  { id: 'grid', label: 'Kariert' },
  { id: 'dots', label: 'Punktraster' },
  { id: 'millimeter', label: 'Millimeter' },
  { id: 'cornell', label: 'Cornell' },
]

export const PAPER_COLORS: { id: PaperColorId; label: string; tone: 'light' | 'dark' | 'auto' }[] = [
  { id: 'auto', label: 'Wie App', tone: 'auto' },
  { id: 'white', label: 'Weiß', tone: 'light' },
  { id: 'cream', label: 'Creme', tone: 'light' },
  { id: 'gray', label: 'Grau', tone: 'light' },
  { id: 'dark', label: 'Dunkel', tone: 'dark' },
]

export const FONTS: { id: FontId; label: string; css: string }[] = [
  { id: 'inter', label: 'Sans (Inter)', css: 'var(--font-ui)' },
  { id: 'serif', label: 'Serif (Source Serif)', css: 'var(--font-serif)' },
  { id: 'literata', label: 'Buch (Literata)', css: 'var(--font-literata)' },
  { id: 'mono', label: 'Mono (JetBrains Mono)', css: 'var(--font-mono)' },
  { id: 'hand', label: 'Handschrift (Caveat)', css: 'var(--font-hand)' },
  { id: 'atkinson', label: 'Gut lesbar (Atkinson)', css: 'var(--font-atkinson)' },
]

export const fontCss = (id: FontId): string => FONTS.find((f) => f.id === id)?.css ?? 'var(--font-ui)'

/** Farbwelt des Papiers: 'auto' folgt dem App-Theme */
export function paperTone(color: PaperColorId): 'light' | 'dark' {
  const tone = PAPER_COLORS.find((c) => c.id === color)?.tone ?? 'auto'
  if (tone !== 'auto') return tone
  return document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light'
}

/** Stiftfarben – 'ink' ist Schwarz auf hellem und Weiß auf dunklem Papier */
export const PEN_COLORS = ['ink', '#2f6fdf', '#d9423a', '#2e9a5b', '#e08a1e', '#8a4fd8']
export const MARKER_COLORS = ['#ffd84d', '#7ee07e', '#7cc8ff', '#ff9ecf', '#ffb36b']
export const PEN_SIZES = [2, 3.5, 6]
