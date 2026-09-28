// Fortschrittsfenster, solange die KI eine Zusammenfassung schreibt.
import { useAiTask } from '@/lib/ai'
import { Button } from '@/ui/Button'
import { Modal } from '@/ui/Modal'

export function AiTaskHost() {
  const task = useAiTask((s) => s.task)
  if (!task) return null
  return (
    <Modal
      wide
      title={
        <span className="row">
          <span className="spinner" /> {task.title}
        </span>
      }
      onClose={task.cancel}
      footer={<Button onClick={task.cancel}>Abbrechen</Button>}
    >
      <div className="ai-progress selectable">{task.text || 'Unterlagen werden gelesen …'}</div>
    </Modal>
  )
}
