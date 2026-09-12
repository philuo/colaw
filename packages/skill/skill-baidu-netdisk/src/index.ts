/**
 * Bundled 百度网盘 (Baidu Netdisk) skill provider.
 *
 * The skill body, reference documents, and the bdpan CLI installer scripts
 * ship as packaged assets from the upstream baidu-netdisk/bdpan-storage
 * repository (Apache-2.0), so the agent can guide the one-time CLI install
 * and login offline-of-any-registry and then run every netdisk operation the
 * CLI exposes. Operations stay scoped to `/apps/bdpan/` per the skill body.
 *
 * @module @deepseek-ai/dsh-skill-baidu-netdisk
 */

import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import {
  BUNDLED_SKILL_RANK,
  type SkillCandidate,
  type SkillDefinition,
  type SkillProvider,
} from '@deepseek-ai/dsh-skill'

const PROVIDER_NAME = 'baidu-netdisk'
const SKILL_BODY_URL = new URL('../assets/SKILL.md', import.meta.url)
const RESOURCE_BASE = {
  kind: 'directory',
  path: fileURLToPath(new URL('../assets/', import.meta.url)),
} as const
const INVOCATION = { modelInvocable: true, userInvocable: true } as const
const DESCRIPTION = '百度网盘(Baidu Drive)文件管理 — 上传、下载、转存、分享、搜索、移动、复制、重命名、创建文件夹。TRIGGER: 用户提及"百度网盘/bdpan/网盘/云盘/Baidu Drive"并涉及文件操作时使用。'
const CANDIDATE: SkillCandidate = {
  name: 'baidu-drive',
  description: DESCRIPTION,
  invocation: INVOCATION,
  provider: PROVIDER_NAME,
  source: 'bundled',
  resourceBase: RESOURCE_BASE,
  rank: BUNDLED_SKILL_RANK,
  locator: SKILL_BODY_URL,
}

const provider: SkillProvider = {
  name: PROVIDER_NAME,
  list: () => Promise.resolve([CANDIDATE]),
  async get(_candidate): Promise<SkillDefinition> {
    return {
      name: CANDIDATE.name,
      description: CANDIDATE.description,
      invocation: CANDIDATE.invocation,
      provider: CANDIDATE.provider,
      source: CANDIDATE.source,
      resourceBase: RESOURCE_BASE,
      content: await readFile(SKILL_BODY_URL, 'utf8'),
    }
  },
}

/** Cordis plugin name. */
export const name = 'skill-baidu-netdisk'
/** Service required by the bundled provider. */
export const inject = ['skills']

/** Register the bundled 百度网盘 provider on `ctx.skills`. */
export function apply(ctx: Context): void {
  ctx.skills.registerProvider(() => provider)
}
