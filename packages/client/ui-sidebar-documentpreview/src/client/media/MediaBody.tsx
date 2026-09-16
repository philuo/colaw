/** Native media playback for complete file bytes: video and audio elements. */
import { useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
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
 * player — no vendored codec stack; WKWebView decodes the system formats.
 * @param props - document bytes, resource identity, and locale.
 * @returns the player surface.
 */
export function MediaBody({ content, resourceAddress, t }: {
  content: { kind: string; data?: Uint8Array<ArrayBuffer> }
  resourceAddress: string
  sessionId?: string
  t: (key: 'title' | 'loading' | 'failed' | 'unsupported') => string
}): ReactNode {
  const path = useMemo(() => resourceAddress.replaceAll('\\\\', '/'), [resourceAddress])
  const kind = useMemo(() => mediaKindOf(path), [path])
  const data = content.kind === 'bytes' ? content.data : undefined
  const [source, setSource] = useState<{ url: string }>()

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

  if (kind === undefined || data === undefined) {
    return <p className={css.status} role="alert">{t('unsupported')}</p>
  }
  if (source === undefined) {
    return <LoadingIndicator className={css.status} label={t('loading')} />
  }
  return kind === 'video'
    ? <video className={`${css.media} ${css.video}`} src={source.url} controls autoPlay={false} />
    : <audio className={`${css.media} ${css.audio}`} src={source.url} controls />
}
