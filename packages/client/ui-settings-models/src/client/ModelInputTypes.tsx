/**
 * The per-model input-type checkboxes: the four request modalities a model
 * may accept, edited as one explicit declaration. Text is the floor every
 * conversation needs, so it is pinned; the other three are the user's claim
 * about the endpoint, and any change materializes the whole array on the row
 * — an undeclared row keeps inheriting (the adapter's catalog, else the
 * route default), which is why the group shows that inherited state rather
 * than pretending the row owns it.
 */

import type { ReactNode } from 'react'
import type { en } from './locales.ts'
import styles from './ModelsSection.module.css'

/** Every modality a row may declare, in the stored order. */
const MODALITIES = ['text', 'image', 'video', 'file'] as const

/** One modality key. */
type Modality = (typeof MODALITIES)[number]

/** The copy key per modality. */
const MODALITY_LABEL: Readonly<Record<Modality, keyof typeof en>> = {
  text: 'inputText',
  image: 'inputImage',
  video: 'inputVideo',
  file: 'inputFile',
}

/** Props of {@link ModelInputTypes}. */
export interface ModelInputTypesProps {
  /**
   * The row's own stored array, or `undefined` when it declares nothing and
   * inherits.
   */
  declared: readonly string[] | undefined
  /** The host-resolved effective array shown when the row declares nothing. */
  resolved: readonly string[] | undefined
  /** Section copy. */
  t: (key: keyof typeof en) => string
  /** Disable every control. */
  disabled: boolean
  /** Replace the row's declaration; always a full array including text. */
  onChange: (next: readonly string[]) => void
}

/**
 * Render the input-type group for one model row.
 * @param props - the declared and inherited state plus the write-through.
 * @returns the checkbox group.
 */
export function ModelInputTypes(props: ModelInputTypesProps): ReactNode {
  // What the checkboxes show: the row's declaration when it has one, else the
  // effective state the Host resolved (an adapter's catalog entry or route
  // default), else the text floor. A user change then writes the shown set
  // explicitly, so what was inherited stays true until the user says otherwise.
  const shown = props.declared ?? props.resolved ?? ['text']
  return (
    <div className={styles['inputTypes']} role="group" aria-label={props.t('inputTypes')}>
      <span className={styles['modelFieldLabel']}>{props.t('inputTypes')}</span>
      <div className={styles['inputTypeChecks']}>
        {MODALITIES.map((modality) => {
          const pinned = modality === 'text'
          return (
            <label key={modality} className={styles['inputTypeCheck']}>
              <input
                type="checkbox"
                checked={pinned || shown.includes(modality)}
                disabled={props.disabled || pinned}
                onChange={(event) => {
                  const next = MODALITIES
                    .filter(at => at === 'text' || (at === modality
                      ? event.target.checked
                      : shown.includes(at)))
                  props.onChange(next)
                }}
              />
              {props.t(MODALITY_LABEL[modality])}
            </label>
          )
        })}
      </div>
      {props.declared === undefined ? <p className={styles['inputTypesHint']}>{props.t('inputTypesHint')}</p> : null}
    </div>
  )
}
