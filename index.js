/**
 * @local/dsh-auto-router — Host-only DSH plugin.
 *
 * Picks a model + reasoning effort for each turn from what the turn actually asks:
 *
 * - `agent/pre-step` (waterfall) captures the user batch entering the turn and
 *   classifies it into one of four tiers (`lite` / `standard` / `deep` / `max`).
 * - `agent/request` (waterfall) replaces the frozen `LlmCallConfig` for that turn
 *   with the tier's provider/model/reasoningEffort after validating the route and
 *   the effort against the live adapter metadata.
 *
 * Every decision is appended to `<DSH_HOME>/auto-router/decisions.jsonl`, and a
 * `/route` command reports status, pins one tier for the current session, or
 * prints the model catalog with supported efforts.
 */

import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const TIERS = ['lite', 'standard', 'deep', 'max', 'ultra']

/** Chinese display names used in commands and logs. */
const TIER_LABEL = { lite: '轻量', standard: '中量', deep: '重量', max: '较深', ultra: '极深' }

/** Chinese tier names accepted after `#` so `#极深` works like `#ultra`. */
const TIER_CN = { 轻量: 'lite', 中量: 'standard', 重量: 'deep', 较深: 'max', 极深: 'ultra' }

/** PREFERENCE order used when the configured effort is not supported by a model. */
const EFFORT_LADDER = {
  lite: ['off', 'low', 'high', 'max'],
  standard: ['high', 'max', 'low', 'off'],
  deep: ['max', 'high', 'low', 'off'],
  max: ['high', 'max', 'low', 'off'],
  ultra: ['max', 'high', 'low', 'off'],
}

const MODE_PRESETS = {
  economy: { liteMaxChars: 40, deepMinChars: 800, maxMinChars: 4000 },
  balanced: { liteMaxChars: 14, deepMinChars: 400, maxMinChars: 1800 },
  quality: { liteMaxChars: 8, deepMinChars: 150, maxMinChars: 900 },
}

const DEFAULTS = {
  enabled: true,
  dryRun: false,
  mode: 'balanced',
  provider: '',
  tiers: {
    lite: { model: 'deepseek-flash', effort: 'off' },
    standard: { model: 'deepseek-flash', effort: 'high' },
    deep: { model: 'deepseek-flash', effort: 'max' },
    max: { model: 'deepseek-v4-pro', effort: 'high' },
    ultra: { model: 'deepseek-v4-pro', effort: 'max' },
  },
  rules: [
    { tier: 'max', any: ['彻底', '穷尽', '最全面', '认真思考', '深入思考', '仔细想', '多角度', 'thorough', 'exhaustive'] },
    { tier: 'lite', any: ['别思考', '不用思考', '别想太多', '快速回答', '简单说', '一句话', '简短回答'] },
  ],
  thresholds: {},
  classifier: {
    enabled: true,
    provider: '',
    model: 'deepseek-flash',
    effort: 'off',
    timeoutMs: 6000,
    maxInputChars: 3000,
    rejudgeOnError: true,
    rejudgeEverySteps: 5,
    maxRejudgesPerTurn: 8,
  },
  approval: {
    enabled: true,
    windowMs: 15000,
    modelPattern: 'pro',
    skipWhenPinned: false,
  },
  history: {
    maxBytes: 2 * 1024 * 1024,
  },
  logDecisions: true,
  logDir: '',
  catalogTtlMs: 600_000,
}

/** Signals that the turn asks for real reasoning work. */
const DEEP_SIGNAL = /(重构|架构|排查|调试|迁移|性能|并发|算法|安全|优化|分析|为什么|原理|实现|方案|评审|设计|推导|证明|review|debug|refactor|architect|optimi[sz]e|migrat|analy[sz]e|benchmark|profil(e|ing))/iu

