# Auto Model Router (`dsh-auto-router`)

Routes model and reasoning effort **per turn**, from what the turn actually asks.

It is not keyword matching: at the start of every turn a cheap small model
(`deepseek-flash` / `off` by default) reads the user's message and decides how
much thinking and verification the task needs, picks one of five tiers, and
writes down the reason. Keyword rules are only the fallback for a classifier
timeout or failure.

Extension points: `agent/pre-step` (classifier) and `agent/request`
(waterfall, replaces the `LlmCallConfig` of that request). Classification is
read-only and never writes into the session; every decision is appended to
`<DSH_HOME>/auto-router/decisions.jsonl`.

## Install

```sh
dsh plugin --profile <profile> add https://github.com/dakouchiya/dsh-auto-router/releases/download/v1.1.1/dsh-auto-router-1.1.1.tgz
```

Or download the same `.tgz` and install it from the plugin manager. Not published
to npm yet; once it is, `dsh plugin --profile <profile> add dsh-auto-router`
works as well.

The settings row accepts the same configuration as the YAML below; the four
common switches (`enabled`, `dryRun`, `mode`, `logDecisions`) are also exposed
in the Settings form.

## Five tiers

| Tier | Label | Colour | Typical scenario (decided by the classifier) | Lands on |
|---|---|---|---|---|
| `lite` | Light | white | greetings, confirmations, one-line facts, simple conversions | `deepseek-flash` / `off` |
| `standard` | Standard | green | normal Q&A, lookups, short translation/rewrite/summary, one small edit | `deepseek-flash` / `high` |
| `deep` | Deep | blue | multi-step reasoning, debugging, design work, implementation, long analysis | `deepseek-flash` / `max` |
| `max` | Deeper | purple | hard tasks that need high reliability, large refactors or migrations | `deepseek-v4-pro` / `high` |
| `ultra` | Ultra | red | only when the request explicitly asks for maximum effort or is genuinely extreme | `deepseek-v4-pro` / `max` |

The classifier receives the last two user messages as context, so follow-ups
like "and this one?" or "go on" are read correctly. Leading directives
(`#lite` / `#ultra` / the Chinese tier names) pin the tier for that turn without
calling the classifier.

> Defaults in the bundled patch use `deepseek-account` as the provider because
> that is the DeepSeek account provider id in DSH Desktop, and DeepSeek model
> names (`deepseek-flash`, `deepseek-v4-pro`) for the five tiers. On another
> provider set `provider` (or a per-tier `provider`) and the tier `model` values
> to ids your harness exposes; a model that cannot be resolved leaves the current
> configuration untouched instead of sending an invalid request.

## Upgrading to pro asks first (15 s by default)

When the target model matches `pro` (configurable) and the baseline model does
not, the plugin asks before switching:

```
Upgrade to Deeper?
[Deeper] deepseek-v4-pro/high
Reason: user pinned the tier
Price: about 13.3x the current rate
Not switching in 27 s      [No] [Switch]
```

- **No answer / timeout / No** leaves the current model in place (and records the
  attempt); **Switch** applies the new config for the rest of the turn.
- Asked once per turn; turns carrying images or files never switch models.

Config: `approval.enabled` / `windowMs` (default 15000) / `modelPattern`
(default `"pro"`) / `skipWhenPinned` (default `false`).

## Configuration

Written to the profile's `cordis.patch.yml` (the user layer, so upgrades do not
overwrite it):

```yaml
- id: auto-router
  config:
    enabled: true
    dryRun: false          # true = log decisions only, never switch models
    mode: balanced         # economy | balanced | quality, folded into the classifier prompt
    provider: deepseek-account
    tiers:
      lite:     { model: deepseek-flash,    effort: 'off' }
      standard: { model: deepseek-flash,    effort: high }
      deep:     { model: deepseek-flash,    effort: max }
      max:      { model: deepseek-v4-pro,   effort: high }
      ultra:    { model: deepseek-v4-pro,   effort: max }
    classifier:            # the cheap model that judges each turn
      enabled: true
      model: deepseek-flash
      effort: 'off'
      timeoutMs: 6000      # timeout falls back to structural rules; never blocks the turn
      maxInputChars: 3000
    approval:
      enabled: true
      windowMs: 15000
      modelPattern: pro    # regex; a target model matching this needs confirmation
      skipWhenPinned: false
    history:
      maxBytes: 2097152    # per-file cap; older records are archived
    logDecisions: true
```

`effort` only accepts `off` / `low` / `high` / `max` (whatever the model
supports); an unsupported level is narrowed along `off鈫抣ow鈫抙igh鈫抦ax`. A model
that cannot be resolved keeps the current config and sends no invalid request.

## `/route` command

