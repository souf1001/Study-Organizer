// Kontext- und Dropdown-Menüs. Es ist immer höchstens ein Menü offen.
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { create } from 'zustand'

export type MenuEntry =
  | { label: string; icon?: ReactNode; onClick: () => void; danger?: boolean; shortcut?: string; disabled?: boolean }
  | { separator: true }
  | { heading: string }

interface MenuState {
  position: { x: number; y: number } | null
  entries: MenuEntry[]
  open: (position: { x: number; y: number }, entries: MenuEntry[]) => void
  close: () => void
}

const useMenuStore = create<MenuState>((set) => ({
  position: null,
  entries: [],
  open: (position, entries) => set({ position, entries }),
  close: () => set({ position: null, entries: [] }),
}))

/** Öffnet ein Menü an der Mausposition oder unter einem Element */
export function showMenu(anchor: { clientX: number; clientY: number } | HTMLElement, entries: MenuEntry[]): void {
  if (anchor instanceof HTMLElement) {
    const rect = anchor.getBoundingClientRect()
    useMenuStore.getState().open({ x: rect.left, y: rect.bottom + 4 }, entries)
  } else {
    useMenuStore.getState().open({ x: anchor.clientX, y: anchor.clientY }, entries)
  }
}

export function MenuHost() {
  const { position, entries, close } = useMenuStore()
  const ref = useRef<HTMLDivElement>(null)
  const [place, setPlace] = useState({ x: 0, y: 0 })

  useLayoutEffect(() => {
    if (!position || !ref.current) return
    const { width, height } = ref.current.getBoundingClientRect()
    setPlace({
      x: Math.min(position.x, window.innerWidth - width - 8),
      y: position.y + height > window.innerHeight - 8 ? Math.max(8, position.y - height) : position.y,
    })
    ref.current.querySelector<HTMLButtonElement>('.menu-item')?.focus()
  }, [position])

  useEffect(() => {
    if (!position) return
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) close()
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close()
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault()
        const items = [...(ref.current?.querySelectorAll<HTMLButtonElement>('.menu-item:not(:disabled)') ?? [])]
        const index = items.indexOf(document.activeElement as HTMLButtonElement)
        const next = e.key === 'ArrowDown' ? index + 1 : index - 1
        items[(next + items.length) % items.length]?.focus()
      }
    }
    window.addEventListener('mousedown', onDown, true)
    window.addEventListener('keydown', onKey)
    window.addEventListener('blur', close)
    return () => {
      window.removeEventListener('mousedown', onDown, true)
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('blur', close)
    }
  }, [position, close])

  if (!position) return null
  return createPortal(
    <div ref={ref} className="menu" role="menu" style={{ left: place.x, top: place.y }}>
      {entries.map((entry, i) => {
        if ('separator' in entry) return <div key={i} className="menu-separator" />
        if ('heading' in entry) return <div key={i} className="menu-label">{entry.heading}</div>
        return (
          <button
            key={i}
            type="button"
            role="menuitem"
            className={`menu-item ${entry.danger ? 'danger' : ''}`}
            disabled={entry.disabled}
            onClick={() => {
              close()
              entry.onClick()
            }}
          >
            {entry.icon}
            <span className="truncate">{entry.label}</span>
            {entry.shortcut && <span className="shortcut">{entry.shortcut}</span>}
          </button>
        )
      })}
    </div>,
    document.body,
  )
}