/** Signals that the turn carries code, paths, commands, or an error report. */
const CODE_SIGNAL = /(```|`[^`\n]+`|\b[\w./-]+\.(?:ts|tsx|js|jsx|mjs|cjs|py|rs|go|java|kt|cs|cpp|c|h|json|ya?ml|toml|sql|sh|ps1)\b|\b(?:function|class|import|def|SELECT|npm|pnpm|git|docker|curl)\b|Traceback|(?:Type|Reference|Syntax|Range|Value)Error)/u

/** Signals that the turn is engineering work rather than a quick question. */
const DEV_SIGNAL = /(插件|代码|脚本|函数|接口|部署|编译|报错|异常|仓库|提交|修复|重构|实现|开发|接入|调试|单元测试|依赖|版本兼容|plugin|script|codebase|deploy|compile|refactor|implement|migrate)/iu

/** Action verbs that turn a topic mention into an actual work request. */
const ACTION_SIGNAL = /(写|改|做|加|删|实现|开发|接入|部署|调试|修复|重构|优化|配置|安装|导出|生成|搭建|迁移|排查|帮我|请帮|需要你)/u

/** Signals that the turn explicitly wants the deepest treatment. */
const MAX_SIGNAL = /(彻底|穷尽|最全面|所有边界|边界情况|极端情况|认真思考|深入思考|多角度|务必|详尽|逐个|thorough|exhaustive|edge cases?|as much detail)/iu

/** Greetings, acknowledgements, and one-liners that never need thinking. */
const LITE_SIGNAL = /^(?:你好|您好|hi|hello|hey|在吗|在不在|谢谢|多谢|好的|好|嗯|哦|ok|okay|收到|继续|测试|test|ping|嗨|早|晚安|哈+|哈哈+)[\s!！。.,，?？~～]*$/iu

const MAX_LOG_BYTES = 2 * 1024 * 1024

/** Accumulate the router's own LLM usage across one turn's calls. */
function addUsage(acc, usage) {
  if (!usage) return acc ?? { input: 0, output: 0 }
  const current = acc ?? { input: 0, output: 0 }
  return {
    input: (current.input ?? 0) + (usage.inputTokens ?? 0),
    output: (current.output ?? 0) + (usage.outputTokens ?? 0),
  }
}

/** Normalize a TokenUsage to the {input, output} shape the client renders. */
function normalizeUsage(usage) {
  if (!usage) return null
  return { input: usage.inputTokens ?? 0, output: usage.outputTokens ?? 0 }
}

/**
 * System prompt of the routing classifier. It reads the turn the way a person
 * would and answers with one tier name; no keyword table is involved.
 */
function classifierSystemPrompt(mode) {
  const bias = mode === 'economy'
    ? '倾向：尽量省成本，能用低档解决就不要升档。'
    : mode === 'quality'
      ? '倾向：质量优先，复杂或没把握的问题直接给高档，必要时 ultra。'
      : '倾向：在成本与质量之间平衡。'
  return [
    '你是 DeepSeek Harness 的模型路由分类器。判断用户这一轮的问题，用哪个档位处理最合适：既不要为简单问题浪费算力，也不要让复杂问题因为省而做砸。并说明原因。',
    '',
    '档位定义（从低到高）：',
    '- lite：寒暄、确认、闲聊、致谢；一句话能答完的事实；不需要推理的简单格式转换或换算。',
    '- standard：常规知识问答、信息查询、简单翻译/改写/总结；单个小改动；按步骤照做即可。',
    '- deep：需要多步推理、调试排错、方案设计、代码实现、长文分析、权衡取舍。',
    '- max：很难、要求高可靠性、大规模重构或迁移、复杂疑难问题。',
    '- ultra：只有用户明确要求“极限/不惜成本/最认真”，或任务确实属于极端疑难时才用；它是最高档、最贵，不要主动升到它。',
    '',
    '判断依据是「解决这个问题需要多少思考与验证」，不是话题是否高深，也不要被单个词带偏。拿不准时选 standard；明显要动手改代码、查故障、做设计时选 deep。',
    bias,
    '',
    '示例：',
    '"你好" -> lite',
    '"3 加 5 等于几" -> lite',
    '"把这句话翻成英文：今天天气不错" -> standard',
    '"HTTP 和 HTTPS 有什么区别" -> standard',
    '"线上服务每隔几小时就超时一次，帮我看看可能出在哪" -> deep',
    '"帮我写个脚本，把这个目录下的图片按日期重命名" -> deep',
    '"把整个项目从 webpack 迁到 vite，要求零回归" -> max',
    '"不惜成本、穷尽所有边界，给出最严谨的证明" -> ultra',
    '',
    '输出一行：<lite|standard|deep|max|ultra>：<不超过 20 字的原因>。',
    '例如：deep：要改代码并查故障，需要多步推理',
  ].join('\n')
}

/** Read an explicit `#lite` / `#deep` style directive at the start of the text. */
function readDirective(text) {
  const trimmed = text.trim()
  if (!trimmed.startsWith('#')) return null
  const word = (trimmed.slice(1).split(/\s+/u)[0] ?? '').toLowerCase()
  if (TIERS.includes(word)) return word
  return TIER_CN[word] ?? null
}

/** Parse one tier name out of a model answer, tolerating punctuation and Chinese words. */
function parseTier(text) {
  if (typeof text !== 'string' || text === '') return null
  const match = /\b(lite|standard|deep|max|ultra)\b/iu.exec(text)
  if (match) return match[1].toLowerCase()
  if (text.includes('极深') || text.includes('极强') || text.includes('慎用') || text.includes('极限')) return 'ultra'
  if (text.includes('较深') || text.includes('最强')) return 'max'
  if (text.includes('重量')) return 'deep'
  if (text.includes('中量') || text.includes('标准')) return 'standard'
  if (text.includes('深入') || text.includes('深')) return 'deep'
  if (text.includes('极')) return 'max'
  if (text.includes('轻')) return 'lite'
  return null
}

/**
 * System prompt of the mid-turn supervisor. It is not asked to classify the task
 * from scratch; it reads what has actually happened and says whether to move.
 */
function reJudgeSystemPrompt() {
  return [
    '你是运行中的模型路由监督员。判断当前这一轮是否需要调整档位，并说明原因。',
    '- up：当前档位明显不够，任务已经或正在失败，或比初判更难。',
    '- down：进行得很顺利、任务比初判更简单，当前档位偏高，可以省。',
    '- hold：当前档位合适，不需要动。',
    '',
    '只看已经发生的事实判断，不要为了换而换；一次只建议升或降一档。',
    '输出一行：<up|down|hold>：<不超过 20 字的原因>。',
    '例如：down：进展顺利且无报错，可降档省成本',
  ].join('\n')
}

/** Parse the supervisor's verdict into an action, or null when it is unreadable. */
function parseAction(text) {
  if (typeof text !== 'string' || text === '') return null
  const match = /\b(up|down|hold|raise|lower|keep)\b/iu.exec(text)
  if (match) {
    const word = match[1].toLowerCase()
    if (word === 'raise') return 'up'
    if (word === 'lower') return 'down'
    if (word === 'keep') return 'hold'
    return word
  }
  if (text.includes('升')) return 'up'
  if (text.includes('降')) return 'down'
  if (text.includes('保持') || text.includes('不变')) return 'hold'
  return null
}

/** Split a supervisor answer into its action and the short reason after it. */
function parseRejudge(text) {
  if (typeof text !== 'string' || text === '') return { action: null, reason: '' }
  const action = parseAction(text)
  const reason = text
    .replace(/\b(up|down|hold|raise|lower|keep)\b/iu, '')
    .replace(/^[\s:：,，。.;；、\-]+|[\s:：,，。.;；、\-]+$/gu, '')
    .trim()
    .slice(0, 60)
  return { action, reason }
}

/** Compile the configured pro-model pattern, falling back to a plain substring. */
function safeModelPattern(pattern) {
  try {
    return new RegExp(pattern, 'i')
  } catch {
    return /pro/i
  }
}

/** Split a classifier answer into its tier and the short reason after it. */
function parseClassify(text) {
  if (typeof text !== 'string' || text === '') return { tier: null, reason: '' }
  const tier = parseTier(text)
  const reason = text
    .replace(/\b(lite|standard|deep|max|ultra)\b/iu, '')
    .replace(/^[\s:：,，。.;；、\-]+|[\s:：,，。.;；、\-]+$/gu, '')
    .trim()
    .slice(0, 60)
  return { tier, reason }
}

/** Normalize a user-authored config object over the built-in defaults. */
function normalizeConfig(raw) {
  const source = raw && typeof raw === 'object' ? raw : {}
  const tiers = {}
  for (const tier of TIERS) {
    const given = source.tiers && typeof source.tiers === 'object' ? source.tiers[tier] : undefined
    const fallback = DEFAULTS.tiers[tier]
    tiers[tier] = {
      provider: typeof given?.provider === 'string' && given.provider ? given.provider : '',
      model: typeof given?.model === 'string' && given.model ? given.model : fallback.model,
      effort: typeof given?.effort === 'string' ? given.effort.toLowerCase() : fallback.effort,
    }
  }
  const mode = typeof source.mode === 'string' && MODE_PRESETS[source.mode] ? source.mode : DEFAULTS.mode
  const rules = Array.isArray(source.rules) ? source.rules.filter((rule) => rule && typeof rule === 'object') : DEFAULTS.rules
  return {
    enabled: source.enabled !== false,
    dryRun: source.dryRun === true,
    mode,
    provider: typeof source.provider === 'string' ? source.provider : '',
    tiers,
    rules,
    thresholds: { ...MODE_PRESETS[mode], ...(source.thresholds && typeof source.thresholds === 'object' ? source.thresholds : {}) },
    classifier: {
      enabled: source.classifier?.enabled !== false,
      provider: typeof source.classifier?.provider === 'string' ? source.classifier.provider : '',
      model: typeof source.classifier?.model === 'string' && source.classifier.model ? source.classifier.model : DEFAULTS.classifier.model,
      effort: typeof source.classifier?.effort === 'string' ? source.classifier.effort.toLowerCase() : DEFAULTS.classifier.effort,
      timeoutMs: Number.isFinite(source.classifier?.timeoutMs) ? source.classifier.timeoutMs : DEFAULTS.classifier.timeoutMs,
      maxInputChars: Number.isFinite(source.classifier?.maxInputChars) ? source.classifier.maxInputChars : DEFAULTS.classifier.maxInputChars,
      rejudgeOnError: source.classifier?.rejudgeOnError !== false,
      rejudgeEverySteps: Number.isFinite(source.classifier?.rejudgeEverySteps) ? source.classifier.rejudgeEverySteps : DEFAULTS.classifier.rejudgeEverySteps,
      maxRejudgesPerTurn: Number.isFinite(source.classifier?.maxRejudgesPerTurn) ? source.classifier.maxRejudgesPerTurn : DEFAULTS.classifier.maxRejudgesPerTurn,
    },
    approval: {
      enabled: source.approval?.enabled !== false,
      windowMs: Number.isFinite(source.approval?.windowMs) ? Math.max(1000, source.approval.windowMs) : DEFAULTS.approval.windowMs,
      modelPattern: typeof source.approval?.modelPattern === 'string' && source.approval.modelPattern ? source.approval.modelPattern : DEFAULTS.approval.modelPattern,
      skipWhenPinned: source.approval?.skipWhenPinned === true,
    },
    history: {
      maxBytes: Number.isFinite(source.history?.maxBytes) ? Math.max(64 * 1024, source.history.maxBytes) : DEFAULTS.history.maxBytes,
    },
    logDecisions: source.logDecisions !== false,
    logDir: typeof source.logDir === 'string' ? source.logDir : '',
    catalogTtlMs: Number.isFinite(source.catalogTtlMs) ? source.catalogTtlMs : DEFAULTS.catalogTtlMs,
  }
}

/**
 * Text prefixes of user-role messages the harness injects around the human text
 * (runtime snapshot, skill catalog, subagent wrapper). They must not be classified:
 * they are long, contain engineering vocabulary, and would force every turn to deep.
 */
const INJECTED_PREFIXES = [
  'Current runtime context.',
  '<system-reminder>',
  'Time sampled while preparing',
  'Your parent agent id is',
  'Your task is',
  'You are a delegated subagent',
  'Delegation depth for',
]

/** Whether one user-role text block is harness-injected boilerplate. */
function isInjectedText(text) {
  const head = text.replace(/^\s+/u, '')
  return INJECTED_PREFIXES.some((prefix) => head.startsWith(prefix))
}

/** Concatenated human-authored text of one user batch; attachments are counted separately. */
function readBatch(messages) {
  const texts = []
  let hasImage = false
  let hasFile = false
  for (const message of messages ?? []) {
    // Only human input counts: runtime snapshots, skill catalogs, and time
    // contexts carry their own source kinds and are skipped entirely.
    if (message?.source?.kind !== 'user') continue
    for (const block of message?.content ?? []) {
      if (block?.type === 'text' && typeof block.text === 'string') {
        if (!isInjectedText(block.text)) texts.push(block.text)
      } else if (block?.type === 'image') hasImage = true
      else if (block?.type === 'file') hasFile = true
    }
  }
  return { text: texts.join('\n').trim(), hasImage, hasFile }
}

/** Compile one rule's optional regex, remembering failures instead of throwing per turn. */
function ruleRegex(rule) {
  if (typeof rule.regex !== 'string' || rule.regex === '') return null
  try {
    return new RegExp(rule.regex, 'iu')
  } catch {
    return null
  }
}

/** Classify one turn's text into a tier, or return null when the message says nothing useful. */
function classify(text, config, pinned) {
  if (pinned) return { tier: pinned, reason: 'pinned' }
  const trimmed = text.trim()
  if (trimmed === '') return null

  const directive = readDirective(trimmed)
  if (directive) return { tier: directive, reason: 'directive' }

  for (const rule of config.rules) {
    const tier = typeof rule.tier === 'string' ? rule.tier.toLowerCase() : ''
    if (!TIERS.includes(tier)) continue
    const regex = ruleRegex(rule)
    if (regex && regex.test(trimmed)) return { tier, reason: 'rule:regex' }
    const keywords = Array.isArray(rule.any) ? rule.any : typeof rule.any === 'string' ? [rule.any] : []
    const lowered = trimmed.toLowerCase()
    if (keywords.some((keyword) => typeof keyword === 'string' && keyword !== '' && lowered.includes(keyword.toLowerCase()))) {
      return { tier, reason: 'rule:' + tier }
    }
  }

  const length = trimmed.length
  const thresholds = config.thresholds
  const codeish = CODE_SIGNAL.test(trimmed)
  const questions = (trimmed.match(/[?？]/g) ?? []).length
  const numbered = (trimmed.match(/^\s*(?:\d+[.)、]|[-*])\s+/gm) ?? []).length

  if (MAX_SIGNAL.test(trimmed) && length >= 30) return { tier: 'max', reason: 'max-signal' }
  if (length >= thresholds.maxMinChars) return { tier: 'max', reason: 'length' }
  if (DEEP_SIGNAL.test(trimmed) && length >= 12) return { tier: 'deep', reason: 'deep-signal' }
  if (DEV_SIGNAL.test(trimmed) && ACTION_SIGNAL.test(trimmed) && length >= 16) return { tier: 'deep', reason: 'dev-request' }
  if (codeish && length >= 40) return { tier: 'deep', reason: 'code' }
  if (length >= thresholds.deepMinChars) return { tier: 'deep', reason: 'length' }
  if (numbered >= 3 || questions >= 3) return { tier: 'deep', reason: 'multi-part' }
  if (length <= thresholds.liteMaxChars && !codeish && LITE_SIGNAL.test(trimmed)) return { tier: 'lite', reason: 'small-talk' }
  if (length <= 6 && !codeish) return { tier: 'lite', reason: 'tiny' }
  return { tier: 'standard', reason: 'default' }
}

