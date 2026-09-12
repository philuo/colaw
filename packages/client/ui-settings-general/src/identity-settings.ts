/**
 * The 身份预设 (identity preset) feature shared between the settings host
 * half (namespace registration + system-prompt section) and the General
 * settings row (namespace constants + copy defaults).
 */

import z from '@deepseek-ai/schemastery'

/** Durable settings namespace for the identity preset. */
export const IDENTITY_SETTINGS_NAMESPACE = 'ui-identity'

/** The settings field carrying the AI persona line. */
export const IDENTITY_FIELD_AI = 'aiPersona'

/** The settings field carrying the user persona line. */
export const IDENTITY_FIELD_USER = 'userPersona'

/** Factory default for the AI persona; the user edits it in General settings. */
export const DEFAULT_AI_PERSONA = '严谨、细心、程序员冲哥'

/** Factory default for the user persona. */
export const DEFAULT_USER_PERSONA = '山东济南律师（琪琪）'

/** The persisted identity section. Both fields carry schema defaults. */
export interface IdentitySettings {
  aiPersona?: string
  userPersona?: string
}

export const IdentitySettingsSchema: z<IdentitySettings> = z.object({
  aiPersona: z.string().default(DEFAULT_AI_PERSONA),
  userPersona: z.string().default(DEFAULT_USER_PERSONA),
})

/** The system-prompt section the identity preset renders into. */
export const IDENTITY_SECTION = 'identity:preset'

/** Placement directly after the deployment persona prefix. */
export const IDENTITY_SECTION_ORDER = 1

/**
 * Render the identity preset as prompt prose. Empty on both sides drops the
 * section entirely, which is how the user turns the feature off.
 * @param value - the effective settings value.
 * @returns the section text, or the empty string.
 */
export function identitySectionText(value: IdentitySettings | undefined): string {
  const ai = (value?.aiPersona ?? DEFAULT_AI_PERSONA).trim()
  const user = (value?.userPersona ?? DEFAULT_USER_PERSONA).trim()
  if (ai === '' && user === '') return ''
  return [
    '## 身份预设',
    ai === '' ? undefined : `- AI 助手人设：${ai}`,
    user === '' ? undefined : `- 当前用户人设：${user}`,
  ].filter(line => line !== undefined).join('\n')
}
