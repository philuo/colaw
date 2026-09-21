/** Copy dictionaries for the 电脑操控 settings section. */

/** English strings (the key-set source of truth for this pair). */
export const en = {
  nav: 'Desktop control',
  title: 'Desktop control',
  intro: 'Choose which desktop surfaces Colaw may use. Turning a switch off stops new use; it does not revoke any macOS permission already granted in System Settings.',
  browserUseTitle: 'Browser use',
  browserUseDescription: 'Let Colaw control a browser through CDP',
  computerUseTitle: 'Computer use',
  computerUseDescription: 'Let Colaw control applications on your computer',
  lockScreenTitle: 'Locked-Mac operation',
  lockScreenDescription: 'Let Colaw keep operating this Mac while it is locked',
} as const

/** The settings.desktop namespace key union. */
export type DesktopKey = keyof typeof en

/** Chinese strings (same keys as {@link en}). */
export const zh: { [Key in keyof typeof en]: string } = {
  nav: '电脑操控',
  title: '电脑操控',
  intro: '选择允许 Colaw 使用的桌面能力。关闭开关仅停止新的使用，不会撤销系统设置中已授予的 macOS 权限。',
  browserUseTitle: 'Browser_use',
  browserUseDescription: '允许 Colaw 通过 CDP 控制浏览器',
  computerUseTitle: 'Computer_use',
  computerUseDescription: '允许 Colaw 控制您电脑上的应用',
  lockScreenTitle: '锁屏操作',
  lockScreenDescription: '允许 Colaw 在 Mac 锁定时使用此 Mac',
}
