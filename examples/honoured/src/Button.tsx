import type { ReactNode } from 'react'

/** The button every surface in the system uses. */
export interface ButtonProps {
  /** Visible label. Required, and callers rely on it. */
  label: string;
  /** Which of the two visual treatments to use. */
  variant?: 'primary' | 'secondary';
  disabled?: boolean;
  icon?: ReactNode;
  onClick?: (event: MouseEvent) => void;
  /** @internal wiring the test harness needs; not part of the public surface. */
  instrumentationHook?: (name: string) => void;
  _renderCount?: number;
}

export function Button(props: ButtonProps) {
  return props.label
}
