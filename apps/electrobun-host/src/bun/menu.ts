/**
 * The native application menu, written in the shell's language.
 *
 * The menu bar is macOS chrome: AppKit draws its titles from the labels we hand
 * it, so following the shell's language means rebuilding the menu rather than
 * translating a DOM node. Most items are roles — AppKit answers them through the
 * responder chain, and the label only needs to match the language — while the
 * two commands the app adds carry a key equivalent of their own.
 *
 * @module @deepseek-ai/dsh-electrobun-host/bun/menu
 */

import { on, setApplicationMenu } from 'electrobun/bun/app-menu'

/** Languages the application menu is written in. */
export type MenuLocale = 'zh' | 'en'

/** Command names the shell answers when a menu item with an action is used. */
export const NEW_SESSION = 'new-session'
export const TOGGLE_SIDEBAR = 'toggle-sidebar'

/** Everything one language has to say in the menu bar. */
interface MenuLabels {
  app: string
  about: string
  hide: string
  hideOthers: string
  showAll: string
  quit: string
  file: string
  newSession: string
  edit: string
  undo: string
  redo: string
  cut: string
  copy: string
  paste: string
  selectAll: string
  view: string
  toggleSidebar: string
  fullScreen: string
  window: string
  minimize: string
  zoom: string
  bringAllToFront: string
}

const LABELS: Record<MenuLocale, MenuLabels> = {
  zh: {
    app: 'Colaw',
    about: '关于 Colaw',
    hide: '隐藏 Colaw',
    hideOthers: '隐藏其他',
    showAll: '全部显示',
    quit: '退出 Colaw',
    file: '文件',
    newSession: '新建对话',
    edit: '编辑',
    undo: '撤销',
    redo: '重做',
    cut: '剪切',
    copy: '拷贝',
    paste: '粘贴',
    selectAll: '全选',
    view: '显示',
    toggleSidebar: '折叠/展开左侧面板',
    fullScreen: '进入/退出全屏',
    window: '窗口',
    minimize: '最小化',
    zoom: '缩放',
    bringAllToFront: '全部置于顶层',
  },
  en: {
    app: 'Colaw',
    about: 'About Colaw',
    hide: 'Hide Colaw',
    hideOthers: 'Hide Others',
    showAll: 'Show All',
    quit: 'Quit Colaw',
    file: 'File',
    newSession: 'New Chat',
    edit: 'Edit',
    undo: 'Undo',
    redo: 'Redo',
    cut: 'Cut',
    copy: 'Copy',
    paste: 'Paste',
    selectAll: 'Select All',
    view: 'View',
    toggleSidebar: 'Toggle Sidebar',
    fullScreen: 'Enter Full Screen',
    window: 'Window',
    minimize: 'Minimize',
    zoom: 'Zoom',
    bringAllToFront: 'Bring All to Front',
  },
}

/**
 * Install the application menu for one language.
 *
 * Call again to change language: the menu is replaced wholesale, which is the
 * only way AppKit takes new titles. The two commands this app adds carry key
 * equivalents, and the menu is where a macOS key equivalent is answered — the
 * panel would never see ⌘N or ⌘B as a keydown. Role items keep the standard
 * responder-chain behaviour the composer depends on (copy, paste), so they are
 * declared even though the app adds no logic of its own to them.
 * @param locale - Language to write the menu in.
 */
export function installApplicationMenu(locale: MenuLocale): void {
  const label = LABELS[locale]
  setApplicationMenu([
    {
      label: label.app,
      submenu: [
        { role: 'about', label: label.about },
        { type: 'divider' },
        { role: 'hide', label: label.hide },
        { role: 'hideOthers', label: label.hideOthers },
        { role: 'showAll', label: label.showAll },
        { type: 'divider' },
        { role: 'quit', label: label.quit },
      ],
    },
    {
      label: label.file,
      submenu: [
        { label: label.newSession, accelerator: 'CommandOrControl+N', action: NEW_SESSION },
      ],
    },
    {
      label: label.edit,
      submenu: [
        { role: 'undo', label: label.undo },
        { role: 'redo', label: label.redo },
        { type: 'divider' },
        { role: 'cut', label: label.cut },
        { role: 'copy', label: label.copy },
        { role: 'paste', label: label.paste },
        { role: 'selectAll', label: label.selectAll },
      ],
    },
    {
      label: label.view,
      submenu: [
        { label: label.toggleSidebar, accelerator: 'CommandOrControl+B', action: TOGGLE_SIDEBAR },
        { type: 'divider' },
        { role: 'toggleFullScreen', label: label.fullScreen },
      ],
    },
    {
      label: label.window,
      submenu: [
        { role: 'minimize', label: label.minimize },
        { role: 'zoom', label: label.zoom },
        { type: 'divider' },
        { role: 'bringAllToFront', label: label.bringAllToFront },
      ],
    },
  ])
}

/**
 * Route a clicked menu item to the shell, once per process.
 *
 * Re-installing the menu for a language change must not add a second listener,
 * or every command would be dispatched twice.
 * @param dispatch - Runs one command in the window's shell.
 */
export function onApplicationMenuClicked(dispatch: (command: string) => void): void {
  on('application-menu-clicked', (event: unknown) => {
    // The emitter hands either the event or its payload, depending on the
    // runtime; read both so a menu click is never silently dropped.
    const carrier = event as { data?: { action?: unknown }; action?: unknown } | undefined
    const action = carrier?.data?.action ?? carrier?.action
    if (action === NEW_SESSION || action === TOGGLE_SIDEBAR) dispatch(action)
  })
}

// v1.0.2 marker
