/** Copy dictionaries for the 电脑操控 settings section. */

/** English strings (the key-set source of truth for this pair). */
export const en = {
  nav: 'Desktop control',
  title: 'Desktop control',
  intro: 'Choose which system capabilities Colaw may use.',
  browserUseTitle: 'Browser use',
  browserUseDescription: 'Let Colaw control a browser through CDP',
  computerUseTitle: 'Computer use',
  computerUseDescription: 'Let Colaw control applications on your computer',
  lockScreenTitle: 'Locked-Mac operation',
  lockScreenDescription: 'Let Colaw keep operating this Mac while it is locked',
  permissionHeadline: 'macOS permissions',
  permissionAccessibility: 'Accessibility',
  permissionScreenRecording: 'Screen Recording',
  permissionGranted: 'Granted',
  permissionMissing: 'Not granted',
  permissionOpenSettings: 'Open System Settings',
  permissionChecking: 'Checking…',
  permissionHint: 'Computer use needs these grants for Colaw itself.',
  guideTitle: 'Grant access',
  guideStepPane: 'In the System Settings window that just opened, find the matching pane.',
  guideStepAdd: 'Press the add button (or drag Colaw in) and select the app.',
  guideStepToggle: 'Switch the toggle on, then re-check below.',
  guideRecheck: 'Re-check',
  guideDismiss: 'Later',
} as const

/** The settings.desktop namespace key union. */
export type DesktopKey = keyof typeof en

/** Chinese strings (same keys as {@link en}). */
export const zh: { [Key in keyof typeof en]: string } = {
  nav: '电脑操控',
  title: '电脑操控',
  intro: '选择允许 Colaw 使用的系统能力。',
  browserUseTitle: 'Browser_use',
  browserUseDescription: '允许 Colaw 通过 CDP 控制浏览器',
  computerUseTitle: 'Computer_use',
  computerUseDescription: '允许 Colaw 控制您电脑上的应用',
  lockScreenTitle: '锁屏操作',
  lockScreenDescription: '允许 Colaw 在 Mac 锁定时使用此 Mac',
  permissionHeadline: 'macOS 权限',
  permissionAccessibility: '辅助功能',
  permissionScreenRecording: '屏幕录制',
  permissionGranted: '已授权',
  permissionMissing: '未授权',
  permissionOpenSettings: '打开系统设置',
  permissionChecking: '检测中…',
  permissionHint: '电脑操控需要 Colaw 本身获得这些授权。',
  guideTitle: '授权引导',
  guideStepPane: '在刚打开的「系统设置」窗口中，进入对应的面板。',
  guideStepAdd: '点按添加按钮（或把 Colaw 拖入列表）并选择应用。',
  guideStepToggle: '打开开关，然后点下方重新检测。',
  guideRecheck: '重新检测',
  guideDismiss: '稍后',
}
