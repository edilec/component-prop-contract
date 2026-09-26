export type ChipProps = {
  label: string;
  tone?: 'neutral' | 'danger';
  onDismiss?: (id: string) => void;
};

export function Chip(props: ChipProps) {
  return props.label
}
