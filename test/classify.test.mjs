/**
 * Offline tests for the pure routing helpers in `../index.js`.
 * Run with: node test/classify.test.mjs
 */

import { classify, normalizeConfig, parseAction, parseTier, pickEffort, readBatch } from '../index.js'

let failures = 0
function check(name, actual, expected) {
  const ok = actual === expected
  if (!ok) failures += 1
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}  -> ${JSON.stringify(actual)}${ok ? '' : ` (expected ${JSON.stringify(expected)})`}`)
}

const config = normalizeConfig({})

// --- classification -------------------------------------------------------
check('greeting -> lite', classify('你好', config)?.tier, 'lite')
check('tiny -> lite', classify('在吗', config)?.tier, 'lite')
check('quick question -> standard', classify('这个功能是什么意思？', config)?.tier, 'standard')
check('dev request -> deep', classify('可以弄个插件吗 改成根据我的需求自动切换推理模型跟推理等级', config)?.tier, 'deep')
check('topic mention without action -> not deep', classify('这个插件是什么', config)?.tier, 'standard')
check('explicit max cue -> max', classify('请彻底排查所有边界情况和极端输入，逐条验证并给出完整结论', config)?.tier, 'max')
check('long text -> deep', classify('x'.repeat(500), config)?.tier, 'deep')
check('directive wins', classify('#max 帮我看看这个', config)?.tier, 'max')
check('rule keyword -> lite', classify('别思考，直接说结论', config)?.tier, 'lite')
check('empty -> null', classify('   ', config), null)

// --- injected context is ignored -----------------------------------------
const injected = readBatch([
  { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '你好' }] },
  { role: 'user', source: { kind: 'runtime-context' }, content: [{ type: 'text', text: 'Current runtime context. 插件 代码 部署 实现 开发 安装 配置'.repeat(20) }] },
  { role: 'user', source: { kind: 'skill-catalog' }, content: [{ type: 'text', text: '<system-reminder> cordis-plugin-development 插件 开发 调试 部署'.repeat(20) }] },
  { role: 'user', source: { kind: 'time-context' }, content: [{ type: 'text', text: 'Time sampled while preparing turn 1, step 1: ...' }] },
  { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'Your parent agent id is "session-x". Before you finish, send your result.' }] },
])
check('injected context filtered', injected.text, '你好')
check('filtered batch classifies lite', classify(injected.text, config)?.tier, 'lite')

// --- effort fallback ------------------------------------------------------
check('effort kept when supported', pickEffort('max', ['high', 'max'], ['off', 'low', 'high', 'max'], 'high'), 'max')
check('effort falls back up the ladder', pickEffort('max', ['medium', 'high'], ['off', 'low', 'high'], 'low'), 'high')
check('effort falls back to default', pickEffort('medium', ['medium'], ['off', 'low'], 'low'), 'low')
check('effort falls back to first effort', pickEffort('medium', [], ['off', 'low'], undefined), 'off')

// --- config merge ---------------------------------------------------------
const merged = normalizeConfig({ mode: 'economy', tiers: { deep: { model: 'deepseek-v4-pro', effort: 'HIGH' } } })
check('mode threshold applied', merged.thresholds.deepMinChars, 800)
check('tier override merged', merged.tiers.deep.model, 'deepseek-v4-pro')
check('effort lowercased', merged.tiers.deep.effort, 'high')
check('unspecified tier keeps default', merged.tiers.lite.model, 'deepseek-flash')
check('classifier on by default', merged.classifier.enabled, true)
check('classifier can be disabled', normalizeConfig({ classifier: { enabled: false } }).classifier.enabled, false)

// --- classifier answer parsing -------------------------------------------
check('parseTier bare', parseTier('deep'), 'deep')
check('parseTier mixed case', parseTier('DEEP'), 'deep')
check('parseTier punctuation', parseTier('deep.'), 'deep')
check('parseTier sentence', parseTier('答案：standard'), 'standard')
check('parseTier chinese', parseTier('深入'), 'deep')
check('parseTier garbage', parseTier('不知道'), null)

// --- supervisor verdict parsing ------------------------------------------
check('parseAction up', parseAction('up'), 'up')
check('parseAction down', parseAction('DOWN.'), 'down')
check('parseAction hold', parseAction('保持'), 'hold')
check('parseAction alias raise', parseAction('raise'), 'up')
check('parseAction garbage', parseAction('？'), null)

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`)
process.exitCode = failures === 0 ? 0 : 1
