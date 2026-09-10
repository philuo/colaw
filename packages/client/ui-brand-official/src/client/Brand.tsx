import { CatLogo } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SidebarBrandMarkOwnerProps } from '@deepseek-ai/dsh-client-ui-sidebar/client'

/**
 * Render the official mark with the presentation requested by its host surface.
 * @param props - Host-supplied mark presentation.
 * @returns the official cat mark.
 */
export function OfficialBrandMark({ size }: SidebarBrandMarkOwnerProps) {
  return <CatLogo size={size} />
}

/**
 * Render the official name artwork without its independently slotted mark.
 * @returns the official name.
 */
export function OfficialBrandName() {
  return <span style={{ fontSize: 18, fontWeight: 600, letterSpacing: '0.02em' }}>Colaw</span>
}
