# 自动模型路由（dsh-auto-router）

按**每一轮用户请求的实际内容**，自动切换 DSH 的模型与推理等级（reasoning effort）。

判定不是关键词匹配：每轮开始时，先用一个便宜的小模型（默认 `deepseek-flash` / `off`）读一遍你这一轮的问题，判断「解决它需要多少思考与验证」，再从五档里选一个，并说明原因。关键词规则只在分类器超时/失败时兜底。

- 扩展点：`agent/pre-step`（小模型分类）+ `agent/request`（waterfall，替换本次模型调用的 `LlmCallConfig`）
- 只读判定，不往会话里写任何东西；每次决策追加到 `<DSH_HOME>/auto-router/decisions.jsonl`

## 安装

```sh
dsh plugin --profile <profile> add https://github.com/dakouchiya/dsh-auto-router/releases/download/v1.1.0/dsh-auto-router-1.1.0.tgz
```

也可以下载同一个 tgz，在插件管理里从本地包装入。尚未发布到 npm；发布后可以直接 `dsh plugin --profile <profile> add dsh-auto-router`。

装完到 **设置 → 插件** 里能看到四个常用开关（`enabled` / `dryRun` / `mode` / `logDecisions`）；完整配置仍写在 profile 的 `cordis.patch.yml`（见下文）。

> 随包默认用的是 DeepSeek 内置模型名（`deepseek-flash` / `deepseek-v4-pro`）。如果你用的是别的 provider，把 `provider` 和五档 `model` 改成宿主里真实存在的 id 即可；解析不到的模型会保持当前配置不变，不会发出非法请求。

英文说明见 [README.en.md](README.en.md)。（本地开发时这个目录是以 `@local/dsh-auto-router` 链接进 profile 的；发布到 npm 的包名是 `dsh-auto-router`。）

## 五个档位

| 档位 | 显示名 | 颜色 | 典型场景（由分类器判断） | 落点 |
|---|---|---|---|---|
| `lite` | 轻量 | 白 | 寒暄、确认、闲聊、致谢、一句话事实、简单换算 | `deepseek-flash` / `off` |
| `standard` | 中量 | 绿 | 常规问答、信息查询、简单翻译/改写/总结、单个小改动 | `deepseek-flash` / `high` |
| `deep` | 重量 | 蓝 | 多步推理、调试排错、方案设计、代码实现、长文分析 | `deepseek-flash` / `max` |
| `max` | 较深 | 紫 | 很难、要求高可靠性、大重构/迁移、疑难问题 | `deepseek-v4-pro` / `high` |
| `ultra` | 极深 | 红 | 只有明确要求「极限/不惜成本」或极端疑难才用 | `deepseek-v4-pro` / `max` |

分类器会带上最近两轮用户消息作为上下文，所以「那这个呢」「继续」这类指代能被正确理解。命中开头指令（`#lite` / `#轻量` / `#ultra` / `#极深` …）时直接采用，不再调用分类器。

**注入上下文不会被当成用户输入**：`runtime-context`、`skill-catalog`、`time-context`、子代理的父级说明都被过滤掉，否则它们的长文本会把每一轮都顶到 deep。

**兜底**：分类器超时（默认 6s）、报错、输出无法解析时，退回结构规则（长度、代码块、多问题、少量关键词），并在日志里标成对应 reason；规则兜底只是保险，不是主路径。

## 升到 pro 需要确认（默认 15 秒）

目标模型是 pro（默认匹配 `pro`，可配）且当前基准模型不是 pro 时，会先弹确认：

```
升级到 较深？
[较深] deepseek-v4-pro/high
原因：用户手动切换
预计单价约为当前的 13.3 倍
27 秒后自动不切换        [不切换] [切换]
```

- **不点 / 超时 / 点「不切换」** → 保持原模型（默认不切换），并记入本轮「尝试未切换」；
- 点「切换」 → 本轮切到 pro，后续步骤都用新配置；
- 同一轮只问一次；带图片/附件的回合本来就跳过切模型，不会弹。

配置见下方 `approval` 块：`enabled` / `windowMs`（默认 15000）/ `modelPattern`（默认 `"pro"`）/ `skipWhenPinned`（手动指定时是否免确认，默认 `false`）。

## 配置

写在 profile 的 `cordis.patch.yml`（用户层，升级不丢）：

```yaml
- id: auto-router
  config:
    enabled: true
    dryRun: false          # true = 只记录决策，不改模型（演练模式）
    mode: balanced         # economy | balanced | quality，写进分类器的倾向
    provider: deepseek-account
    tiers:
      lite:     { model: deepseek-flash,    effort: 'off' }
      standard: { model: deepseek-flash,    effort: high }
      deep:     { model: deepseek-flash,    effort: max }
      max:      { model: deepseek-v4-pro,   effort: high }
      ultra:    { model: deepseek-v4-pro,   effort: max }
    classifier:            # 每轮开头用于判档的小模型
      enabled: true
      model: deepseek-flash
      effort: 'off'
      timeoutMs: 6000      # 超时即退回结构规则，不阻塞这一轮
      maxInputChars: 3000
    approval:              # 升 pro 前的人工确认
      enabled: true
      windowMs: 15000
      modelPattern: pro    # 目标模型名匹配这个正则即视为 pro
      skipWhenPinned: false
    history:
      maxBytes: 2097152    # 单个 turn 日志上限，超过即轮转并归档
    logDecisions: true
```

