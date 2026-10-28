// Android integration of the UI shell: the hardware back button.
import { App } from '@capacitor/app'
import { closeTopLayer } from '@/lib/back-stack'
import { useWorkspace } from '@/lib/workspace'

/** Back closes the topmost layer, then navigates back in the active pane, then leaves the app */
function goBack(): void {
  if (closeTopLayer()) return
  const workspace = useWorkspace.getState()
  const pane = workspace.panes.find((p) => p.id === workspace.activeId)
  if (pane && pane.back.length > 0) {
    workspace.back(pane.id)
    return
  }
  void App.minimizeApp()
}

export function setupAndroid(): void {
  void App.addListener('backButton', goBack)
}
