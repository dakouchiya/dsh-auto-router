/**
 * Offline tests for directives, answer parsing, tier names, and config merging.
 * Run with: node test/parsing.test.mjs
 */

import { classify, normalizeConfig, parseClassify, parseRejudge, parseTier, readDirective } from '../index.js'

let failures = 0
function check(name, actual, expected) {
  const ok = actual === expected
  if (!ok) failures += 1
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}  -> ${JSON.stringify(actual)}${ok ? '' : ` (expected ${JSON.stringify(expected)})`}`)
}

const config = normalizeConfig({})

// --- `#` directives: ids and Chinese names --------------------------------
check('directive #lite', readDirective('#lite 你好'), 'lite')
check('directive #MAX', readDirective('#MAX 帮我'), 'max')
check('directive #超 long', readDirective('#ultra 穷尽'), 'ultra')
check('directive 中文 #轻量', readDirective('#轻量 你好'), 'lite')
check('directive 中文 #中量', readDirective('#中量 解释一下'), 'standard')
check('directive 中文 #重量', readDirective('#重量 帮我排查'), 'deep')
check('directive 中文 #较深', readDirective('#较深 设计一下'), 'max')
check('directive 中文 #极深', readDirective('#极深 不惜成本'), 'ultra')
check('directive unknown', readDirective('#nope 你好'), null)
check('directive no hash', readDirective('lite 你好'), null)
check('directive empty', readDirective('#'), null)
check('classify 中文 directive wins', classify('#极深 帮我看看', config)?.tier, 'ultra')

// --- classifier answer parsing -------------------------------------------
const deepAnswer = parseClassify('deep：要改代码并查故障，需要多步推理')
check('parseClassify tier', deepAnswer.tier, 'deep')
check('parseClassify reason', deepAnswer.reason, '要改代码并查故障，需要多步推理')
check('parseClassify bare tier', parseClassify('standard').tier, 'standard')
check('parseClassify bare tier no reason', parseClassify('standard').reason, '')
check('parseClassify garbage', parseClassify('不知道').tier, null)

// --- supervisor answer parsing -------------------------------------------
const downAnswer = parseRejudge('down：进展顺利且无报错，可降档省成本')
check('parseRejudge action', downAnswer.action, 'down')
check('parseRejudge reason', downAnswer.reason, '进展顺利且无报错，可降档省成本')
check('parseRejudge up', parseRejudge('UP：任务比初判更难').action, 'up')
check('parseRejudge bare', parseRejudge('hold').action, 'hold')
check('parseRejudge garbage', parseRejudge('？').action, null)

// --- Chinese display names map back to tiers -----------------------------
check('parseTier 极深', parseTier('极深'), 'ultra')
check('parseTier 较深', parseTier('较深'), 'max')
check('parseTier 重量', parseTier('重量'), 'deep')
check('parseTier 中量', parseTier('中量'), 'standard')
check('parseTier 轻量', parseTier('轻量'), 'lite')
check('parseTier 深入', parseTier('深入'), 'deep')

// --- approval / history config -------------------------------------------
const defaults = normalizeConfig({})
check('approval on by default', defaults.approval.enabled, true)
check('approval window default 15s', defaults.approval.windowMs, 15000)
check('approval pattern default', defaults.approval.modelPattern, 'pro')
check('approval skipWhenPinned default off', defaults.approval.skipWhenPinned, false)
check('approval window clamped low', normalizeConfig({ approval: { windowMs: 500 } }).approval.windowMs, 1000)
check('approval can be disabled', normalizeConfig({ approval: { enabled: false } }).approval.enabled, false)
check('approval pattern override', normalizeConfig({ approval: { modelPattern: 'v4-pro' } }).approval.modelPattern, 'v4-pro')
check('history default 2MB', defaults.history.maxBytes, 2 * 1024 * 1024)
check('history clamped low', normalizeConfig({ history: { maxBytes: 1024 } }).history.maxBytes, 64 * 1024)
check('history override', normalizeConfig({ history: { maxBytes: 4 * 1024 * 1024 } }).history.maxBytes, 4 * 1024 * 1024)

// --- five tiers always exist ---------------------------------------------
for (const tier of ['lite', 'standard', 'deep', 'max', 'ultra']) {
  check(`tier ${tier} configured`, Boolean(defaults.tiers[tier]?.model), true)
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`)
process.exitCode = failures === 0 ? 0 : 1
