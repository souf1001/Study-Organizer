import type { ReactNode } from 'react'

export function Empty({ icon, title, children, action }: { icon?: ReactNode; title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="empty">
      {icon}
      <div className="empty-title">{title}</div>
      {children && <div className="small">{children}</div>}
      {action}
    </div>
  )
}
