import { create } from 'zustand'

interface ToastItem {
  id: number
  message: string
  error: boolean
}

const useToasts = create<{ items: ToastItem[] }>(() => ({ items: [] }))
let counter = 0

export function toast(message: string, options: { error?: boolean } = {}): void {
  const id = ++counter
  useToasts.setState((s) => ({ items: [...s.items, { id, message, error: Boolean(options.error) }] }))
  setTimeout(() => useToasts.setState((s) => ({ items: s.items.filter((t) => t.id !== id) })), options.error ? 6000 : 3500)
}

export function toastError(error: unknown): void {
  toast(error instanceof Error ? error.message : String(error), { error: true })
}

export function ToastHost() {
  const items = useToasts((s) => s.items)
  return (
    <div className="toasts" role="status">
      {items.map((t) => (
        <div key={t.id} className={`toast ${t.error ? 'error' : ''}`}>
          {t.message}
        </div>
      ))}
    </div>
  )
}
