/** Remote boundary types of the desktop-permission remote. */

/**
 * One TCC grant pair crossing the `desktopPermissions` remote. Both answers
 * come from the host process's own binding, so "false" means the app the OS
 * sees has not been granted, not that a probe was skipped.
 */
export interface DesktopPermissionStatus {
  /** The host process may send Accessibility-driven input. */
  accessibility: boolean
  /** The host process may capture screen contents. */
  screenRecording: boolean
}

/** The privacy panes a missing grant deep-links to. */
export type DesktopPermissionPane = 'accessibility' | 'screenRecording'
