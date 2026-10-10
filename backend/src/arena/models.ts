/**
 * Pure helpers for editing the model list from the dashboard. No I/O: the
 * route layer persists the result and hands it to the engine.
 */
import { ModelSchema, type ArenaModelConfig } from './config.js'

export interface ModelEdit {
  /** Name of the model being edited; omit to add a new one. */
  originalName?: string
  model: Record<string, unknown>
}

const NAME_RE = /^[^<>"'`\\]{1,40}$/
const ENV_RE = /^[A-Z][A-Z0-9_]*$/

/**
 * Validate and apply an add/edit. Renaming is not allowed: the name is the
 * account key, so a rename would silently start a fresh $10k account and
 * orphan the old one's history.
 */
export function upsertModel(models: ArenaModelConfig[], edit: ModelEdit): ArenaModelConfig[] {
  const parsed = ModelSchema.safeParse(edit.model)
  if (!parsed.success) {
    throw new Error('参数不合法：' + parsed.error.issues.map((i) => `${i.path.join('.')} ${i.message}`).join('；'))
  }
  const m = parsed.data
  m.name = m.name.trim()
  m.model = m.model.trim()
  m.baseUrl = m.baseUrl.trim().replace(/\/+$/, '')
  if (!NAME_RE.test(m.name)) throw new Error('名称需为 1–40 个字符，且不能包含引号、尖括号或反斜杠')
  if (!ENV_RE.test(m.apiKeyEnv)) throw new Error('Key 环境变量名只能用大写字母、数字和下划线')
  if (!/^https?:\/\//.test(m.baseUrl)) throw new Error('baseUrl 必须以 http:// 或 https:// 开头')

  if (edit.originalName === undefined) {
    if (models.some((x) => x.name === m.name)) throw new Error(`已存在名为「${m.name}」的模型`)
    return [...models, m]
  }
  const idx = models.findIndex((x) => x.name === edit.originalName)
  if (idx < 0) throw new Error(`找不到模型「${edit.originalName}」`)
  if (m.name !== edit.originalName) throw new Error('不能改名（名称对应账户和历史数据）。如需新名称，请新增一个模型')
  if (m.strategy !== models[idx]!.strategy) throw new Error('策略版本不能在原账户上修改，请复制为新版本账户并行比较')
  const out = [...models]
  out[idx] = m
  return out
}

export function setModelEnabled(models: ArenaModelConfig[], name: string, enabled: boolean): ArenaModelConfig[] {
  const idx = models.findIndex((x) => x.name === name)
  if (idx < 0) throw new Error(`找不到模型「${name}」`)
  const out = [...models]
  out[idx] = { ...out[idx]!, enabled }
  return out
}
