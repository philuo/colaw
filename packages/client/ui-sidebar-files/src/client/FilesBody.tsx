/**
 * The file tree's body: the session's workspace root, listed one level at a time.
 *
 * Everything the tree keeps lives in its store, keyed by tab; everything it asks
 * for goes through its injected face. The component itself only decides what to
 * draw for each absolute path and what a click means: a directory toggles, a
 * file opens through the owner's `tabActions` for a `file:` viewer to claim, and
 * anything else is shown but refuses to open. The header row is the text
 * preview's: the root's path, directories greyed and the last segment in full
 * ink, then the one control at its end, reload, which drops every listed level
 * and asks again for the expanded ones.
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode, RefObject } from 'react'
import clsx from 'clsx'
import type { RemoteFailure } from '@deepseek-ai/dsh-api-remotes/client'
import type { PropsLocale, PropsRuntime, PropsStore, TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import {
  FileTypeIcon, IconCloseFill14, IconFolderClose16, IconFolderOpen16, IconRefreshOutline16,
  IconSearchOutline16, classifyFileType,
} from '@deepseek-ai/dsh-client-ui-primitives'
import { fileAddressFor, pathPartsOf } from '@deepseek-ai/dsh-util-workspace-path'
import type { WorkspaceDirectoryEntry } from '@deepseek-ai/dsh-api-workspace-files/types'
import { childPath } from './face.ts'
import type { FilesInjected } from './face.ts'
import type {} from './locales.ts'
import type { FilesTabState, createFilesStore } from './store.ts'
import css from './FilesBody.module.css'

/** The body's composed props: the tab it draws, its store, its face, and its copy. */
export type FilesBodyProps =
  & PropsRuntime<'sidebar.right.pane.tab'>
  & PropsStore<ReturnType<typeof createFilesStore>>
  & FilesInjected
  & PropsLocale<'sidebarFiles'>

/** Natural, case-insensitive name order, so `file2` precedes `file10`. */
const byName = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })

/**
 * Whether one entry's name passes the search filter: an empty query matches
 * everything, otherwise a case-insensitive substring of the name.
 * @param name - the entry's name as listed.
 * @param query - the search text, already as typed.
 * @returns true when the entry should stay visible.
 */
export function matchesFilter(name: string, query: string): boolean {
  if (query === '') return true
  return name.toLowerCase().includes(query.toLowerCase())
}

/**
 * Order one level's entries for display: directories first, then everything
 * else, each group by name. The endpoint's order is a listing fact; this is the
 * reader's.
 * @param entries - the listing as the endpoint returned it.
 * @returns a new array, directories first, then by name within each group.
 */
export function orderEntries(entries: readonly WorkspaceDirectoryEntry[]): WorkspaceDirectoryEntry[] {
  return [...entries].sort((left, right) => {
    const group = Number(right.type === 'directory') - Number(left.type === 'directory')
    return group !== 0 ? group : byName.compare(left.name, right.name)
  })
}

/**
 * Say why a directory could not be listed, in terms of the directory.
 * @param t - namespace-bound translate.
 * @param failure - the settled Remote failure.
 * @returns the line to show under the directory.
 */
export function failureLine(t: TranslateNS<'sidebarFiles'>, failure: RemoteFailure): string {
  switch (failure.code) {
    case 'workspace-file/not-found': return t('error.notFound')
    case 'workspace-file/outside-workspace': return t('error.outsideWorkspace')
    case 'workspace-file/not-directory': return t('error.notDirectory')
    // Carrier and unclassified host failures reach the reader as themselves:
    // this tree knows nothing useful to add to a transport-level message.
    default: return t('error.unavailable', { message: failure.message })
  }
}

/* jscpd:ignore-start -- the header row is the document preview's (ui-sidebar-documentpreview
   TextPreview `usePathClipped`), copied because a plugin bundle shares runtime code
   only through the platform modules. TODO: once the artifact and slot surfaces
   settle, one copy in ui-primitives could serve every pane header. */
/**
 * Keep the path row's `data-files-path-clipped` current: set while the path's
 * text is wider than its box, so the stylesheet fades the clipped start. Read
 * after each commit that can change the path or mount the header, and whenever
 * either box resizes; written to the DOM directly because it changes only how
 * the stylesheet fades what is already rendered.
 */
function usePathClipped(
  box: RefObject<HTMLDivElement | null>,
  text: RefObject<HTMLSpanElement | null>,
  path: string | undefined,
): void {
  useLayoutEffect(() => {
    const outer = box.current
    const inner = text.current
    if (outer === null || inner === null) return undefined
    const apply = (): void => {
      if (inner.offsetWidth > outer.clientWidth) outer.dataset.filesPathClipped = ''
      else delete outer.dataset.filesPathClipped
    }
    apply()
    const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(apply)
    observer?.observe(outer)
    observer?.observe(inner)
    return () => { observer?.disconnect() }
  }, [box, text, path])
}
/* jscpd:ignore-end */

