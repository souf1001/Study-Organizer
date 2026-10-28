// Android back button: closes the topmost open layer (menu, dialog, drawer …) before it
// navigates back. Components register a handler while they are open; the most recent wins.
import { useEffect, useRef } from 'react'

const handlers: (() => void)[] = []

/** Runs the most recently registered handler; false if nothing was open */
export function closeTopLayer(): boolean {
  const handler = handlers.at(-1)
  if (!handler) return false
  handler()
  return true
}

/** Registers `onBack` while `active` is true */
export function useBackHandler(onBack: () => void, active = true): void {
  const latest = useRef(onBack)
  useEffect(() => {
    latest.current = onBack
  })
  useEffect(() => {
    if (!active) return
    const handler = () => latest.current()
    handlers.push(handler)
    return () => {
      const index = handlers.lastIndexOf(handler)
      if (index !== -1) handlers.splice(index, 1)
    }
  }, [active])
}
