// Fängt Fehler in einer Ansicht ab, damit nicht die ganze App leer wird.
import { Component, type ReactNode } from 'react'
import { Button } from './Button'
import { Empty } from './Empty'

interface State {
  error: Error | null
}

export class ErrorBoundary extends Component<{ children: ReactNode; resetKey?: string }, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidUpdate(previous: { resetKey?: string }): void {
    if (previous.resetKey !== this.props.resetKey && this.state.error) this.setState({ error: null })
  }

  render(): ReactNode {
    if (!this.state.error) return this.props.children
    return (
      <Empty title="Diese Ansicht konnte nicht angezeigt werden" action={<Button onClick={() => this.setState({ error: null })}>Erneut versuchen</Button>}>
        {this.state.error.message}
      </Empty>
    )
  }
}
