import type { ReactNode } from 'react'

/** The same button, three releases later. */
export interface ButtonProps {
  /** Visible label. */
  label: string;
  /** "secondary" was renamed to "subtle" without a major release. */
  variant?: 'primary' | 'subtle';
  /** Optional in the contract, required here: every caller that omitted it breaks. */
  disabled: boolean;
  icon?: ReactNode;
  onClick?: (event: MouseEvent) => void;
  /** Added since the contract was written. Compatible. */
  loading?: boolean;
  /** @internal wiring the test harness needs. */
  instrumentationHook?: (name: string) => void;
}

export function Button(props: ButtonProps) {
  return props.label
}