/** Pick the supported effort closest to the tier's preference ladder. */
function pickEffort(preferred, ladder, efforts, defaultEffort) {
  if (preferred && efforts.includes(preferred)) return preferred
  for (const candidate of ladder) if (efforts.includes(candidate)) return candidate
  if (defaultEffort && efforts.includes(defaultEffort)) return defaultEffort
  return efforts[0]
}

/** Create the routing runtime bound to one plugin context and its normalized config. */
function createRouter(ctx, config) {
  const decisions = new Map()
  const pins = new Map()
  const recent = new Map()
  const lastTurns = new Map()
  const turnLogs = new Map()
  const infoCache = new Map()
  const approvals = new Map()
  const proModelRe = safeModelPattern(config.approval.modelPattern)
  let logFile

  const home = process.env.DSH_HOME
    || (process.env.DSH_PROFILE_DIR ? join(process.env.DSH_PROFILE_DIR, '..', '..') : join(homedir(), '.dsh'))
  const logDir = config.logDir || join(home, 'auto-router')
  const turnsActive = join(logDir, 'turns.jsonl')
  const turnsOlder = join(logDir, 'turns.1.jsonl')
  const archiveDir = join(logDir, 'archive')

  /** Read the two active turn files back into memory (archives stay on disk). */
  function loadActiveTurns() {
    for (const file of [turnsActive, turnsOlder]) {
      try {
        if (!existsSync(file)) continue
        for (const line of readFileSync(file, 'utf8').split('\n')) {
          if (!line) continue
          try {
            const entry = JSON.parse(line)
            if (!entry || !entry.agent || !entry.record) continue
            const list = turnLogs.get(entry.agent) ?? []
            const index = list.findIndex((item) => item.turn === entry.record.turn)
            if (index >= 0) continue
            list.push(entry.record)
            turnLogs.set(entry.agent, list.slice(-200))
          } catch {
            /* skip a broken line */
          }
        }
      } catch {
        /* unreadable file, keep going */
      }
    }
  }

  /** Roll `turns.jsonl` into `turns.1.jsonl`, archiving the file it replaces. */
  function rotateTurns(incomingBytes) {
    try {
      const size = existsSync(turnsActive) ? statSync(turnsActive).size : 0
      if (size === 0 || size + incomingBytes <= config.history.maxBytes) return
      mkdirSync(archiveDir, { recursive: true })
      if (existsSync(turnsOlder)) {
        const stamp = new Date().toISOString().replace(/[:.]/gu, '-')
        renameSync(turnsOlder, join(archiveDir, 'turns-' + stamp + '.jsonl'))
      }
      renameSync(turnsActive, turnsOlder)
    } catch {
      /* rotation is best effort */
    }
  }

  /** Append one turn record, rotating both active files when the size limit is hit. */
  function appendTurnRecord(agent, record) {
    try {
      const line = JSON.stringify({ agent, record }) + '\n'
      rotateTurns(Buffer.byteLength(line, 'utf8'))
      appendFileSync(turnsActive, line, 'utf8')
    } catch {
      /* history is best effort */
    }
  }

  /** Read archived turn records on demand; startup never touches archives. */
  function readArchivedTurns(limit) {
    try {
      if (!existsSync(archiveDir)) return []
      const files = readdirSync(archiveDir).filter((name) => name.endsWith('.jsonl')).sort().reverse()
      const records = []
      for (const name of files) {
        try {
          for (const line of readFileSync(join(archiveDir, name), 'utf8').split('\n')) {
            if (!line) continue
            try {
              const entry = JSON.parse(line)
              if (entry && entry.record) records.push(entry.record)
            } catch {
              /* skip a broken line */
            }
          }
        } catch {
          /* unreadable archive */
        }
        if (records.length >= limit * 3) break
      }
      return records.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0)).slice(0, limit)
    } catch {
      return []
    }
  }

  loadActiveTurns()

  /** Append one decision to the durable JSONL trace, rotating a runaway file. */
  function trace(record) {
    if (!config.logDecisions) return
    try {
      mkdirSync(logDir, { recursive: true })
      const file = logFile ?? (logFile = join(logDir, 'decisions.jsonl'))
      try {
        if (statSync(file).size > MAX_LOG_BYTES) renameSync(file, file + '.1')
      } catch {
        /* first write */
      }
      appendFileSync(file, JSON.stringify({ at: Date.now(), ...record }) + '\n', 'utf8')
    } catch (error) {
      ctx.logger?.warn?.('[auto-router] cannot write decision log: %o', error)
    }
  }

  /** Model metadata from the live adapter, cached per provider/model. */
  async function resolveInfo(llm, provider, model) {
    const key = provider + '\u0000' + model
    const cached = infoCache.get(key)
    if (cached && Date.now() - cached.at < config.catalogTtlMs) return cached.value
    let value = null
    try {
      const info = await llm.resolveModelInfo(provider, model)
      value = {
        efforts: Array.isArray(info?.reasoning?.efforts)
          ? info.reasoning.efforts.map((effort) => String(effort.id))
          : null,
        defaultEffort: info?.reasoning?.defaultEffort === undefined ? undefined : String(info.reasoning.defaultEffort),
      }
    } catch (error) {
      value = { error: error instanceof Error ? error.message : String(error), efforts: null }
    }
    infoCache.set(key, { at: Date.now(), value })
    return value
  }

  /** Resolve one tier into a concrete route, falling back to the original config. */
  async function resolveTarget(llm, tier, base) {
    const spec = config.tiers[tier] ?? config.tiers.standard
    const provider = spec.provider || config.provider || base.provider
    const model = spec.model || base.model
    const info = await resolveInfo(llm, provider, model)
    // A route that cannot even be resolved must not be dispatched: keep the original.
    if (!info || info.error) return null
    if (info.efforts === null) {
      return { provider, model, reasoningEffort: undefined, degraded: 'model-has-no-reasoning' }
    }
    const effort = pickEffort(spec.effort, EFFORT_LADDER[tier] ?? EFFORT_LADDER.standard, info.efforts, info.defaultEffort)
    return { provider, model, reasoningEffort: effort }
  }

  /**
   * Ask the human before a turn moves onto a pro model. Resolves true only when
   * the user clicks accept inside the 30 s window; timeout and decline both mean
   * "stay where you are".
   */
  /** Resolve which configured tier a concrete model/effort matches. */
  function tierForRoute(providerId, modelId, effort) {
    for (const tier of TIERS) {
      const spec = config.tiers[tier]
      if (!spec || !spec.model || spec.model !== modelId) continue
      if ((spec.effort ?? null) !== (effort ?? null)) continue
      if (spec.provider && providerId && spec.provider !== providerId) continue
      return tier
    }
    return null
  }

  function requestProApproval(state, tier, model, reason, signal) {
    return new Promise((resolve) => {
      if (state.proDenied) return resolve(false)
      if (state.proApproved) return resolve(true)
      const id = 'apr-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8)
      const deadline = Date.now() + config.approval.windowMs
      const entry = { id, session: state.agentId, tier, model, reason, deadline, timer: null, settle: null }
      entry.settle = (accept) => {
        if (!approvals.has(id)) return
        approvals.delete(id)
        clearTimeout(entry.timer)
        if (accept === true) state.proApproved = true
        else state.proDenied = true
        resolve(accept === true)
      }
      entry.timer = setTimeout(() => entry.settle(false), config.approval.windowMs)
      approvals.set(id, entry)
      if (signal) {
        if (signal.aborted) entry.settle(false)
        else signal.addEventListener('abort', () => entry.settle(false), { once: true })
      }
      trace({ kind: 'pro-approval', agent: state.agentId, turn: state.turn, tier, model, reason, deadline })
    })
  }

  /** Describe the whole catalog for `/route catalog` and for the activation trace. */
  async function catalog(llm) {
    const providers = await llm.listProviders()
    const lines = []
    const data = {}
    for (const provider of providers) {
      let models = []
      try {
        models = await llm.listModels(provider.id)
      } catch (error) {
        lines.push(`${provider.id}: <listModels failed: ${error instanceof Error ? error.message : String(error)}>`)
        continue
      }
      data[provider.id] = []
      for (const model of models) {
        let efforts = '?'
        try {
          const info = await llm.resolveModelInfo(provider.id, model.id)
          const ids = Array.isArray(info?.reasoning?.efforts) ? info.reasoning.efforts.map((effort) => String(effort.id)) : []
          efforts = ids.length === 0 ? '-' : ids.join('/')
        } catch {
          efforts = '!'
        }
        data[provider.id].push({ model: model.id, efforts })
        lines.push(`${provider.id} / ${model.id}  [${efforts}]`)
      }
    }
    return { lines, data }
  }

  /** Move one live turn to another tier and keep a visible trail of every change. */
  function changeTier(state, tier, cause, reason, usage) {
    if (TIERS.indexOf(tier) === TIERS.indexOf(state.tier)) return false
    state.tier = tier
    state.updatedAt = Date.now()
    state.history = [...(state.history ?? []), { at: Date.now(), tier, cause, reason, usage: normalizeUsage(usage) }].slice(-8)
    trace({ kind: 'tier-change', agent: state.agentId, turn: state.turn, tier, cause, reason })
    return true
  }

  /** One cheap classifier call; returns the raw text, or null on failure/timeout. */
  async function runClassifier(system, prompt, maxTokens, parentSignal) {
    const llm = ctx.get('llm')
    if (!llm) return null
    const spec = config.classifier
    const selection = ctx.get('agentDefaultModel')?.currentSelection?.()
    const provider = spec.provider || config.provider || selection?.provider
    const model = spec.model || selection?.model
    if (!provider || !model) return null

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(new Error('classifier timeout')), spec.timeoutMs)
    const signal = parentSignal ? AbortSignal.any([controller.signal, parentSignal]) : controller.signal
    try {
      let output = ''
      let usage = null
      const stream = llm.stream({
        provider,
        model,
        ...(spec.effort ? { reasoningEffort: spec.effort } : {}),
        temperature: 0,
        maxTokens,
        system,
        messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
        signal,
      })
      for await (const chunk of stream) {
        if (chunk.type === 'text-delta') output += chunk.text
        else if (chunk.type === 'usage') usage = chunk.usage ?? usage
        else if (chunk.type === 'finish') break
      }
      return { text: output, usage }
    } catch (error) {
      ctx.logger?.warn?.('[auto-router] classifier call failed: %o', error)
      return null
    } finally {
      clearTimeout(timer)
    }
  }

  /** Ask a cheap model what this turn needs; null means the structural fallback decides. */
  async function classifyWithModel(text, recentTexts, lastTurn, parentSignal) {
    const context = recentTexts.length > 0
      ? '最近两轮用户消息（只用于理解指代，不要回答它们）：\n' + recentTexts.map((item) => '- ' + item).join('\n') + '\n\n'
      : ''
    const previous = lastTurn
      ? `上一轮情况：档位 ${lastTurn.tier}，${lastTurn.steps} 步完成，工具调用 ${lastTurn.toolCalls} 次，报错 ${lastTurn.toolErrors} 次。`
        + (TIERS.indexOf(lastTurn.tier) > 1 && lastTurn.steps <= 2 && lastTurn.toolCalls === 0
          ? '上一轮被判得偏高，这一轮如果没有更难的新迹象，可以降一档。\n\n'
          : '\n\n')
      : ''
    const prompt = context
      + previous
      + '本轮用户消息：\n"""\n' + text.slice(0, config.classifier.maxInputChars) + '\n"""\n\n档位：'
    const result = await runClassifier(classifierSystemPrompt(config.mode), prompt, 32, parentSignal)
    const parsed = parseClassify(result && result.text)
    return parsed.tier ? { tier: parsed.tier, reason: parsed.reason, usage: result ? result.usage : null } : null
  }

  /** Apply one supervisor verdict to a live turn, one notch at a time. */
  function applyAction(state, action, reason, usage) {
    const index = TIERS.indexOf(state.tier)
    if (action === 'up' && index < TIERS.length - 1) changeTier(state, TIERS[index + 1], 'judge:up', reason, usage)
    else if (action === 'down' && index > 0) changeTier(state, TIERS[index - 1], 'judge:down', reason, usage)
  }

  /**
   * Ask the supervisor how the turn is actually going and whether to move.
   * Triggered by tool errors and by mid-turn checkpoints; the verdict is the
   * model's, never a fixed count of failures.
   */
  async function reJudge(state, trigger, detail, parentSignal) {
    const now = Date.now()
    if (now - (state.lastJudgeAt ?? 0) < 3000) return null
    if ((state.judges ?? 0) >= config.classifier.maxRejudgesPerTurn) return null
    const activity = state.activity ?? []
    const activityText = activity.length === 0
      ? '（还没有工具步骤）'
      : activity.map((item) => `- ${item.name}: ${item.status}${item.note ? ' · ' + item.note : ''}`).join('\n')
    const prompt = [
      '任务：\n"""\n' + (state.text ?? '').slice(0, 800) + '\n"""',
      `当前档位：${state.tier}（本轮首判 ${state.baseTier}）`,
      `已进行 ${state.steps} 步，工具调用 ${state.toolCalls} 次，其中报错 ${state.toolErrors} 次。`,
      '触发原因：' + (trigger === 'tool-error' ? '刚才有工具报错：' + detail : '到了本轮中段检查点。'),
      '最近步骤：\n' + activityText,
      '请决定：up / down / hold。',
    ].join('\n\n')
    state.lastJudgeAt = now
    state.judges = (state.judges ?? 0) + 1
    const result = await runClassifier(reJudgeSystemPrompt(), prompt, 40, parentSignal)
    const verdict = parseRejudge(result && result.text)
    const action = verdict.action
    state.routerTokens = addUsage(state.routerTokens, result ? result.usage : null)
    if (action) trace({ kind: 'rejudge', agent: state.agentId, turn: state.turn, trigger, action, reason: verdict.reason, detail: typeof detail === 'string' ? detail.slice(0, 200) : undefined })
    if (!action) return null
    const triggerLabel = trigger === 'tool-error' ? '工具报错' : '中段检查'
    const reason = verdict.reason
      ? triggerLabel + '：' + verdict.reason
      : (trigger === 'tool-error' && typeof detail === 'string' && detail ? triggerLabel + '：' + detail.slice(0, 60) : triggerLabel)
    return { action, reason, usage: result ? result.usage : null }
  }

  ctx.on('agent/pre-step', async (payload, next) => {
    try {
      if (!config.enabled || !Array.isArray(payload?.messages) || payload.messages.length === 0) return next()
      const agentId = payload.agent.id
      const batch = readBatch(payload.messages)
      if (batch.text === '') return next()
      const known = decisions.get(agentId)
      const sameTurn = known !== undefined && known.turn === payload.turn
      // Classify at turn start, and again if the human sends new input mid-turn.
      const freshInput = !sameTurn || batch.text !== known.text
      if (!freshInput) return next()

      const recentTexts = recent.get(agentId) ?? []
      const prior = sameTurn ? known : undefined
      let verdict = null
      const pin = pins.get(agentId)
      if (pin) {
        verdict = { tier: pin, reason: 'pinned' }
      } else {
        const directive = readDirective(batch.text)
        if (directive) {
          verdict = { tier: directive, reason: 'directive' }
        } else if (config.classifier.enabled) {
          const started = Date.now()
          const classified = await classifyWithModel(batch.text, recentTexts, lastTurns.get(agentId), payload.signal)
          if (classified && classified.tier) verdict = { tier: classified.tier, reason: 'classifier', reasonText: classified.reason, ms: Date.now() - started, classifier: config.classifier.model, usage: classified.usage }
        }
        if (!verdict) verdict = classify(batch.text, config, undefined)
      }
      // A new human message starts a new decision, but keeps the turn's step count.
      decisions.set(agentId, {
        agentId,
        turn: payload.turn,
        tier: verdict.tier,
        baseTier: verdict.tier,
        text: batch.text.slice(0, 200),
        reason: verdict.reason,
        classifier: verdict.classifier,
        ms: verdict.ms,
        routerTokens: addUsage(prior?.routerTokens, verdict.usage),
        initialUsage: normalizeUsage(verdict.usage),
        initialModel: config.classifier.model,
        initialReason: verdict.reasonText ?? null,
        hasImage: batch.hasImage,
        hasFile: batch.hasFile,
        steps: prior?.steps ?? 0,
        toolCalls: prior?.toolCalls ?? 0,
        toolErrors: 0,
        activity: [],
        judges: 0,
        lastJudgeAt: 0,
        updatedAt: Date.now(),
        history: [],
      })
      recent.set(agentId, [...recentTexts, batch.text.slice(0, 400)].slice(-2))
    } catch (error) {
      ctx.logger?.warn?.('[auto-router] classification failed: %o', error)
    }
    return next()
  })

  ctx.on('agent/request', async (payload, next) => {
    const base = await next()
    try {
      if (!config.enabled) return base
      const decision = decisions.get(payload.agent.id)
      if (!decision || decision.turn !== payload.turn) return base
      decision.steps = Math.max(decision.steps ?? 0, payload.step)
      if (!decision.baseModel) {
        decision.baseModel = base.model
        decision.baseEffort = base.reasoningEffort ?? null
      }
      // Mid-turn checkpoint: the supervisor reads how the turn is going and
      // decides up/down/hold itself, instead of a fixed step threshold.
      if (config.classifier.enabled && config.classifier.rejudgeEverySteps > 0 && payload.step > 1 && payload.step % config.classifier.rejudgeEverySteps === 0) {
        const verdict = await reJudge(decision, 'checkpoint', 'step=' + payload.step, payload.signal)
        if (verdict) applyAction(decision, verdict.action, verdict.reason, verdict.usage)
      }
      if (decision.hasImage || decision.hasFile) {
        decision.provider = base.provider
        decision.model = base.model
        decision.effort = base.reasoningEffort ?? null
        decision.appliedTier = tierForRoute(base.provider, base.model, base.reasoningEffort) ?? decision.appliedTier
        decision.updatedAt = Date.now()
        trace({ agent: payload.agent.id, turn: payload.turn, step: payload.step, tier: decision.tier, reason: decision.reason, skipped: 'attachments' })
        return base
      }
      const llm = ctx.get('llm')
      if (!llm) return base
      const target = await resolveTarget(llm, decision.tier, base)
      if (!target) {
        decision.provider = base.provider
        decision.model = base.model
        decision.effort = base.reasoningEffort ?? null
        decision.appliedTier = tierForRoute(base.provider, base.model, base.reasoningEffort) ?? decision.appliedTier
        decision.updatedAt = Date.now()
        trace({ agent: payload.agent.id, turn: payload.turn, step: payload.step, tier: decision.tier, reason: decision.reason, skipped: 'unresolved-route' })
        return base
      }
      const approvalSpec = config.approval
      const isProTarget = approvalSpec.enabled
        && proModelRe.test(target.model || '')
        && !proModelRe.test(base.model || '')
      if (isProTarget) {
        const skipPinned = approvalSpec.skipWhenPinned && (decision.reason === 'pinned' || decision.reason === 'directive')
        let allowed = decision.proApproved === true
        if (!allowed && !decision.proDenied && !skipPinned) {
          const lastChange = (decision.history ?? [])[decision.history.length - 1]
          const approvalReason = decision.reasonText
            || (lastChange && lastChange.reason)
            || (decision.reason === 'pinned' ? '用户手动切换' : decision.reason === 'directive' ? '消息前缀指定了该档位' : '这一轮需要更强的模型')
          allowed = await requestProApproval(decision, decision.tier, target.model, approvalReason, payload.signal)
          if (!allowed) {
            decision.declines = [...(decision.declines ?? []), { at: Date.now(), tier: decision.tier, model: target.model, reason: approvalReason }].slice(-8)
          }
        }
        if (!allowed) {
          decision.proDeclined = true
          decision.intendedTier = decision.tier
          decision.intendedModel = target.model
          decision.provider = base.provider
          decision.model = base.model
          decision.effort = base.reasoningEffort ?? null
          decision.appliedTier = tierForRoute(base.provider, base.model, base.reasoningEffort) ?? null
          decision.updatedAt = Date.now()
          trace({ agent: payload.agent.id, turn: payload.turn, step: payload.step, tier: decision.tier, reason: decision.reason, skipped: 'pro-declined' })
          return base
        }
      }
      const unchanged = target.provider === base.provider
        && target.model === base.model
        && (target.reasoningEffort ?? undefined) === (base.reasoningEffort ?? undefined)
      decision.provider = target.provider
      decision.model = target.model
      decision.effort = target.reasoningEffort ?? null
      decision.appliedTier = tierForRoute(target.provider, target.model, target.reasoningEffort) ?? decision.tier
      decision.updatedAt = Date.now()
      if (unchanged) {
        trace({ agent: payload.agent.id, turn: payload.turn, step: payload.step, tier: decision.tier, reason: decision.reason, applied: false, same: true })
        return base
      }
      const record = {
        agent: payload.agent.id,
        turn: payload.turn,
        step: payload.step,
        tier: decision.tier,
        reason: decision.reason,
        from: { provider: base.provider, model: base.model, effort: base.reasoningEffort ?? null },
        to: { provider: target.provider, model: target.model, effort: target.reasoningEffort ?? null },
        applied: !config.dryRun,
        dryRun: config.dryRun,
      }
      if (target.degraded) record.degraded = target.degraded
      trace(record)
      if (config.dryRun) return base
      return {
        ...base,
        provider: target.provider,
        model: target.model,
        ...(target.reasoningEffort === undefined ? {} : { reasoningEffort: target.reasoningEffort }),
      }
    } catch (error) {
      ctx.logger?.warn?.('[auto-router] routing failed, keeping the original config: %o', error)
      trace({ agent: payload?.agent?.id, turn: payload?.turn, step: payload?.step, error: error instanceof Error ? error.message : String(error) })
      return base
    }
  })

  // Tool outcomes are the mid-turn signal, but the decision to move is the
  // supervisor model's: it reads the error text and decides whether the tier is
  // actually too low, or the failure was the task's own fault.
  ctx.on('tools/result', (exec, result) => {
    try {
      if (!config.enabled) return
      const agentId = exec?.agent?.id
      if (!agentId) return
      const state = decisions.get(agentId)
      if (!state) return
      state.toolCalls += 1
      const name = typeof exec?.name === 'string' ? exec.name : 'tool'
      if (result?.isError) {
        state.toolErrors += 1
        const message = typeof result?.error?.message === 'string' ? result.error.message : String(result?.error ?? 'error')
        state.activity = [...(state.activity ?? []), { name, status: 'error', note: message.slice(0, 120) }].slice(-8)
        if (config.classifier.enabled && config.classifier.rejudgeOnError) {
          reJudge(state, 'tool-error', message).then((verdict) => {
            if (verdict) applyAction(state, verdict.action, verdict.reason, verdict.usage)
          })
        }
      } else {
        state.activity = [...(state.activity ?? []), { name, status: 'ok' }].slice(-8)
      }
    } catch {
      /* observation only */
    }
  })

  // Remember how the turn went so the next classification can correct an overshoot,
  // and keep a per-session turn history for the history panel.
  ctx.on('agent/turn-stopping', (payload) => {
    try {
      const state = decisions.get(payload.agent.id)
      if (!state) return
      lastTurns.set(payload.agent.id, {
        tier: state.tier,
        steps: state.steps ?? 0,
        toolCalls: state.toolCalls ?? 0,
        toolErrors: state.toolErrors ?? 0,
      })
      const list = turnLogs.get(payload.agent.id) ?? []
      const record = {
        turn: state.turn,
        text: state.text ?? '',
        baseTier: state.baseTier,
        tier: state.tier,
        appliedTier: state.appliedTier ?? null,
        provider: state.provider ?? null,
        model: state.model ?? null,
        effort: state.effort ?? null,
        reason: state.reason,
        steps: state.steps ?? 0,
        toolCalls: state.toolCalls ?? 0,
        toolErrors: state.toolErrors ?? 0,
        changes: state.history ?? [],
        routerTokens: state.routerTokens ?? null,
        routerModel: config.classifier.model,
        baseModel: state.baseModel ?? null,
        baseEffort: state.baseEffort ?? null,
        proDeclined: state.proDeclined === true,
        intendedModel: state.intendedModel ?? null,
        declines: state.declines ?? [],
        initialUsage: state.initialUsage ?? null,
        initialModel: state.initialModel ?? config.classifier.model,
        initialReason: state.initialReason ?? null,
        updatedAt: state.updatedAt ?? Date.now(),
      }
      const existing = list.findIndex((item) => item.turn === state.turn)
      if (existing >= 0) list[existing] = record
      else list.push(record)
      turnLogs.set(payload.agent.id, list.slice(-200))
      appendTurnRecord(payload.agent.id, record)
    } catch {
      /* observation only */
    }
  })

  ctx.on('agent/disposed', (payload) => {
    decisions.delete(payload.agent.id)
    pins.delete(payload.agent.id)
    recent.delete(payload.agent.id)
    lastTurns.delete(payload.agent.id)
  })

  // Live routing state for the composer badge. Read-only, authenticated like any
  // other Host Fetch route on the connection seam.
  ctx.inject(['connection'], (child) => {
    child.effect(() => child.connection.fetch.register({
      path: '/api/auto-router.state',
      methods: ['GET'],
      requestBody: 'buffered',
      fetch: async (request) => {
        const url = new URL(request.url)
        const session = url.searchParams.get('session') ?? ''
        const turnParam = url.searchParams.get('turn')
        if (turnParam !== null && session !== '') {
          const turnNo = Number(turnParam)
          const live = session === '' ? undefined : decisions.get(session)
          let record = (turnLogs.get(session) ?? []).find((item) => item.turn === turnNo) ?? null
          if (!record && live && live.turn === turnNo) {
            record = {
              turn: live.turn,
              text: live.text ?? '',
              baseTier: live.baseTier,
              tier: live.tier,
              appliedTier: live.appliedTier ?? null,
              provider: live.provider ?? null,
              model: live.model ?? null,
              effort: live.effort ?? null,
              reason: live.reason,
              steps: live.steps ?? 0,
              toolCalls: live.toolCalls ?? 0,
              toolErrors: live.toolErrors ?? 0,
              changes: live.history ?? [],
              routerTokens: live.routerTokens ?? null,
              routerModel: config.classifier.model,
              baseModel: live.baseModel ?? null,
              baseEffort: live.baseEffort ?? null,
              proDeclined: live.proDeclined === true,
              intendedModel: live.intendedModel ?? null,
              declines: live.declines ?? [],
              initialUsage: live.initialUsage ?? null,
              initialModel: live.initialModel ?? config.classifier.model,
              initialReason: live.initialReason ?? null,
              updatedAt: live.updatedAt ?? Date.now(),
            }
          }
          return new Response(JSON.stringify({ ok: true, generatedAt: Date.now(), enabled: config.enabled, tiers: config.tiers, turn: record }), {
            status: 200,
            headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
          })
        }
        const state = session === '' ? undefined : decisions.get(session)
        const pendingEntry = session === '' ? undefined : [...approvals.values()].find((entry) => entry.session === session)
        const body = {
          ok: true,
          generatedAt: Date.now(),
          enabled: config.enabled,
          dryRun: config.dryRun,
          classifier: { enabled: config.classifier.enabled, model: config.classifier.model, effort: config.classifier.effort },
          pending: pendingEntry
            ? { id: pendingEntry.id, tier: pendingEntry.tier, model: pendingEntry.model, reason: pendingEntry.reason, deadline: pendingEntry.deadline }
            : null,
          tiers: config.tiers,
          session: state
            ? {
                turn: state.turn,
                tier: state.tier,
                appliedTier: state.appliedTier ?? null,
                baseTier: state.baseTier,
                provider: state.provider ?? null,
                model: state.model ?? null,
                effort: state.effort ?? null,
                reason: state.reason,
                ms: state.ms ?? null,
                toolCalls: state.toolCalls ?? 0,
                toolErrors: state.toolErrors ?? 0,
                updatedAt: state.updatedAt,
                history: state.history ?? [],
              }
            : null,
        }
        return new Response(JSON.stringify(body), {
          status: 200,
          headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
        })
      },
    }), 'auto-router: state route')
  })

  // Pro-model approval: the composer polls for a pending ask and answers it.
  ctx.inject(['connection'], (child) => {
    child.effect(() => child.connection.fetch.register({
      path: '/api/auto-router.approval',
      methods: ['GET', 'POST'],
      requestBody: 'buffered',
      fetch: async (request) => {
        const url = new URL(request.url)
        if (request.method === 'POST') {
          const body = await request.json().catch(() => null)
          const entry = body && body.id ? approvals.get(String(body.id)) : undefined
          if (entry) entry.settle(body.accept === true)
          return new Response(JSON.stringify({ ok: true, resolved: Boolean(entry) }), {
            status: 200,
            headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
          })
        }
        const session = url.searchParams.get('session') ?? ''
        const entry = session === '' ? undefined : [...approvals.values()].find((item) => item.session === session)
        return new Response(JSON.stringify({
          ok: true,
          pending: entry
            ? { id: entry.id, tier: entry.tier, model: entry.model, reason: entry.reason, deadline: entry.deadline }
            : null,
        }), {
          status: 200,
          headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
        })
      },
    }), 'auto-router: approval route')
  })

  // Per-session turn history: every completed turn plus the live one, with its
  // tier timeline, for the history panel.
  ctx.inject(['connection'], (child) => {
    child.effect(() => child.connection.fetch.register({
      path: '/api/auto-router.history',
      methods: ['GET'],
      requestBody: 'buffered',
      fetch: async () => {
        const combined = new Map()
        for (const [agentId, turns] of turnLogs) {
          combined.set(agentId, { sessionId: agentId, turns: [] })
          for (const turn of turns) combined.get(agentId).turns.push(turn)
        }
        for (const [agentId, state] of decisions) {
          const live = {
            turn: state.turn,
            text: state.text ?? '',
            baseTier: state.baseTier,
            tier: state.tier,
            provider: state.provider ?? null,
            model: state.model ?? null,
            effort: state.effort ?? null,
            reason: state.reason,
            steps: state.steps ?? 0,
            toolCalls: state.toolCalls ?? 0,
            toolErrors: state.toolErrors ?? 0,
            changes: state.history ?? [],
            updatedAt: state.updatedAt ?? Date.now(),
            live: true,
          }
          if (!combined.has(agentId)) combined.set(agentId, { sessionId: agentId, turns: [] })
          const entry = combined.get(agentId)
          const existing = entry.turns.findIndex((turn) => turn.turn === state.turn)
          if (existing >= 0) entry.turns[existing] = live
          else entry.turns.push(live)
        }
        const sessions = [...combined.values()].map((entry) => ({
          sessionId: entry.sessionId,
          turns: entry.turns.sort((a, b) => b.turn - a.turn),
        }))
        sessions.sort((a, b) => (b.turns[0]?.updatedAt ?? 0) - (a.turns[0]?.updatedAt ?? 0))
        const body = { ok: true, generatedAt: Date.now(), sessions }
        return new Response(JSON.stringify(body), {
          status: 200,
          headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
        })
      },
    }), 'auto-router: history route')
  })

  // Log the live catalog once so the first run can be tuned against real models.
  ctx.inject(['llm'], (child) => {
    child.effect(() => {
      let alive = true
      Promise.resolve()
        .then(() => child.llm.listProviders())
        .then(async (providers) => {
          if (!alive) return
          const providersOut = providers.map((provider) => ({ id: provider.id, name: provider.name }))
          const summary = await catalog(child.llm)
          trace({ kind: 'catalog', providers: providersOut, models: summary.data })
        })
        .catch((error) => trace({ kind: 'catalog-error', error: error instanceof Error ? error.message : String(error) }))
      return () => {
        alive = false
      }
    }, 'auto-router: catalog probe')
  })

  // `/route` — status, pin one tier for this session, or print the catalog.
  ctx.inject(['commands'], (child) => {
    child.effect(() => child.commands.register({
      name: 'route',
      description: '自动模型路由：查看状态、临时固定档位，或列出模型与推理等级',
      input: { hint: '[auto|轻量|中量|重量|较深|极深|catalog|history]' },
      handler: async (invocation) => {
        const raw = String(invocation.rawInput ?? '').trim()
        const parts = raw.split(/\s+/u)
        const argument = (parts[0] ?? '').toLowerCase()
        const trailing = parts.slice(1).join(' ').trim()
        const agentId = invocation.agent.id
        if (argument === 'catalog') {
          const llm = ctx.get('llm')
          if (!llm) return { kind: 'error', text: 'llm 服务不可用' }
          try {
            const summary = await catalog(llm)
            return { kind: 'success', text: '可用模型与推理等级：\n' + summary.lines.join('\n') }
          } catch (error) {
            return { kind: 'error', text: 'catalog 失败：' + (error instanceof Error ? error.message : String(error)) }
          }
        }
        if (argument === 'auto' || argument === 'off' || argument === 'reset') {
          pins.delete(agentId)
          return { kind: 'success', text: '已恢复自动档位。' }
        }
        if (argument === 'history' || argument === '归档' || argument === 'archive') {
          const count = Math.max(1, Math.min(50, Number(parts[1]) || 10))
          const records = readArchivedTurns(count)
          if (records.length === 0) return { kind: 'success', text: '没有归档的历史路由记录（只有轮转过才会产生归档）。' }
          const lines = records.map((record) => {
            const tier = TIER_LABEL[record.tier] ?? record.tier ?? '?'
            const when = new Date(record.updatedAt ?? 0).toLocaleString()
            return `- 第 ${record.turn ?? '?'} 轮  ${tier}  ${record.model ?? '?'}${record.effort ? '/' + record.effort : ''}  ${when}  ${record.reason ?? ''}`
          })
          return { kind: 'success', text: '最近 ' + records.length + ' 条归档路由记录：\n' + lines.join('\n') }
        }
        if (TIERS.includes(argument)) {
          pins.set(agentId, argument)
          const tierName = TIER_LABEL[argument] ?? argument
          return {
            kind: 'success',
            text: `本会话已固定为 ${tierName} 档（再发 /route auto 恢复自动）。`
              + (trailing ? `\n注意：后面的文字没有发送；要同时发消息，请单独发送，或用前缀写法 “#${argument} ${trailing}”（#${tierName} 也行）。` : ''),
          }
        }
        const pin = pins.get(agentId)
        const last = decisions.get(agentId)
        return {
          kind: 'success',
          text: [
            `自动路由：${config.enabled ? '已开启' : '已关闭'}${config.dryRun ? '（演练模式，只记录不改模型）' : ''}`,
            `判定方式：${config.classifier.enabled ? `小模型分类（${config.classifier.model}/${config.classifier.effort}）` : '结构规则兜底'}`,
            `模式：${config.mode}    会话固定：${pin ? (TIER_LABEL[pin] ?? pin) : '无'}`,
            `档位：${TIERS.map((tier) => `${TIER_LABEL[tier]}=${config.tiers[tier].model}/${config.tiers[tier].effort}`).join('  ')}`,
            `本会话最近判定：${last ? `${TIER_LABEL[last.tier] ?? last.tier}（${last.reason}${last.ms === undefined ? '' : `，${last.ms}ms`}，第 ${last.turn} 轮）` : '暂无'}`,
            '提示：/route history [n] 查看归档路由记录（归档文件启动时不读取）。',
          ].join('\n'),
        }
      },
    }), 'auto-router: /route command')
  })
}

export function apply(ctx, config) {
  const normalized = normalizeConfig(config)
  createRouter(ctx, normalized)
  ctx.logger?.info?.('[auto-router] active (mode=%s, dryRun=%s)', normalized.mode, normalized.dryRun)
}

// Exported for the offline tests; the plugin runtime only uses `apply`.
export { classify, normalizeConfig, parseAction, parseClassify, parseRejudge, parseTier, pickEffort, readBatch, readDirective }

import ConfigSchema from './config.js'
export const Config = ConfigSchema
