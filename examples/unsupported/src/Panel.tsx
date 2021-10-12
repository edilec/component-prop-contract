import type { BaseProps } from './base'

/**
 * A props type this tool cannot read, and says so rather than guessing.
 *
 * The `extends` clause means part of the public surface is declared in
 * `./base`, which this tool never opens. Reading only the members below would
 * produce a surface that is real but incomplete -- and then every contract
 * member declared in `BaseProps` would be reported as missing from a component
 * that declares it perfectly well.
 */
export interface PanelProps extends BaseProps {
  title: string;
  onClose?: () => void;
}
