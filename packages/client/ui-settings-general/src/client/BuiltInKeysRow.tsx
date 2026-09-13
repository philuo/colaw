/**
 * 内置服务密钥 (built-in service keys) row in the General settings section:
 * one password field per product-shipped cloud service — 北大法宝, 企查查,
 * Firecrawl, MinerU. Values write straight to the credentials domain under
 * fixed references (never settings.yaml, never the composition), mirroring
 * the AnySearch card's storage contract. The MCP-backed services re-read
 * their headers at the next app start; MinerU re-resolves per call and
 * applies immediately.
 */
import { useEffect, useState, type ReactNode } from 'react'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { CredentialInfo } from '@deepseek-ai/dsh-api-remotes/client'
import css from './IdentityRow.module.css'

/** Credential references the four built-in services resolve from. */
export const BUILT_IN_KEY_REFS = [
  { key: 'pkulaw', ref: 'PKULAW_API_KEY' },
  { key: 'qcc', ref: 'QCC_API_KEY' },
  { key: 'firecrawl', ref: 'FIRECRAWL_API_KEY' },
  { key: 'mineru', ref: 'MINERU_API_KEY' },
] as const

/** One built-in service's copy key. */
export type BuiltInKeyService = (typeof BUILT_IN_KEY_REFS)[number]['key']

/** Registration-side business face: the credentials operations this row performs. */
export interface BuiltInKeysRowInjected {
  /** Report one reference's configured/writable state, or undefined when refused. */
  describe(ref: string): Promise<CredentialInfo | undefined>
  /** Store the value; returns the refusal message, or undefined once stored. */
  store(ref: string, value: string): Promise<string | undefined>
}

/** Full component props: runtime share + locale seat + injected operations. */
export type BuiltInKeysRowComponentProps =
  PropsRuntime<'settings.general.item'> & PropsLocale<'settings'> & BuiltInKeysRowInjected

/**
 * Render the built-in service keys row.
 * @param props - composed slot props with the credentials operations.
 * @returns the row element tree.
 */
export function BuiltInKeysRow({ t, describe, store }: BuiltInKeysRowComponentProps): ReactNode {
  const [configured, setConfigured] = useState<Partial<Record<BuiltInKeyService, boolean>>>({})
  useEffect(() => {
    let stale = false
    for (const { key, ref } of BUILT_IN_KEY_REFS) {
      void describe(ref).then((info) => {
        if (!stale) setConfigured(current => ({ ...current, [key]: info?.configured === true }))
      })
    }
    return () => { stale = true }
  }, [describe])

  return (
    <div className={css.row} data-builtin-keys-row>
      <div className={css.rowText}>
        <div className={css.title}>{t('builtinKeys.title')}</div>
        <div className={css.desc}>{t('builtinKeys.description')}</div>
      </div>
      <div className={css.fields}>
        {BUILT_IN_KEY_REFS.map(({ key, ref }) => (
          <label key={key} className={css.field}>
            <span className={css.fieldLabel}>{t(`builtinKeys.${key}`)}</span>
            <input
              type="password"
              className={css.input}
              autoComplete="off"
              placeholder={configured[key] === true ? t('builtinKeys.configured') : t('builtinKeys.placeholder')}
              aria-label={t(`builtinKeys.${key}`)}
              onBlur={(event) => {
                const value = event.target.value.trim()
                if (value.length === 0) return
                void store(ref, value).then(() => {
                  event.target.value = ''
                  return describe(ref).then((info) => {
                    setConfigured(current => ({ ...current, [key]: info?.configured === true }))
                  })
                })
              }}
            />
          </label>
        ))}
      </div>
    </div>
  )
}