/** What every level shares: the tab's tree, the search filter, and the gestures. */
interface TreeContext {
  readonly state: FilesTabState
  readonly filter: string
  /** 过滤激活时保留的路径集合（命中 + 命中后代的祖先）；null 表示未在过滤。 */
  readonly visible: ReadonlySet<string> | null
  readonly onToggle: (path: string) => void
  readonly onOpen: (path: string) => void
  readonly t: TranslateNS<'sidebarFiles'>
}

/** One entry's row, and its children when it is an expanded directory. */
function Entry({ parent, entry, tree }: { parent: string; entry: WorkspaceDirectoryEntry; tree: TreeContext }): ReactNode {
  const path = childPath(parent, entry.name)
  const filtering = tree.filter !== ''
  if (entry.type === 'directory') {
    const expanded = filtering || tree.state.expanded.includes(path)
    return (
      <li className={css.item} data-files-entry="directory" data-files-path={path}>
        <button type="button" className={css.row} aria-expanded={expanded} onClick={() => { tree.onToggle(path) }}>
          {expanded ? <IconFolderOpen16 className={css.icon} /> : <IconFolderClose16 className={css.icon} />}
          <span className={css.name}>{entry.name}</span>
        </button>
        {expanded && <ul className={css.level}><Level path={path} tree={tree} /></ul>}
      </li>
    )
  }
  if (entry.type === 'file') {
    return (
      <li className={css.item} data-files-entry="file" data-files-path={path}>
        <button type="button" className={css.row} onClick={() => { tree.onOpen(path) }}>
          <FileTypeIcon kind={classifyFileType(entry.name)} size={16} className={css.fileIcon} />
          <span className={css.name}>{entry.name}</span>
        </button>
      </li>
    )
  }
  return (
    <li className={css.item} data-files-entry="other" data-files-path={path}>
      <span className={clsx(css.row, css.other)} aria-disabled="true" title={tree.t('entry.other')}>
        <span className={css.name}>{entry.name}</span>
      </span>
    </li>
  )
}

/** One directory's rows: its state while listing, its entries once listed. */
function Level({ path, tree }: { path: string; tree: TreeContext }): ReactNode {
  const { state, t } = tree
  const level = state.levels[path]
  if (level === undefined || level.kind === 'loading') {
    return <li className={css.note} data-files-row="loading">{t('loading')}</li>
  }
  if (level.kind === 'failed') {
    return (
      <li className={css.note} data-files-row="failed" data-files-code={level.failure.code}>
        {failureLine(t, level.failure)}
      </li>
    )
  }
  const entries = orderEntries(level.level.entries)
  const filtering = tree.filter !== ''
  const kept = filtering
    ? entries.filter(entry => tree.visible?.has(childPath(path, entry.name)) === true)
    : entries
  return (
    <>
      {kept.length === 0 && <li className={css.note} data-files-row={filtering ? 'no-match' : 'empty'}>{filtering ? t('search.noMatches') : t('empty')}</li>}
      {kept.map(entry => <Entry key={entry.name} parent={path} entry={entry} tree={tree} />)}
      {level.level.truncated && <li className={css.note} data-files-row="truncated">{t('truncated')}</li>}
    </>
  )
}

