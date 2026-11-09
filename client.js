/**
 * Client half of dsh-auto-router.
 *
 * - A compact chip at the left of the composer tool row shows the tier the Host
 *   picked for this Session's current turn, the concrete model/effort dispatched,
 *   and flashes when the tier changes mid-turn.
 * - A per-turn tag under each completed assistant reply expands to show that
 *   turn's routing: initial tier + reason, final tier + model/effort, and every
 *   mid-turn tier change with its cause and reason.
 */
;(function () {
  // The module loader rejects a duplicate id, and a second copy of this plugin
  // (a leftover local bundle beside the published one, or two installs of the
  // same package) would otherwise take the whole page down at boot. This guard
  // makes the second evaluation a no-op; the id below is rewritten to the
  // published package name by scripts/build-release.mjs.
  if (window.__DSH_AUTO_ROUTER_CLIENT__) return
  window.__DSH_AUTO_ROUTER_CLIENT__ = true
  window.__ModuleLoader__.load({
  id: 'dsh-auto-router',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const ENDPOINT = 'api/auto-router.state'
    const POLL_MS = 1500
    const FLASH_MS = 1600

    const COPY = {
      zh: {
        auto: '自动',
        off: '已关闭',
        failed: '路由状态不可用',
        tier: '档位',
        model: '模型',
        reason: '判定',
        tools: '工具',
        errors: '报错',
        changes: '本轮变化',
        classifier: '小模型分类',
        rules: '结构规则兜底',
        pinned: '会话固定',
        directive: '前缀指令',
        turnTag: '路由',
        base: '首判',
        final: '最终',
        changeUp: '监督升档',
        changeDown: '监督降档',
        emptyReason: '（无）',
        noModelCall: '未调用模型',
        tierMap: '档位组合',
        routerCost: '路由开销',
        tokens: 'tokens',
        approx: '约',
        totalLabel: '合计',
        reasonPrefix: '原因：',
        reasonPinned: '用户手动指定',
        reasonDirective: '消息前缀指定',
        reasonClassifier: '小模型分类',
        reasonRules: '结构规则兜底',
      },
      en: {
        auto: 'auto',
        off: 'off',
        failed: 'router state unavailable',
        tier: 'tier',
        model: 'model',
        reason: 'reason',
        tools: 'tools',
        errors: 'errors',
        changes: 'turn changes',
        classifier: 'model classifier',
        rules: 'structural fallback',
        pinned: 'pinned',
        directive: 'directive',
        turnTag: 'route',
        base: 'initial',
        final: 'final',
        changeUp: 'supervisor up',
        changeDown: 'supervisor down',
        emptyReason: '(none)',
        noModelCall: 'no model call',
        tierMap: 'tier map',
        routerCost: 'routing cost',
        tokens: 'tokens',
        approx: '≈',
        totalLabel: 'total',
        reasonPrefix: 'reason: ',
        reasonPinned: 'manual pin',
        reasonDirective: 'message prefix',
        reasonClassifier: 'model classifier',
        reasonRules: 'structural fallback',
      },
    }

    const REASON_LABEL = {
      classifier: 'classifier',
      'rule:lite': 'rule',
      'rule:max': 'rule',
      'rule:regex': 'rule',
      'small-talk': 'heuristic',
      tiny: 'heuristic',
      length: 'heuristic',
      'deep-signal': 'heuristic',
      'dev-request': 'heuristic',
      'max-signal': 'heuristic',
      code: 'heuristic',
      'multi-part': 'heuristic',
      default: 'heuristic',
      directive: 'directive',
      pinned: 'pinned',
    }

    const PRICES = {
      'deepseek-flash': { in: 0.3, out: 1.2 },
      'deepseek-chat': { in: 2, out: 8 },
      'deepseek-v3': { in: 2, out: 8 },
      'deepseek-reasoner': { in: 4, out: 16 },
      'deepseek-v4-pro': { in: 4, out: 16 },
      default: { in: 2, out: 8 },
    }

    function estimateYuan(model, tokens) {
      if (!tokens) return null
      const p = PRICES[model] || PRICES.default
      return ((tokens.input ?? 0) * p.in + (tokens.output ?? 0) * p.out) / 1e6
    }

    function formatYuan(value) {
      if (value == null || !Number.isFinite(value)) return ''
      return value < 0.01 ? value.toFixed(5) : value.toFixed(4)
    }

    const CSS = `
.dsh-ar{display:inline-flex;align-items:center;gap:6px;height:26px;padding:0 8px;border-radius:8px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2);font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums;white-space:nowrap;max-width:260px;overflow:hidden;}
.dsh-ar[data-flash="true"]{border-color:var(--dsw-alias-brand-primary);background:var(--dsw-alias-bg-overlay);}
.dsh-ar-dot{flex:none;width:6px;height:6px;border-radius:999px;background:var(--dsw-alias-state-success-primary);}
.dsh-ar[data-state="failed"] .dsh-ar-dot{background:var(--dsw-alias-state-idle-primary);}
.dsh-tier-chip{display:inline-block;padding:0 6px;border-radius:6px;font-weight:600;font-size:11px;line-height:17px;white-space:nowrap;}
.dsh-tier-chip[data-tier="lite"]{background:#e9eaee;color:#3a3f46;}
.dsh-tier-chip[data-tier="standard"]{background:#dfeddf;color:#2f4a31;}
.dsh-tier-chip[data-tier="deep"]{background:#e0e8f4;color:#2c3f5c;}
.dsh-tier-chip[data-tier="max"]{background:#e8e1f3;color:#443665;}
.dsh-tier-chip[data-tier="ultra"]{background:#f3e0e0;color:#6b2f2f;}
.dsh-tier-chip[data-mismatch="true"]{border:1px dashed var(--dsw-alias-border-l1);}
.dsh-ar-tier{color:var(--dsw-alias-label-primary);font-weight:600;}
.dsh-ar-model{color:var(--dsw-alias-label-secondary);overflow:hidden;text-overflow:ellipsis;}
.dsh-ar-modal-wrap{position:fixed;left:50%;bottom:130px;transform:translateX(-50%);z-index:2147483000;}
.dsh-ar-modal{width:min(520px,92vw);padding:16px 18px;border-radius:14px;border:1px solid var(--dsw-alias-state-warn-primary);background:var(--dsw-alias-bg-overlay, var(--dsw-alias-bg-layer-2));box-shadow:0 12px 36px rgba(0,0,0,0.28);color:var(--dsw-alias-label-primary);font-size:13px;line-height:20px;}
.dsh-ar-modal-title{font-weight:600;font-size:14px;}
.dsh-ar-modal-target{display:flex;align-items:center;gap:8px;margin-top:8px;}
.dsh-ar-modal-model{color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums;}
.dsh-ar-modal-reason{margin-top:8px;color:var(--dsw-alias-label-secondary);}
.dsh-ar-modal-foot{display:flex;align-items:center;gap:10px;margin-top:14px;}
.dsh-ar-modal-time{flex:1;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums;}
.dsh-ar-ask-yes,.dsh-ar-ask-no{height:30px;padding:0 16px;border-radius:8px;border:1px solid var(--dsw-alias-border-l1);background:transparent;color:var(--dsw-alias-label-primary);cursor:pointer;font-size:12px;line-height:18px;}
.dsh-ar-ask-yes{background:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary);color:#fff;}
.dsh-ar-arrow{color:var(--dsw-alias-brand-primary);font-weight:600;}
.dsh-arr{display:inline-flex;flex-direction:column;align-items:flex-start;gap:4px;margin:2px 0;}
.dsh-arr-btn{display:inline-flex;align-items:center;gap:6px;height:24px;padding:0 8px;border-radius:8px;border:1px solid var(--dsw-alias-border-l1);background:transparent;cursor:pointer;font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary);max-width:360px;overflow:hidden;}
.dsh-arr-model{color:var(--dsw-alias-label-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.dsh-arr-target{color:var(--dsw-alias-label-secondary);font-size:11px;white-space:nowrap;}
.dsh-arr-btn:hover{border-color:var(--dsw-alias-brand-primary);}
.dsh-arr-prefix{color:var(--dsw-alias-label-secondary);}
.dsh-arr-btn:hover{border-color:var(--dsw-alias-brand-primary);}
.dsh-arr-label{font-weight:600;color:var(--dsw-alias-label-primary);}
.dsh-arr-arrow{color:var(--dsw-alias-brand-primary);font-weight:600;}
.dsh-arr-pop{display:flex;flex-direction:column;gap:6px;padding:10px 12px;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-layer-2);font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);min-width:280px;max-width:460px;}
.dsh-arr-kv{display:grid;grid-template-columns:60px 1fr;gap:8px;align-items:baseline;}
.dsh-arr-k{white-space:nowrap;color:var(--dsw-alias-label-secondary);}
.dsh-arr-v{color:var(--dsw-alias-label-primary);font-variant-numeric:tabular-nums;font-weight:600;overflow-wrap:anywhere;}
.dsh-arr-line{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
.dsh-arr-sec{margin-top:2px;padding-top:6px;border-top:1px solid var(--dsw-alias-border-l1);font-size:11px;color:var(--dsw-alias-label-secondary);}
.dsh-arr-pop > .dsh-arr-sec:first-child{border-top:none;margin-top:0;padding-top:0;}
.dsh-arr-list{display:flex;flex-direction:column;gap:2px;}
.dsh-arr-row{display:grid;grid-template-columns:24px 92px 84px 1fr;gap:8px;align-items:baseline;}
.dsh-arr-row-no{color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums;}
.dsh-arr-row-tier{font-weight:600;color:var(--dsw-alias-label-primary);white-space:nowrap;}
.dsh-arr-row-cause{white-space:nowrap;color:var(--dsw-alias-label-primary);}
.dsh-arr-row-reason{color:var(--dsw-alias-label-secondary);overflow:hidden;text-overflow:ellipsis;}
.dsh-arr-costrow{display:flex;flex-direction:column;gap:2px;padding:2px 0;}
.dsh-arr-costrow-main{display:flex;gap:8px;align-items:baseline;}
.dsh-arr-costrow-reason{padding-left:32px;color:var(--dsw-alias-label-secondary);white-space:normal;line-height:16px;}
.dsh-arr-costrow-usage{padding-left:32px;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums;}
`

    function locale() {
      try {
        return /^zh/i.test(navigator.language || '') ? COPY.zh : COPY.en
      } catch {
        return COPY.zh
      }
    }

    /** `deepseek-v4-pro` reads better as `v4-pro` inside a toolbar chip. */
    function shortModel(model) {
      if (typeof model !== 'string') return ''
      return model.replace(/^deepseek-/, '')
    }

    const TIER_ZH = { lite: '轻量', standard: '中量', deep: '重量', max: '较深', ultra: '极深' }
    const TIER_ORDER = ['lite', 'standard', 'deep', 'max', 'ultra']
    function localTier(tier) {
      try {
        return /^zh/i.test(navigator.language || '') ? (TIER_ZH[tier] || tier) : tier
      } catch {
        return TIER_ZH[tier] || tier
      }
    }

    function reasonText(reason) {
      const t = locale()
      if (reason === 'pinned') return t.reasonPinned
      if (reason === 'directive') return t.reasonDirective
      if (reason === 'classifier') return t.reasonClassifier
      if (typeof reason === 'string' && reason.startsWith('rule:')) return t.reasonRules
      return REASON_LABEL[reason] || reason || t.emptyReason
    }

    /**
     * The turnTail owner hands over a `TurnLocation`, not a plain number: the
     * turn object itself (`.data` / `.end`) or an address carrying `.turn`.
     * Read the ordinal defensively so a shape change drops the tag instead of
     * throwing inside the conversation renderer.
     */
    function turnNumber(turn) {
      if (typeof turn === 'number') return Number.isFinite(turn) ? turn : null
      if (!turn || typeof turn !== 'object') return null
      for (const key of ['turn', 'number', 'ordinal', 'index', 'id']) {
        const value = turn[key]
        if (typeof value === 'number' && Number.isFinite(value)) return value
      }
      return null
    }

    function TierBadge(props) {
      const sessionId = props && props.sessionId
      const [state, setState] = React.useState({ status: 'loading' })
      const [flash, setFlash] = React.useState(false)
      const lastTier = React.useRef(null)
      const flashTimer = React.useRef(null)

      const load = React.useCallback(async () => {
        if (!sessionId) return
        try {
          const url = new URL(ENDPOINT, document.baseURI)
          url.searchParams.set('session', String(sessionId))
          const response = await fetch(url, { credentials: 'same-origin', cache: 'no-store' })
          const data = await response.json().catch(() => null)
          if (!response.ok || !data || data.ok !== true) {
            setState({ status: 'failed' })
            return
          }
          setState({ status: 'ok', data })
          const tier = data.session ? data.session.tier : null
          if (lastTier.current !== null && tier !== null && tier !== lastTier.current) {
            setFlash(true)
            if (flashTimer.current) clearTimeout(flashTimer.current)
            flashTimer.current = setTimeout(() => setFlash(false), FLASH_MS)
          }
          lastTier.current = tier
        } catch {
          setState({ status: 'failed' })
        }
      }, [sessionId])

      const answer = async (id, accept) => {
        try {
          await fetch(new URL('api/auto-router.approval', document.baseURI), {
            method: 'POST',
            credentials: 'same-origin',
            cache: 'no-store',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ id, accept: accept === true }),
          })
        } catch {
          /* the host may have already timed out */
        }
        load()
      }

      React.useEffect(() => {
        let live = true
        const visible = () => typeof document === 'undefined' || document.visibilityState !== 'hidden'
        const tick = () => {
          if (live && visible()) load()
        }
        tick()
        const timer = setInterval(tick, POLL_MS)
        document.addEventListener('visibilitychange', tick)
        return () => {
          live = false
          clearInterval(timer)
          document.removeEventListener('visibilitychange', tick)
          if (flashTimer.current) clearTimeout(flashTimer.current)
        }
      }, [load])

      const pendingNow = Boolean(state.data && state.data.pending)
      React.useEffect(() => {
        if (!pendingNow) return undefined
        const timer = setInterval(() => setState((prev) => ({ ...prev })), 1000)
        return () => clearInterval(timer)
      }, [pendingNow])

      const t = locale()
      if (state.status === 'failed') {
        return h('div', { className: 'dsh-ar', 'data-state': 'failed', title: t.failed },
          h('style', null, CSS),
          h('span', { className: 'dsh-ar-dot', 'aria-hidden': 'true' }),
          h('span', { className: 'dsh-ar-tier' }, '—'))
      }
      if (state.status !== 'ok') return null

      const data = state.data
      const session = data.session
      if (data.pending) {
        const pending = data.pending
        const remain = Math.max(0, Math.ceil((pending.deadline - Date.now()) / 1000))
        const tierCfg = (data.tiers || {})[pending.tier] || {}
        const targetModel = tierCfg.model || pending.model || 'pro'
        const targetEffort = tierCfg.effort || ''
        const currentModel = session && session.model
        const priceA = PRICES[currentModel] || PRICES.default
        const priceB = PRICES[targetModel] || PRICES.default
        const ratio = priceA && priceB
          ? Math.round(((priceB.in + priceB.out) / (priceA.in + priceA.out)) * 10) / 10
          : null
        return h('div', { className: 'dsh-ar-modal-wrap' },
          h('style', null, CSS),
          h('div', { className: 'dsh-ar-modal', role: 'dialog', 'aria-modal': 'true' },
            h('div', { className: 'dsh-ar-modal-title' }, '升级到 ' + localTier(pending.tier) + '？'),
            h('div', { className: 'dsh-ar-modal-target' },
              h('span', { className: 'dsh-tier-chip', 'data-tier': pending.tier }, localTier(pending.tier)),
              h('span', { className: 'dsh-ar-modal-model' }, targetModel + (targetEffort ? '/' + targetEffort : '')),
            ),
            h('div', { className: 'dsh-ar-modal-reason' }, '原因：' + (pending.reason || '这一轮需要更强的模型')),
            ratio != null ? h('div', { className: 'dsh-ar-modal-reason' }, '预计单价约为当前的 ' + ratio + ' 倍') : null,
            h('div', { className: 'dsh-ar-modal-foot' },
              h('span', { className: 'dsh-ar-modal-time' }, remain + ' 秒后自动不切换'),
              h('button', { className: 'dsh-ar-ask-no', type: 'button', onClick: () => answer(pending.id, false) }, '不切换'),
              h('button', { className: 'dsh-ar-ask-yes', type: 'button', onClick: () => answer(pending.id, true) }, '切换'),
            ),
          ),
        )
      }
      if (!data.enabled) {
        return h('div', { className: 'dsh-ar', title: t.off },
          h('style', null, CSS),
          h('span', { className: 'dsh-ar-dot', 'aria-hidden': 'true' }),
          h('span', { className: 'dsh-ar-tier' }, t.off))
      }
      if (!session) {
        return h('div', { className: 'dsh-ar', title: t.auto + ' · ' + (data.classifier.enabled ? t.classifier : t.rules) },
          h('style', null, CSS),
          h('span', { className: 'dsh-ar-dot', 'aria-hidden': 'true' }),
          h('span', { className: 'dsh-ar-tier' }, t.auto))
      }

      const history = session.history || []
      const last = history.length > 0 ? history[history.length - 1] : null
      const reasonLabel = reasonText(session.reason)
      const explanation = data.classifier.enabled ? t.classifier : t.rules
      const toolLine = t.tools + ' ' + session.toolCalls + ' · ' + t.errors + ' ' + session.toolErrors
      const shownTier = session.appliedTier || session.tier
      const title = [
        t.tier + ': ' + localTier(shownTier) + (session.appliedTier && session.appliedTier !== session.tier ? '（目标 ' + localTier(session.tier) + '）' : '') + ' · ' + t.model + ': ' + (session.provider || '?') + '/' + (session.model || '?') + (session.effort ? '/' + session.effort : ''),
        t.reason + ': ' + reasonLabel + '（' + explanation + '）' + (session.ms ? ' · ' + session.ms + 'ms' : ''),
        toolLine,
        last ? t.changes + ': ' + last.tier + '（' + (last.cause || '') + '）' : '',
        '',
        t.tierMap,
        ...TIER_ORDER.map((name) => {
          const cfg = (data.tiers || {})[name]
          return '  ' + localTier(name) + '  ' + (cfg && cfg.model ? cfg.model + (cfg.effort ? '/' + cfg.effort : '') : t.emptyReason)
        }),
      ].filter(Boolean).join('\n')

      const arrow = shownTier !== session.baseTier
        ? (TIER_ORDER.indexOf(shownTier) > TIER_ORDER.indexOf(session.baseTier) ? '↑' : '↓')
        : ''

      return h('div', {
        className: 'dsh-ar',
        'data-tier': shownTier,
        'data-flash': flash ? 'true' : 'false',
        role: 'status',
        'aria-live': 'polite',
        'aria-label': t.auto + ' ' + localTier(shownTier) + ' ' + (session.model || ''),
        title,
      },
        h('style', null, CSS),
        h('span', { className: 'dsh-tier-chip', 'data-tier': shownTier }, localTier(shownTier)),
        arrow ? h('span', { className: 'dsh-ar-arrow' }, arrow) : null,
        session.model ? h('span', { className: 'dsh-ar-model' }, shortModel(session.model) + (session.effort ? '/' + session.effort : '')) : null,
      )
    }

    function TurnRouteTag(props) {
      const sessionId = props && props.sessionId
      const turnNo = turnNumber(props && props.turn)
      const [state, setState] = React.useState({ status: 'idle' })
      const [open, setOpen] = React.useState(false)

      React.useEffect(() => {
        let live = true
        let timer = null
        if (sessionId == null || turnNo == null) {
          setState({ status: 'none' })
          return () => { live = false }
        }
        const attempt = (tryIndex) => {
          ;(async () => {
            try {
              const url = new URL(ENDPOINT, document.baseURI)
              url.searchParams.set('session', String(sessionId))
              url.searchParams.set('turn', String(turnNo))
              const response = await fetch(url, { credentials: 'same-origin', cache: 'no-store' })
              const data = await response.json().catch(() => null)
              if (!live) return
              if (response.ok && data && data.ok === true && data.turn) {
                setState({ status: 'ok', record: data.turn, tiers: data.tiers })
                return
              }
              if (tryIndex < 5) timer = setTimeout(() => attempt(tryIndex + 1), 400 + tryIndex * 500)
              else setState({ status: 'failed' })
            } catch {
              if (!live) return
              if (tryIndex < 5) timer = setTimeout(() => attempt(tryIndex + 1), 400 + tryIndex * 500)
              else setState({ status: 'failed' })
            }
          })()
        }
        attempt(0)
        return () => { live = false; if (timer) clearTimeout(timer) }
      }, [sessionId, turnNo])

      const t = locale()
      if (state.status !== 'ok' || !state.record) return null

      const rec = state.record
      const changes = rec.changes || []
      const ladder = TIER_ORDER
      const shownTier = rec.appliedTier || rec.tier
      const targetMismatch = Boolean(rec.appliedTier) && rec.appliedTier !== rec.tier
      const changed = shownTier !== rec.baseTier
      const arrow = changed ? (ladder.indexOf(shownTier) > ladder.indexOf(rec.baseTier) ? '↑' : '↓') : ''
      const reasonLabel = reasonText(rec.reason)

      const tag = h('button', {
        type: 'button',
        className: 'dsh-arr-btn',
        'data-tier': shownTier,
        onClick: () => setOpen((value) => !value),
        title: t.tier + ': ' + localTier(shownTier) + (targetMismatch ? '（目标 ' + localTier(rec.tier) + '，未切换）' : '') + ' · ' + t.model + ': ' + (rec.model || '') + (rec.effort ? '/' + rec.effort : ''),
      },
        h('span', { className: 'dsh-arr-prefix' }, t.turnTag),
        h('span', { className: 'dsh-tier-chip', 'data-tier': shownTier, 'data-mismatch': targetMismatch ? 'true' : 'false' }, localTier(shownTier)),
        targetMismatch ? h('span', { className: 'dsh-arr-target' }, '目标 ' + localTier(rec.tier) + ' · 未切换') : null,
        rec.model ? h('span', { className: 'dsh-arr-model' }, rec.model + (rec.effort ? '/' + rec.effort : '')) : null,
        arrow ? h('span', { className: 'dsh-arr-arrow' }, arrow) : null,
      )

      if (!open) {
        return h('div', { className: 'dsh-arr' }, h('style', null, CSS), tag)
      }

      const usageLine = (model, usage) => {
        if (!usage) return t.noModelCall
        const yuan = estimateYuan(model || 'deepseek-flash', usage)
        return '入 ' + (usage.input ?? 0) + ' / 出 ' + (usage.output ?? 0) + ' ' + t.tokens + (yuan != null ? ' · ' + t.approx + ' ¥' + formatYuan(yuan) : '')
      }

      const costRows = []
      costRows.push(h('div', { className: 'dsh-arr-costrow', key: 'initial' },
        h('div', { className: 'dsh-arr-costrow-main' },
          h('span', { className: 'dsh-arr-row-no' }, t.base),
          h('span', { className: 'dsh-arr-arrow' }, '→'),
          h('span', { className: 'dsh-arr-row-tier' },
            h('span', { className: 'dsh-tier-chip', 'data-tier': rec.baseTier }, localTier(rec.baseTier)),
          ),
          h('span', { className: 'dsh-arr-row-cause' }, reasonLabel),
        ),
        rec.initialReason ? h('div', { className: 'dsh-arr-costrow-reason' }, t.reasonPrefix + rec.initialReason) : null,
        h('div', { className: 'dsh-arr-costrow-usage' }, usageLine(rec.initialModel, rec.initialUsage)),
      ))

      let prevTier = rec.baseTier
      changes.forEach((change, index) => {
        const changeArrow = ladder.indexOf(change.tier) > ladder.indexOf(prevTier) ? '↑' : '↓'
        const fromTier = prevTier
        prevTier = change.tier
        const causeLabel = change.cause === 'judge:up' ? t.changeUp : change.cause === 'judge:down' ? t.changeDown : (change.cause || '')
        const reasonText = change.reason ? String(change.reason) : ''
        costRows.push(h('div', { className: 'dsh-arr-costrow', key: 'ch' + index },
          h('div', { className: 'dsh-arr-costrow-main' },
            h('span', { className: 'dsh-arr-row-no' }, '#' + (index + 1)),
            h('span', { className: 'dsh-arr-row-tier' },
              h('span', { className: 'dsh-tier-chip', 'data-tier': fromTier }, localTier(fromTier)),
              h('span', { className: 'dsh-arr-arrow' }, '→'),
              h('span', { className: 'dsh-tier-chip', 'data-tier': change.tier }, localTier(change.tier)),
              h('span', { className: 'dsh-arr-arrow' }, changeArrow),
            ),
            h('span', { className: 'dsh-arr-row-cause' }, causeLabel),
          ),
          reasonText ? h('div', { className: 'dsh-arr-costrow-reason' }, t.reasonPrefix + reasonText) : null,
          h('div', { className: 'dsh-arr-costrow-usage' }, usageLine(rec.routerModel, change.usage)),
        ))
      })

      for (const decline of rec.declines || []) {
        costRows.push(h('div', { className: 'dsh-arr-costrow', key: 'decline-' + (decline.at || 0) },
          h('div', { className: 'dsh-arr-costrow-main' },
            h('span', { className: 'dsh-arr-row-no' }, '尝试'),
            h('span', { className: 'dsh-tier-chip', 'data-tier': decline.tier, 'data-mismatch': 'true' }, localTier(decline.tier)),
            h('span', { className: 'dsh-arr-row-cause' }, '未确认，未切换'),
          ),
          decline.reason ? h('div', { className: 'dsh-arr-costrow-reason' }, t.reasonPrefix + decline.reason) : null,
        ))
      }

      const kv = (key, value) => h('div', { className: 'dsh-arr-kv' },
        h('span', { className: 'dsh-arr-k' }, key),
        h('span', { className: 'dsh-arr-v' }, value),
      )

      const totalLine = usageLine(rec.routerModel, rec.routerTokens)

      return h('div', { className: 'dsh-arr' },
        h('style', null, CSS),
        tag,
        h('div', { className: 'dsh-arr-pop' },
          h('div', { className: 'dsh-arr-sec' }, t.routerCost),
          h('div', { className: 'dsh-arr-list' }, costRows),
          kv(t.totalLabel, totalLine),
        ),
      )
    }

    const HISTORY_PANEL_ID = 'auto-router-history'

    const HISTORY_CSS = `
.dsh-arh{display:flex;flex-direction:column;gap:8px;height:100%;min-height:0;padding:10px 12px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-primary);overflow:auto;}
.dsh-arh-head{display:flex;align-items:center;justify-content:space-between;gap:8px;}
.dsh-arh-title{font-weight:600;}
.dsh-arh-head button{height:24px;padding:0 10px;border-radius:6px;border:1px solid var(--dsw-alias-border-l1);background:transparent;color:var(--dsw-alias-label-primary);cursor:pointer;font-size:11px;}
.dsh-arh-empty{color:var(--dsw-alias-label-secondary);padding:16px 4px;}
.dsh-arh-list{display:flex;flex-direction:column;gap:12px;}
.dsh-arh-session{display:flex;flex-direction:column;gap:6px;}
.dsh-arh-sid{color:var(--dsw-alias-label-secondary);font-size:11px;}
.dsh-arh-turn{display:flex;flex-direction:column;gap:2px;padding:6px 8px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-layer-2);}
.dsh-arh-row{display:flex;align-items:center;gap:8px;}
.dsh-arh-turn-no{font-weight:600;white-space:nowrap;}
.dsh-arh-model{color:var(--dsw-alias-label-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.dsh-arh-time{margin-left:auto;color:var(--dsw-alias-label-secondary);font-size:11px;white-space:nowrap;}
.dsh-arh-text{color:var(--dsw-alias-label-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.dsh-arh-changes{display:flex;flex-direction:column;gap:1px;color:var(--dsw-alias-label-secondary);font-size:11px;}
`

    function HistoryIcon(owner) {
      const size = owner && owner.size ? owner.size : 16
      return h('svg', { width: size, height: size, viewBox: '0 0 16 16', 'aria-hidden': 'true' },
        h('path', {
          d: 'M8 1.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13Zm.75 3.25a.75.75 0 0 0-1.5 0v3.5c0 .2.08.39.22.53l2 2a.75.75 0 1 0 1.06-1.06L8.75 7.94V4.75Z',
          fill: 'currentColor',
        }))
    }

    /**
     * Route history panel. Mounts only when the sidebar entry is opened, so the
     * full history is read on demand instead of during startup.
     */
    function HistoryPanel() {
      const [state, setState] = React.useState({ status: 'idle' })
      const load = React.useCallback(async () => {
        setState({ status: 'loading' })
        try {
          const response = await fetch(new URL('api/auto-router.history', document.baseURI), {
            credentials: 'same-origin',
            cache: 'no-store',
          })
          const data = await response.json().catch(() => null)
          if (!response.ok || !data || data.ok !== true) throw new Error('bad response')
          setState({ status: 'ok', sessions: Array.isArray(data.sessions) ? data.sessions : [] })
        } catch {
          setState({ status: 'failed' })
        }
      }, [])
      React.useEffect(() => { load() }, [load])

      if (state.status === 'loading' || state.status === 'idle') {
        return h('div', { className: 'dsh-arh' }, h('style', null, HISTORY_CSS), h('div', { className: 'dsh-arh-empty' }, '读取中…'))
      }
      if (state.status === 'failed') {
        return h('div', { className: 'dsh-arh' },
          h('style', null, HISTORY_CSS),
          h('div', { className: 'dsh-arh-head' },
            h('span', { className: 'dsh-arh-title' }, '路由历史'),
            h('button', { type: 'button', onClick: load }, '重试'),
          ),
          h('div', { className: 'dsh-arh-empty' }, '读取失败。'),
        )
      }

      const sessions = state.sessions || []
      return h('div', { className: 'dsh-arh' },
        h('style', null, HISTORY_CSS),
        h('div', { className: 'dsh-arh-head' },
          h('span', { className: 'dsh-arh-title' }, '路由历史（' + sessions.length + ' 个会话）'),
          h('button', { type: 'button', onClick: load }, '刷新'),
        ),
        sessions.length === 0
          ? h('div', { className: 'dsh-arh-empty' }, '暂无路由记录。')
          : h('div', { className: 'dsh-arh-list' }, sessions.map((session) => h('div', { className: 'dsh-arh-session', key: session.sessionId },
            h('div', { className: 'dsh-arh-sid' }, session.sessionId),
            (session.turns || []).map((turn) => h('div', { className: 'dsh-arh-turn', key: turn.turn },
              h('div', { className: 'dsh-arh-row' },
                h('span', { className: 'dsh-arh-turn-no' }, '第 ' + turn.turn + ' 轮'),
                h('span', { className: 'dsh-tier-chip', 'data-tier': turn.tier }, localTier(turn.tier)),
                h('span', { className: 'dsh-arh-model' }, (turn.model || '?') + (turn.effort ? '/' + turn.effort : '')),
                h('span', { className: 'dsh-arh-time' }, new Date(turn.updatedAt || 0).toLocaleString()),
              ),
              h('div', { className: 'dsh-arh-text' }, turn.text || ''),
              (turn.changes || []).length > 0
                ? h('div', { className: 'dsh-arh-changes' }, (turn.changes || []).map((change, index) => h('span', { key: index }, (change.cause === 'judge:up' ? '监督升档' : change.cause === 'judge:down' ? '监督降档' : String(change.cause || '')) + ' → ' + localTier(change.tier) + (change.reason ? '：' + change.reason : ''))))
                : null,
            )),
          ))),
      )
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('conversation.input.left', () => ctx.slots.register({
          name: 'conversation.input.left',
          id: 'auto-router-tier',
          order: 5,
        }, TierBadge))

        ctx.slots.inject('conversation.chat.turnTail', () => ctx.slots.register({
          name: 'conversation.chat.turnTail',
          id: 'auto-router-turn-tag',
          order: 30,
        }, TurnRouteTag))

        ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
          name: 'sidebar.panellist',
          id: HISTORY_PANEL_ID,
          order: 20,
          label: '路由历史',
        }, HistoryIcon))

        ctx.slots.inject('main', () => ctx.slots.register({
          name: 'main',
          key: HISTORY_PANEL_ID,
        }, () => h(HistoryPanel, {})))
      },
    }
  },
})
})()
