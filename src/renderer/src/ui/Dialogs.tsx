// Bestätigen- und Eingabe-Dialoge als Promise: `if (await confirm({...})) …`
import { useState } from 'react'
import { create } from 'zustand'
import { Button } from './Button'
import { Input } from './Field'
import { Modal } from './Modal'

interface ConfirmOptions {
  title: string
  message?: string
  confirmLabel?: string
  danger?: boolean
}

interface PromptOptions {
  title: string
  label?: string
  initial?: string
  placeholder?: string
  confirmLabel?: string
}

type Dialog =
  | { kind: 'confirm'; options: ConfirmOptions; resolve: (v: boolean) => void }
  | { kind: 'prompt'; options: PromptOptions; resolve: (v: string | null) => void }

const useDialog = create<{ dialog: Dialog | null }>(() => ({ dialog: null }))

export function confirm(options: ConfirmOptions): Promise<boolean> {
  return new Promise((resolve) => useDialog.setState({ dialog: { kind: 'confirm', options, resolve } }))
}

export function prompt(options: PromptOptions): Promise<string | null> {
  return new Promise((resolve) => useDialog.setState({ dialog: { kind: 'prompt', options, resolve } }))
}

function PromptDialog({ options, resolve }: { options: PromptOptions; resolve: (v: string | null) => void }) {
  const [value, setValue] = useState(options.initial ?? '')
  const submit = () => resolve(value.trim() || null)
  return (
    <Modal
      title={options.title}
      onClose={() => resolve(null)}
      footer={
        <>
          <Button onClick={() => resolve(null)}>Abbrechen</Button>
          <Button variant="primary" onClick={submit}>
            {options.confirmLabel ?? 'Speichern'}
          </Button>
        </>
      }
    >
      <Input
        autoFocus
        value={value}
        placeholder={options.placeholder}
        aria-label={options.label ?? options.title}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && submit()}
        onFocus={(e) => e.target.select()}
      />
    </Modal>
  )
}

export function DialogHost() {
  const dialog = useDialog((s) => s.dialog)
  if (!dialog) return null
  const finish = <T,>(resolve: (v: T) => void) => (value: T) => {
    useDialog.setState({ dialog: null })
    resolve(value)
  }

  if (dialog.kind === 'prompt') return <PromptDialog options={dialog.options} resolve={finish(dialog.resolve)} />

  const done = finish(dialog.resolve)
  const { options } = dialog
  return (
    <Modal
      title={options.title}
      onClose={() => done(false)}
      footer={
        <>
          <Button onClick={() => done(false)}>Abbrechen</Button>
          <Button autoFocus variant={options.danger ? 'danger' : 'primary'} onClick={() => done(true)}>
            {options.confirmLabel ?? 'OK'}
          </Button>
        </>
      }
    >
      {options.message && <p className="muted">{options.message}</p>}
    </Modal>
  )
}