/** The file tree's body: the workspace root and whatever the reader has opened under it. */
export function FilesBody({
  useTabInfo, sessionId, useSessions, useStore, actions, start, load, toggle, t,
}: FilesBodyProps): ReactNode {
  const { tab } = useTabInfo()
  const { signal, actions: tabActions } = tab
  const cwd = useSessions(sessions => sessions.byId[sessionId]?.cwd)
  const state = useStore(store => store.byTab[tab.id])
  const pathRef = useRef<HTMLDivElement>(null)
  const pathTextRef = useRef<HTMLSpanElement>(null)
  const [searchOpen, setSearchOpen] = useState(false)
  const [query, setQuery] = useState('')
  const searchInput = useRef<HTMLInputElement>(null)
  usePathClipped(pathRef, pathTextRef, state?.root)

  /**
   * 过滤激活时保留的路径集合：命中文件、命中目录，以及含命中后代的
   * 祖先目录。对已列出的层级做一次深度优先收集；未知层级按需由
   * 下面的递归列举逐步补齐后再收敛。
   */
  const visiblePaths = useMemo(() => {
    if (query === '' || state === undefined) return null
    const out = new Set<string>()
    const visit = (dirPath: string): number => {
      const level = state.levels[dirPath]
      if (level === undefined || level.kind !== 'ready') return 0
      let kept = 0
      for (const entry of level.level.entries) {
        const child = childPath(dirPath, entry.name)
        if (entry.type === 'directory') {
          const before = out.size
          kept += visit(child)
          const hasKeptDescendant = out.size > before
          if (matchesFilter(entry.name, query) || hasKeptDescendant) {
            out.add(child)
            kept += 1
          }
        } else if (matchesFilter(entry.name, query)) {
          out.add(child)
          kept += 1
        }
      }
      return kept
    }
    visit(state.root)
    return out
  }, [query, state])

  // 过滤激活时对已知目录按需递归列举，让深层路径也能被搜到。
  useEffect(() => {
    if (query === '' || state === undefined || signal.aborted) return
    for (const [path, level] of Object.entries(state.levels)) {
      if (level.kind !== 'ready') continue
      for (const entry of level.level.entries) {
        if (entry.type !== 'directory') continue
        const child = childPath(path, entry.name)
        if (state.levels[child] === undefined) load(tab.id, child, signal)
      }
    }
  }, [query, state, load, signal, tab.id])
  useEffect(() => {
    // A bucket gone because the record aborted must not be re-seeded by a
    // component that has not unmounted yet.
    if (state !== undefined || cwd === undefined || signal.aborted) return
    start(tab.id, cwd, signal)
  }, [state, cwd, tab.id, signal, start])

  if (cwd === undefined) {
    return (
      <div className={css.status} data-files-state="no-workspace">
        <p className={css.statusLine}>{t('noWorkspace')}</p>
      </div>
    )
  }
  if (state === undefined) return null
  const tree: TreeContext = {
    state,
    filter: query,
    visible: visiblePaths,
    onToggle: (path) => { toggle(tab.id, path, state.levels[path] !== undefined, signal) },
    // Every row is under the tree's root, so its address is session-relative.
    onOpen: (path) => { tabActions.openResource(fileAddressFor(sessionId, state.root, path)) },
    t,
  }
  // Reload drops every level and asks again for the expanded ones; a collapsed
  // level is fetched again the next time it opens.
  const reload = (): void => {
    actions.reset(tab.id)
    for (const path of state.expanded) load(tab.id, path, signal)
  }
  const { directory, name } = pathPartsOf(state.root)
  return (
    <div className={css.root} data-files-state="tree" data-files-root={state.root}>
      {/* jscpd:ignore-start -- the text preview's header row; see `usePathClipped`. */}
      <div className={css.header}>
        <div ref={pathRef} className={css.path} title={state.root} data-files-path>
          <span ref={pathTextRef} className={css.pathText}>
            {directory !== '' && <span className={css.pathDirectory}>{directory}</span>}
            <span className={css.pathName}>{name}</span>
          </span>
        </div>
        <div className={clsx(css.searchSlot, searchOpen && css.searchOpen)}>
          <div
            className={clsx(css.search, searchOpen && css.searchOpenPill)}
            onClick={() => { setSearchOpen(true); searchInput.current?.focus() }}
          >
            <button
              type="button"
              className={css.searchButton}
              aria-label={t('search.aria')}
              aria-expanded={searchOpen}
              title={t('search.aria')}
              onClick={(e) => {
                e.stopPropagation()
                if (searchOpen) {
                  setQuery('')
                  setSearchOpen(false)
                } else {
                  setSearchOpen(true)
                  searchInput.current?.focus()
                }
              }}
            >
              <IconSearchOutline16 size={searchOpen ? 12 : 15} />
            </button>
            <input
              ref={searchInput}
              className={css.searchInput}
              type="text"
              placeholder={t('search.placeholder')}
              value={query}
              tabIndex={searchOpen ? 0 : -1}
              onChange={e => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key !== 'Escape') return
                setQuery('')
                setSearchOpen(false)
              }}
            />
            {searchOpen && query !== '' && (
              <button
                type="button"
                className={css.searchClear}
                aria-label={t('search.clear')}
                onClick={(e) => { e.stopPropagation(); setQuery('') }}
              >
                <IconCloseFill14 />
              </button>
            )}
          </div>
        </div>
        <button
          type="button"
          className={css.tool}
          aria-label={t('reload')}
          title={t('reload')}
          data-files-reload
          onClick={reload}
        >
          <IconRefreshOutline16 />
        </button>
      </div>
      {/* jscpd:ignore-end */}
      <div className={css.body}>
        <ul className={css.level}><Level path={state.root} tree={tree} /></ul>
      </div>
    </div>
  )
}