`effort` 只接受 `off` / `low` / `high` / `max`（由当前模型能力决定）。若目标模型不支持配置的档位，会按 `off→low→high→max` 的阶梯就近收敛；模型本身解析不到时**保持原配置不变**，不会发出非法请求。

## `/route` 命令

| 命令 | 作用 |
|---|---|
| `/route` | 查看开关、模式、五档映射、本会话最近一次判定 |
| `/route lite` / `standard` / `deep` / `max` / `ultra` | 本会话临时固定档位（`轻量/中量/重量/较深/极深` 也认） |
| `/route auto` | 恢复自动 |
| `/route catalog` | 列出当前 provider 下所有模型与各自支持的推理等级 |
| `/route history [n]` | 读**归档**的路由记录（默认最近 10 条），平时启动不读归档 |

## 一轮之内会自己改档（由监督模型判断，不是定死阈值）

首档只是起点。同一个回合里，插件会在两个时机把「当前任务 + 刚发生的事 + 当前档位」交给同一个便宜模型，让它输出 `up / down / hold` 并附一句原因，据此只升/降一档：

- **工具报错时**：把错误原文喂给监督模型。它自己判断「这错误是因为档位不够，还是任务本身的问题」——文件不存在这种错就不会误触发升档。
- **每 `rejudgeEverySteps` 步（默认 5）的检查点**：让它看一眼进行得顺不顺，顺利且明显偏高就 `down`，卡住就 `up`。

没有「报错 2 次就升」「12 步就升」这类固定数字。监督模型拿不准就 `hold`（不动），读不到就 `hold`。每次改档都会写日志并反映到徽章；同一轮内会限流（3 秒冷却、最多 `maxRejudgesPerTurn` 次）。

两条与中途改档相关的补充行为：
- 一轮中途你又发了新消息：对新内容重新判定，按新档执行。
- 上一轮被判高但 1–2 步就结束且没调工具：把这条事实写进下一轮分类提示，由分类器决定是否降档。

## 输入框徽章 + 每轮标签

**输入框左侧徽章**（`conversation.input.left`）：

- 显示**实际生效**的档位与模型，如 `中量 flash/high`；
- pro 被拒/超时候显示实际档位，并在悬停提示里注明「目标：较深」；
- 档位中途变化时闪烁一次，并用 `↑`/`↓` 标出方向；
- 数据来自 Host 只读路由 `api/auto-router.state`（只读，1.5s 轮询）。

**回复下方标签**（`conversation.chat.turnTail`）：每个完成的回合一条，点开可看：

- **档位组合**：五档各自落点（零 token 成本，直接读配置）；
- **本轮**：档位（含 `→` 切换方向、未切换标注）、模型（`基准 → 实际`）、推理档位、首判来源；
- **路由开销（从初始到结束）**：首判 + 每次改档各自的 token/约花费（含模型给的原因）、尝试未确认的升档、最后合计。

**装完或更新客户端代码后需要刷新一次页面**（Ctrl+F5），浏览器才会加载新的客户端模块。

## 持久化与归档

- `turns.jsonl`：当前活跃的回合记录，**单个文件上限 2 MB**（`history.maxBytes`）；
- 超过上限时：`turns.jsonl` → `turns.1.jsonl`，原来的 `turns.1.jsonl` 先**归档**到 `archive/turns-<时间戳>.jsonl`；
- **启动时只读 `turns.jsonl` + `turns.1.jsonl` 两个活跃文件**，不碰归档；
- 只有执行 `/route history [n]` 时才按需读 `archive/` 下的归档文件；
- `decisions.jsonl` 仍全量记录每次决策/改档/监督判定，超过 2 MB 轮转为 `decisions.jsonl.1`。
- **本地日志内容**：`turns.jsonl` 每轮会存本轮用户文本的前 200 字，`decisions.jsonl` 存档位、原因、模型与 token 用量，都只落在 `<DSH_HOME>/auto-router/` 下，随时可直接删除。

## 路由历史面板

侧栏底部有「路由历史」入口（时钟图标）。**只有点开面板时才读取完整历史**：启动时不读、也不会影响每轮标签。

- 面板按会话列出每轮的档位、模型/推理档、改档原因与时间；
- 数据来自 Host 只读路由 `api/auto-router.history`（内存态：启动时加载两个活跃文件 + 当前会话实时状态）；
- 归档文件不在面板里读；要看归档用 `/route history [n]`。

## 延迟与成本

每轮至少一次小模型调用（首判，输出含一句原因），每次约 600–900 token 输入、10–30 token 输出，默认走 `deepseek-flash` / `off`，约 **0.0003–0.0006 元/次**；中途报错或到检查点会各再加一次同样的便宜调用。升 pro 的确认本身不调用模型（只是等待），不产生 token。

## 行为边界

- 本条消息带图片或文件时**不切模型**（避免把图片发给纯文本模型），只记录决策。
- 判定只读本轮用户批次；工具续步沿用本轮档位。
- 模型切换后，本轮后续步骤的基准配置会变成新配置（日志里体现为 `same: true`）。
- 插件代码在工作区里，**HMR 不监听 `node_modules` 链接目录**：改完代码要 `remove_bundle` + `install_bundle` 重装，或重启应用；只改配置不需要重装。

## 测试

```sh
node --test
```

覆盖分类/答案解析、`#` 指令（含中文档位名）、档位反查与配置合并。

## 卸载

```sh
dsh plugin --profile <profile> remove dsh-auto-router
```

或在插件管理里移除该 bundle。
