/** Native media playback for complete file bytes: video and audio elements. */
import { useEffect, useMemo, useState } from 'react'
import type { MouseEvent as ReactMouseEvent, ReactNode, WheelEvent as ReactWheelEvent } from 'react'
import { LoadingIndicator } from '../LoadingIndicator.tsx'
import css from './MediaBody.module.css'

const VIDEO_EXTENSIONS = ['mp4', 'm4v', 'mov', 'webm', 'ogv']
const AUDIO_EXTENSIONS = ['mp3', 'm4a', 'wav', 'ogg', 'oga', 'flac', 'aac', 'opus']

/** The kind of player a file's extension maps to. */
type MediaKind = 'video' | 'audio' | undefined

function mediaKindOf(path: string): MediaKind {
  const name = path.replaceAll('\\', '/').toLowerCase().slice(path.lastIndexOf('/') + 1)
  const dot = name.lastIndexOf('.')
  const extension = dot < 0 ? '' : name.slice(dot + 1)
  if (VIDEO_EXTENSIONS.includes(extension)) return 'video'
  if (AUDIO_EXTENSIONS.includes(extension)) return 'audio'
  return undefined
}

/**
 * Present complete media bytes: an object URL feeding the browser's own
 * player. Video keeps its aspect ratio with the long edge fitting the pane
 * (landscape fits width, portrait fits height), centered and fully visible
 * without scrollbars; pinch or Ctrl+wheel zooms. The native WKWebView
 * selection/data-detector menu is suppressed on the player surface.
 * @param props - document bytes, resource identity, and locale.
 * @returns the player surface.
 */
export function MediaBody({ content, resourceAddress, t }: {
  content: { kind: string; data?: Uint8Array<ArrayBuffer> }
  resourceAddress: string
  sessionId?: string
  t: (key: 'audioTitle' | 'videoTitle' | 'loading' | 'failed' | 'unsupported') => string
}): ReactNode {
  const path = useMemo(() => resourceAddress.replaceAll('\\\\', '/'), [resourceAddress])
  const kind = useMemo(() => mediaKindOf(path), [path])
  const data = content.kind === 'bytes' ? content.data : undefined
  const [source, setSource] = useState<{ url: string }>()
  const [zoom, setZoom] = useState(1)

  useEffect(() => {
    if (data === undefined || kind === undefined) return
    let url: string | undefined
    try {
      url = URL.createObjectURL(new Blob([data], { type: kind === 'video' ? 'video/mp4' : 'audio/mpeg' }))
      setSource({ url })
    } catch {
      setSource(undefined)
    }
    return () => {
      if (url !== undefined) URL.revokeObjectURL(url)
    }
  }, [data, kind])

  // 触控板捏合与 Ctrl+滚轮都带 ctrlKey；普通滚轮保持原生滚动。
  const onWheel = (event: ReactWheelEvent<HTMLDivElement>): void => {
    if (kind !== 'video' || (!event.ctrlKey && !event.metaKey)) return
    event.preventDefault()
    setZoom(at => Math.min(4, Math.max(1, at * (event.deltaY < 0 ? 1.1 : 1 / 1.1))))
  }

  const swallowContextMenu = (event: ReactMouseEvent): void => {
    event.preventDefault()
    event.stopPropagation()
  }

  if (kind === undefined || data === undefined) {
    return <p className={css.status} role="alert">{t('unsupported')}</p>
  }
  if (source === undefined) {
    return <LoadingIndicator className={css.status} label={t('loading')} />
  }
  if (kind === 'video') {
    return (
      <div
        className={css.videoShell}
        onWheel={onWheel}
        onContextMenu={swallowContextMenu}
        data-zoom={zoom > 1 ? 'true' : undefined}
      >
        <video
          className={css.video}
          style={zoom > 1 ? { width: `${(zoom * 100).toFixed(1)}%` } : undefined}
          src={source.url}
          controls
          autoPlay={false}
        />
      </div>
    )
  }
  return <audio className={css.audio} src={source.url} controls onContextMenu={swallowContextMenu} />
}
