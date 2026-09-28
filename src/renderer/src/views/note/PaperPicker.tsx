import type { PaperColorId, PaperId } from '@shared/types'
import { PAPER_COLORS, PAPERS } from './paper'
import './paper.css'

export function PaperPicker({ value, onChange }: { value: PaperId; onChange: (paper: PaperId) => void }) {
  return (
    <div className="paper-picker" role="radiogroup" aria-label="Papier">
      {PAPERS.map((p) => (
        <button key={p.id} type="button" role="radio" aria-checked={p.id === value} className="paper-option" onClick={() => onChange(p.id)}>
          <span className={`paper-thumb paper paper-${p.id}`} data-tone="light" />
          <span className="small">{p.label}</span>
        </button>
      ))}
    </div>
  )
}

export function PaperColorPicker({ value, onChange }: { value: PaperColorId; onChange: (color: PaperColorId) => void }) {
  return (
    <div className="paper-colors" role="radiogroup" aria-label="Papierfarbe">
      {PAPER_COLORS.map((c) => (
        <button
          key={c.id}
          type="button"
          role="radio"
          title={c.label}
          aria-label={c.label}
          aria-checked={c.id === value}
          className={`paper-color paper-color-${c.id}`}
          onClick={() => onChange(c.id)}
        />
      ))}
    </div>
  )
}
