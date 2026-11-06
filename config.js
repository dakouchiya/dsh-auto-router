/**
 * Settings rows for this plugin, in the schema dialect the Settings form reads.
 *
 * Exported as `Config` from the published entry (the release build appends
 * `export { default as Config } from './config.js'`). There is no runtime
 * dependency here on purpose: the row must load even where the harness packages
 * are resolved by the host rather than by this package.
 *
 * Validation never throws and never rewrites the value. A rejected config would
 * take the plugin entry down at boot, and this plugin already normalizes its own
 * config inside `apply`; the schema exists so Settings can show the four common
 * switches, not to second-guess advanced YAML.
 */

const ROWS = {
  enabled: {
    type: 'boolean',
    meta: { default: true, description: '自动路由开关 / Toggle automatic routing' },
  },
  dryRun: {
    type: 'boolean',
    meta: { default: false, description: '演练模式：只记录决策，不切换模型 / Dry run: log decisions only' },
  },
  mode: {
    type: 'string',
    meta: { default: 'balanced', description: '倾向：economy | balanced | quality / Routing bias' },
  },
  logDecisions: {
    type: 'boolean',
    meta: { default: true, description: '把每轮决策写入 decisions.jsonl / Append each decision to a local log' },
  },
}

const SCHEMA = {
  uid: 1,
  refs: {
    1: ROWS.enabled,
    2: ROWS.dryRun,
    3: ROWS.mode,
    4: ROWS.logDecisions,
  },
}

export const Config = {
  ...SCHEMA,
  type: 'object',
  dict: ROWS,
  meta: { default: {} },
  toJSON() {
    return SCHEMA
  },
  '~standard': {
    version: 1,
    vendor: 'dsh-auto-router',
    validate(value) {
      return { value: value !== null && typeof value === 'object' ? value : {} }
    },
  },
}

export default Config
