import type { ButtonHTMLAttributes, ReactNode } from 'react'

type Variant = 'default' | 'primary' | 'ghost' | 'danger'
type Size = 'sm' | 'md' | 'lg'

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant
  size?: Size
  icon?: ReactNode
}

export function Button({ variant = 'default', size = 'md', icon, className = '', children, ...rest }: ButtonProps) {
  const classes = ['btn', variant !== 'default' && `btn-${variant}`, size !== 'md' && `btn-${size}`, className]
  return (
    <button type="button" className={classes.filter(Boolean).join(' ')} {...rest}>
      {icon}
      {children}
    </button>
  )
}

interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  label: string
  small?: boolean
  pressed?: boolean
}

export function IconButton({ label, small, pressed, className = '', children, ...rest }: IconButtonProps) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      aria-pressed={pressed}
      className={`icon-btn ${small ? 'icon-btn-sm' : ''} ${className}`}
      {...rest}
    >
      {children}
    </button>
  )
}
