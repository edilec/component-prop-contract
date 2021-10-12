export type ChipProps = {
  label: string;
  onDismiss?: (id: string) => void;
};

export function Chip(props: ChipProps) {
  return props.label
}