| Command | Effect |
|---|---|
| `/route` | Show switches, mode, tier map and the last decision of this session |
| `/route lite` / `standard` / `deep` / `max` / `ultra` | Pin one tier for this session (Chinese tier names accepted too) |
| `/route auto` | Back to automatic |
| `/route catalog` | List models under the current provider and their supported reasoning levels |
| `/route history [n]` | Read the archived routing records (last 10 by default) |

## Re-routing inside a turn

The first tier is only a starting point. The same cheap model is asked to judge
`up / down / hold` (with one line of reasoning) at two moments, and the plugin
moves at most one tier each time:

- **When a tool errors** 鈥?the error text is passed to the judging model, which
  decides whether the tier was too low or the task itself is the problem (a
  missing file does not raise the tier).
- **Every `rejudgeEverySteps` steps (default 5)** 鈥?a checkpoint looks at how the
  turn is going: smooth and clearly too high goes `down`, stuck goes `up`, and
  "hold" is the default when the model is unsure.

There are no fixed "two errors means upgrade" rules. Each change is logged and
shown on the badge; changes are rate-limited inside a turn (3 s cooldown, at
most `maxRejudgesPerTurn`).

Two related behaviours: a new message mid-turn is re-classified and the new
content drives the tier; a turn judged high that ends in one or two steps without
calling a tool records that fact into the next turn's classifier prompt, so the
classifier can decide to go lower.

## Composer badge and per-turn tail

**Badge in the composer** (`conversation.input.left`) shows the tier and model
actually in effect, e.g. `standard flash/high`; when a pro upgrade was refused
or timed out it shows the effective tier and mentions the target on hover; it
flashes once with `鈫慲/`鈫揱 when the tier changes mid-turn. Data comes from the
read-only host route `api/auto-router.state` (1.5 s polling).

**Tail under each reply** (`conversation.chat.turnTail`) opens a per-turn
breakdown: the five-tier map (read straight from config, zero tokens), the turn
itself (tier with `鈫抈 direction, baseline 鈫?actual model, reasoning level and
where the first decision came from), and the routing overhead (tokens and
approximate cost of the first classification plus every rejudge, including the
reason the model gave, plus refused upgrades and the total).

**Reload the page once (Ctrl+F5) after installing or updating the client code**
so the browser picks up the new client module.

## Storage and archiving

- `turns.jsonl` 鈥?active turn records, capped at 2 MB (`history.maxBytes`).
  When it grows past the cap, `turns.jsonl` becomes `turns.1.jsonl` and the old
  `turns.1.jsonl` is archived to `archive/turns-<timestamp>.jsonl`.
- Startup reads only `turns.jsonl` and `turns.1.jsonl`; archives stay untouched.
- Only `/route history [n]` reads `archive/` on demand.
- `decisions.jsonl` records every decision, re-route and judgement; it rotates to
  `decisions.jsonl.1` past 2 MB.

## Routing history panel

A sidebar entry (clock icon) opens the routing history. Only opening the panel
reads the full history; startup does not, and it does not affect the per-turn
tail.

- Lists every turn per session: tier, model/reasoning level, change reason, time.
- Data comes from the read-only host route `api/auto-router.history` (in memory:
  the two active files plus the current session's live state).
- Archives are not read in the panel; use `/route history [n]` for those.

## Latency, cost and privacy

- At least one small-model call per turn (first classification, with a one-line
  reason): roughly 600鈥?00 input tokens and 10鈥?0 output tokens on
  `deepseek-flash` / `off`, about **楼0.0003鈥?.0006 per turn**; a tool error or a
  checkpoint adds one more call of the same size. The pro confirmation itself
  calls no model.
- The classifier sends the current turn's user text (and the previous two user
  messages as context) to that cheap model, through the provider you configured.
  This is an extra model call on your own account, not a third-party service.
- Local logs: `turns.jsonl` stores the first 200 characters of the turn's user
  text per turn; `decisions.jsonl` stores decision records (tier, reason, model,
  token usage). Both live under `<DSH_HOME>/auto-router/` and can be deleted at
  any time.

## Behaviour limits

- A turn carrying an image or file does not switch models (to avoid sending an
  image to a text-only model); the decision is still recorded.
- The classifier only reads the user batch of the current turn; tool
  continuation steps keep the tier chosen for the turn.
- After a model switch, the baseline config for the rest of the turn becomes the
  new config (shown as `same: true` in the log).

## Tests

```sh
node --test
```

Covers classification and answer parsing, `#` directives (including Chinese tier
names), tier lookup and config merging.

## Uninstall

```sh
dsh plugin --profile <profile> remove dsh-auto-router
```

or remove the bundle in the plugin manager.

## License

MIT 鈥?see [LICENSE](LICENSE).
