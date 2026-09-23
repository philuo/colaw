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
  // macOS 15 re-confirms screen recording through a SEPARATE dialog — the
  // "bypass the private window picker" one — roughly monthly, no matter what
  // this pane reports and with no API for an app to suppress it. The toast
  // reads like a fresh ask, so the pane has to say in advance that it is not
  // one: a user who just saw "Granted" here and then gets asked again
  // reasonably concludes the switch is broken.
  permissionMonthly: 'macOS 15 asks again about screen recording roughly once a month — the "bypass the window picker" prompt. Choose Allow: the grant above is still in place.',
  guideTitle: 'Grant access',
  guideBarDrag: 'Drag Colaw into the {pane} list above',
  guideBarHint: 'Release to finish the grant — then switch the capability on yourself.',
  guideReveal: 'Show in Finder',
  // Direction-neutral on purpose: the bar also reports a plain switch flip,
  // and both the grants the host caches and the providers that mount at boot
  // only land in the next process — whether the switch went on or off.
  grantDoneTitle: 'Setting saved — restart Colaw to apply it.',
  grantRestart: 'Restart Colaw',
  pendingTitle: 'Permission granted — turn the switch on.',
  pendingAction: 'Turn on',
  pendingWaiting: 'Waiting for the macOS grant…',
  revokedTitle: 'A macOS permission was revoked — Computer use is paused.',
  revokedHint: 'Grant it again in System Settings, then restart Colaw.',
  revokedRegrant: 'Grant again',
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
  permissionMonthly: 'macOS 15 大约每月会再确认一次屏幕录制 —— 就是提示「绕过系统窗口选择器」的那个弹窗。点「允许」即可，上面的授权并没有失效。',
  guideTitle: '授权引导',
  guideBarDrag: '把 Colaw 拖进上方的「{pane}」列表',
  guideBarHint: '松手即完成授权 —— 之后请自行打开开关。',
  guideReveal: '在 Finder 中显示',
  grantDoneTitle: '已保存 —— 重启 Colaw 后生效。',
  grantRestart: '重启 Colaw',
  pendingTitle: '授权已完成 —— 请打开开关。',
  pendingAction: '打开开关',
  pendingWaiting: '等待 macOS 授权…',
  revokedTitle: 'macOS 授权已被撤销 —— 电脑操控已暂停。',
  revokedHint: '请在系统设置中重新授权，然后重启 Colaw。',
  revokedRegrant: '重新授权',
  guideRecheck: '重新检测',
  guideDismiss: '稍后',
}
