# dsh-offpeak · 错峰发送

仓库：<https://github.com/lnqxyz/dsh-offpeak> · 问题与建议：<https://github.com/lnqxyz/dsh-offpeak/issues>

宿主版本要求：`@deepseek-ai/dsh-llm` **`^0.2.2-rc.1`**（与 `package.json` 的 `peerDependencies` 一致；`engines.dsh` 同时要求宿主 `>=0.2.2-rc.1`）。低于这个版本装不上，也不保证 `llm/stream` 的派发参数仍与下文一致。

高峰时段不立刻发出模型调用，等到最近的低谷再发。**只等 DeepSeek 系列**：走 `deepseek` / `workbuddy` 通道的 `deepseek` 模型（0.1.17 起，双条件判定，见下节）。

**高峰** = 周一至周五 09:00–12:00、14:00–18:00（左闭右开，即 09:00 进高峰、12:00 进低谷）。
其余全部是低谷：工作日 12:00–14:00 与 18:00 之后、周六周日全天、周五 18:00 到周一 09:00 连成一段。

规则来自本机 `cordis.patch.yml` 里 DeepSeek 折扣徽标自带的说明：「周一至周五 09:00–12:00、14:00–18:00 属高峰原价，非高峰期积分 5 折」。它同时也是可改的配置项。

## 拦截范围：高峰只等 DeepSeek 系列（0.1.17 起，用户 2026-11-13 拍板）

上面那张价目表是 **DeepSeek 官方 API 的价格规则**，只有挂那条通道的模型在高峰时段真涨价。但本机并没有 DeepSeek 官方直连：`deepseek-*` 系列是走 `workbuddy` / `workbuddy-global` 通道进来的，挂的是那条通道的「非高峰 5 折」。反过来，同一个通道里也跑着别的模型，而 `qwenwork` 这类没有峰谷折扣的通道里也可能出现 deepseek 模型。所以**只看 model 不够**。

判定是两个条件同时成立（**与**，不是**或**）：

1. **provider 命中**：`provider` 字符串里包含 `deepseek` **或** 包含 `workbuddy`（大小写不敏感，**包含**匹配）；
2. **model 命中**：`model` 字符串里包含 `deepseek`（大小写不敏感，**包含**匹配）。

| provider 命中（含 deepseek 或 workbuddy） | model 命中（含 deepseek） | 高峰时行为 |
| --- | --- | --- |
| 是 | 是 | **扣住**，等最近的低谷 + 60–120 秒抖动 |
| 是 | 否 | 立即放行（通道有折扣，这个模型没有；例：`workbuddy` + `qwen3.8-max-preview`） |
| 否 | 是 | 立即放行（模型对，通道没折扣；例：`qwenwork` + `deepseek-chat`） |
| 否 | 否 | 立即放行（例：`qwenwork` + `qwen3.8-max-preview`） |
| 任一条件缺失 / 空串 / 非字符串 | — | 放行（fail-open，见下） |
| 低谷 + 任何组合 | — | 全部放行（本来就是低谷，判定不介入） |

三条边界，都是为了不把判据本身变成新的故障点：

- **只做包含匹配，不要求出现在开头，也不 trim。** `workbuddy` / `workbuddy-global` / `deepseek-official` / `DEEPSEEK-ACCOUNT` 都命中；`my-deepseek-chat`、`x-deepseek-y`、没有连字符的裸名 `deepseek` 也算 model 命中。这是用户明确选择的「按字面执行、不维护白名单」：将来接了名字里带 `deepseek` 的第三方中转，也会被算进拦截范围——这个风险用户已知并接受。
- **大小写不敏感。** `WorkBuddy` / `DEEPSEEK-Official` / `DeepSeek-Chat` 这样的写法照样命中，判定前统一转小写。
- **fail-open。** provider 或 model 任一**缺失、为 `null`、空串、不是字符串** → 整体放行；判定过程中读字段抛错也兜住并放行，不让判据自己把调用卡死。与插件其余判据同一个取向——判据自己出问题时宁可少拦一次，也不要把一次调用扣在高峰里。这不会漏掉真对话请求：宿主把 `provider` / `model` 都声明为 `GenerateOptions` 的**必填 string**（`dsh-llm/src/types.ts:564-567`），缺失只可能出现在别家插件手搓的请求上，而那些本来就不该由本插件管。

判定函数是单独导出的纯函数 `shouldHoldForCall(options)`，直接对 `{ provider, model }` 做判定，可单测；它在闸门里只出现在「高峰且确实是对话请求」之后，窗口计算、抖动、`/peak`、`/peak now`、每会话开关、`dryRun`、断点续跑全部不受影响。**后台调用（标题生成 / 上下文压缩 / 自动审核）先于这个双条件放行**：即便它的 provider 含 `workbuddy`、model 含 `deepseek` 也不拦。

`GET /dsh-offpeak/status` 里有两个诊断字段：`heldModel`（正在等的那个调用的模型名）与 `heldProvider`（它的 provider 名），没有调用在等时都为 `null`。两个条件都在拦截范围内才会有调用被扣住，合起来就是「它为什么在等」的完整现场——万一哪天判据被改坏、或宿主换了字段的取法，从这里能一眼看出扣住的是谁，不必去翻宿主日志。纯诊断，客户端不读它们，界面文案与形状都不变。

## 它做什么

挂一个 `llm/stream` 监听器。命中高峰**且 provider 与 model 都在拦截范围内**时，它返回一个**惰性的** async generator：里面先 `await` 到最近的放行时刻，才调用下游 `next()`。

- **高峰提交的任务**：不会报错，也不会被丢弃。界面显示「正在思考」，实际一个字节都没发出去；到低谷自动开始。
- **只等 DeepSeek 系列**（0.1.17 起）：provider 含 `deepseek` / `workbuddy` **且** model 含 `deepseek` 才等；其余组合（包括「模型对但通道不对」）高峰时立即放行。见上节。
- **只拦你自己那一轮对话**（0.1.11 起）：判据是宿主 `dsh-llm` 的 `isAgentLoopRequest()` —— 只有 `dsh-agent-loop` 组装的那次请求带这个进程内标记。会话标题生成、上下文压缩、自动审核这些**同样带 `sessionId`** 的后台调用一律放行，不会被扣在高峰里。**这两道判据是并列的**：后台调用即便用的是 `workbuddy` + `deepseek-chat` 也照样放行，「是不是对话请求」先于「provider 与 model 是否都在拦截范围」判。
- **在途的调用**：不打断。已经在流式返回的那一次调用照常跑完，插件只拦**下一次**。
- **串行与排队**：不需要插件管。`agent-loop` 本身就是 `while (await this.turn())`，`inbox.claim("next-turn")` 每次只取一条消息。天然串行、天然按提交顺序。
- **重启打断的那一轮**：会被补一条续跑提示自动接上（0.1.4 起，见下节）。等待峰值价格时被重启打断，`turn/end` 会记为 `aborted/disposed`，历史里可能留半截 `assistant/message`（`interrupted: true`）——这正是「需要续跑」的判据，不是丢失。
- **点停止按钮**：立刻取消。用户点停止会 abort 到同一个 `signal`，插件自己 race 它。

## 重启之后（0.1.3 起）

排队中的消息不会因为重启而丢，但重启后**需要有人推一把**，这两件事得分开说：

- **不丢**：每条投递都落一条 `agent/inbox/spliced` 事件，重启加载会话时 inbox 投影按事件重建。队列里还有什么，是完整的。
- **原本不会自己动**：`wakeDriver()` 全仓只有三处调用（`send()` 带 wakeup、maintenance 收尾、`kick()` 收尾）。`resume` 路径只重建 inbox，没有任何人检查 `hasPending` —— 队列会一直躺着，直到用户再发一条消息才被顺带带出来。

0.1.3 挂了个 `agent/created` 监听器补这一脚：只认 `source === 'resume'`，看到 `inbox.hasPending` 就调一次 `agent.wakeDriver()`。

- **顺序不变**：不取出队首再重投（那会把 A、B、C 变成 B、C、A），直接叫醒驱动器让它按原顺序跑。
- **不会重入**：`agent/created` 派发发生在 `initializeAgent` 的 `runMaintenance(...)` 内部，此刻 phase 是 `maintenance`，`wakeDriver()` 只记 `wakeRequested` 不重入；等 announce 返回、`runMaintenance` 的 finally 再自己开循环。
- **绝不因它而打不开会话**：`agent/created` 走 cordis 的 `serial` 派发，监听器抛错会一路上冒到 `announce()`，把整个 agent 创建搞失败。所以整个函数体兜在 try/catch 里，最坏情况只记一条 warn。
- **不 bail 掉别人**：`serial` 只要看到监听器返回非 `null/false/undefined` 就当成 bail、跳过后面所有监听器。所以监听器返回 `undefined`，即使 `recoverPendingOnResume` 为了让测试能断言而返回了状态字符串。

配置项 `resumePending`（默认 `true`）可关。

## 重启时正在跑的那一轮（0.1.4 起，0.1.6 改进投递顺序）

上面那节解决「排队中的消息」；这一节解决另一半：**重启那一刻正在执行的那一轮**。

判据不用另存状态，宿主已经把「这一轮是怎么结束的」写进会话日志的 `turn/end.data.reason`：

| `reason` | 含义 | 续跑？ |
| --- | --- | --- |
| `aborted` + `disposed` | 进程退出 / 生命周期销毁时打断了在途 turn | **续** |
| `interrupted` | 进程被硬杀在 `turn/end` 落盘前，下次加载时由 `interruptedTurnClosers()` 补平 | **续** |
| `aborted` + `user` | 用户自己点的停止 | 不续 |
| `aborted` + `parent` | 父代理取消（子任务被收掉） | 不续 |
| `error` | 上游报错 | 不续（盲目重试只会再撞一次） |
| `completed` / `blocked` / `max-tokens` / `forked` | 正常结束 / 被拦 / 超长 / 分支 | 不续 |

命中后注入一条 user 消息（`source.kind = plugin:dsh-offpeak`），内容是「接着断点继续，别从头重做」+「碰到结果未知的工具调用先核实真实状态再决定是否重试」。**不重放原始 prompt**——它已经在历史里，重放等于让它做两遍。

注入方式是 `inbox.prepend("next-turn")` + `wakeDriver()`，**插到队首**而不是队尾：被打断的那一轮是「正在跑」的那一轮，任何排在 inbox 里的消息都是在它之后提交的，续跑提示必须先跑，否则会变成「先把后来的活干完、再回头接上一轮」。拿不到 `inbox`/`wakeDriver` 时才退回 `followup()`（队尾）。

四条边界：

- **只认 `resume`**：新建会话没有「上一轮」，开机批量 create 的不动。
- **幂等**：注入的消息带自己的 `source.kind`，还在 inbox 里就不再注入；被消费后产生的新 turn 正常结束，判据自然失效。
- **委派会话不续**：子代理 / 队友的会话替它续跑只会白烧额度。
- **读历史失败就放弃**：`session.snapshotEvents()` 是框架里标了 `@deprecated` 的同步读法（`session/event` 收不到 seed 里的历史事件），所以整段兜在 try/catch 里；哪天它真被移除，这功能退化为「不续跑」，不会让会话打不开。

配置项 `resumeInterruptedTurn`（默认 `true`）可关。

## 它不做什么

- **不换 provider，也不换模型**。用的是 profile 里配的那个，插件不碰。「只等 DeepSeek 系列」是**放行判定**，不是路由：provider 与 model 都命中的调用被扣住等低谷，其余组合立即放行，两种都不会改动请求里的 `provider` / `model`。
- **不判断节假日**。工作日遇法定假日仍按高峰处理（用户 2026-11-11 定：这版先不管）。
- **不做提醒 / 周期 / 附件 / 徽标**。本插件只做闸门。原先承担这些的 `dsh-later` 已于 2026-11-11 19:25 整体卸载（用户 2026-11-11 拍板：那些功能都不要），现在 profile 里没有它。

## 界面：每个会话一个开关（0.1.8 起；0.1.18 起只留开关与按钮；0.1.19 起 iOS 观感）

输入框下方（`conversation.composer.dock`）常驻一行，**只有两个东西**：

| 元素 | 说明 |
| --- | --- |
| iOS 风格开关 + 「错峰发送」 | 轨道 51×31 胶囊形（iOS 标准尺寸），圆点 27×27 白色带轻微阴影；**开 = 苹果蓝 `#007AFF`，关 = 黑色 `#000000`**，切换有 0.2s 过渡。黑轨道带一圈 1px `rgba(120,120,128,0.4)` 描边；0.1.20 起**关态与两种禁用态**再套一圈 1px 外光边（外描边不占布局），深色主题下轨道轮廓才看得出来——只有内圈时深色面板上关态对比度只有 1.19:1，现在 3.42:1。开态可点时反而不加这圈，免得蓝轨道多一道边。开 = 本会话照常按峰谷排队；关 = 本会话一律不排队。默认开。滑块与「错峰发送」四个字是同一个按钮，点哪个都行 |
| 「立即运行」 | 只在开关开着、本会话确实有调用在排队、且不在旁路期时出现。点失败（宿主没响应）会就地显示「没能立即运行：宿主没有响应」，不会静默什么都不发生 |

- **不渲染任何状态解释文字**（用户 2026-11-13 拍板）。0.1.17 之前这一行右侧会随轮询写「低谷（半价），立即发送」「高峰（原价），提交会排队到 12:00……」「已排队，将在 12:00 之后自动开始」「已关：本会话不排队」「跟随主会话：已关，本会话不排队」「演练中：只记日志，不排队」「总开关在配置里关闭」等句子；0.1.18 把这些字**全部删掉**。原因是用户明确不要这些字样，而且它们随轮询不断变化、又长又占宽度。想知道现在是不是高峰、什么时候放行，看 `/peak` 或 `GET /dsh-offpeak/status`，信息一样且更完整。
- **错误句是唯一的文字**：只在「立即运行」失败时出现，是那个按钮唯一的反馈，不是状态提示，所以保留；没有错误时整段不渲染（不留空 `span`，否则 flex 的 `gap` 会在开关与按钮之间留空档）。0.1.20 起这句话带 `role="status"`，读屏会念出来；而且**只有再点一次「立即运行」才会被清掉**——以前每 5 秒的轮询成功就把这句擦掉，失败提示最短只闪几十毫秒。
- **按会话独立，且沿父子链继承**：开关状态留在宿主内存里，按 `sessionId` 隔离；子代理会话读取它自己和所有上级会话的开关——主会话关掉，正在跑的子代理也一起不排队；主会话打开，子代理照常排队。链上任何一环关掉都算关。
- **子代理会话里的开关置灰**：继承到「关」时，滑块点不动（`aria-checked="false"` + 整按钮 45% 不透明，没有文字说明）——它自己改不了主会话的决定。
- **关掉即放行**：切换为关的一瞬间会叫醒本会话（以及继承它的子代理）正在等的调用，不会出现「界面显示已关、调用还挂着」。
- **重启后恢复为开**（本版不做持久化，2026-11-12 定）。
- **不能从界面绕过全局配置**：`enabled: false` 是总开关，`dryRun: true` 是演练模式，这两种情况下滑块只展示状态、点不动。
- **路由没装好时**：整行不出现，闸门照常工作，不报错、不显示占位。

界面靠三条宿主侧 HTTP 路由拿状态、切开关，都要求请求头 `x-dsh-offpeak: 1`，且 Host 必须是本机地址：

- `GET /dsh-offpeak/status?sessionId=<id>`
- `POST /dsh-offpeak/release?sessionId=<id>`
- `POST /dsh-offpeak/toggle?sessionId=<id>&enabled=0|1`（返回切换后的完整状态，客户端不必再补一次 GET）

`status` 里有一个 `judge` 字段，告诉你当前用的是哪一套「这次调用算不算真对话」的判据：`agent-loop` = 拿到了宿主导出的 `isAgentLoopRequest`，按宿主标记精确判断；`purpose` = 没拿到那个函数，退化成「带 `purpose` 的就是后台调用」。两者都能用，但退化判据漏一个 `purpose` 就会把别的插件的调用扣住——高峰期真出事时，先看这个字段。

`status` 里还有两个成对的诊断字段（0.1.17 起）：`heldModel`（**正在等的那个调用的模型名**）与 `heldProvider`（它的 provider 名），没有调用在等时都为 `null`。双条件都命中的调用才会被扣住，两个字段合起来就是「它为什么在等」的完整证据，也是判据被改坏时唯一的现场证据。纯诊断，客户端不读它们，界面形状不变。

客户端每 5 秒轮询一次。单次网络失败、非 2xx、坏 JSON **不会让这一行消失**——它保留上一次读到的状态；0.1.18 起读失败不再补任何说明文字，恢复后自然跟上。点「立即运行」= 执行一次 `/peak now`：叫醒正在等的那次调用，并让本会话接下来**只要还在连续调用就不再拦**，停下来 60 秒后自动恢复。

## 配置

改 `cordis.patch.yml` 里 `- id: dsh-offpeak` 的 `config`，或在你的 profile patch 里覆盖同 id。

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `enabled` | `true` | 总开关，关掉即完全不拦 |
| `dryRun` | `false` | 只写日志不拦截。第一次装建议先开，看一轮日志确认规则 |
| `timeZone` | `Asia/Shanghai` | 判定峰谷用的时区 |
| `peakWindows` | 见下 | 高峰窗口数组；给 `[]` = 没有高峰 = 完全关闭拦截 |
| `releaseJitterSeconds` | `[60, 120]` | 高峰结束后再随机等这么多秒，避免整点一起涌出去。**只往后延，不提前**（0.1.20）：下限写成负数会被当成 0，上下限写反或不是数字则整段抖动按 0 处理 |
| `manualReleaseCommand` | `true` | 注册 `/peak` 与 `/peak now` |
| `resumePending` | `true` | 重启后自动推一把上次没跑完的排队消息（0.1.3） |
| `resumeInterruptedTurn` | `true` | 重启后自动接着跑上次被打断的那一轮（0.1.4） |

`peakWindows` 每一项是 `{ days: [1..7], start: 'HH:MM', end: 'HH:MM' }`，`days` 用 ISO 星期（周一 1、周日 7）。`end <= start` 表示跨午夜。

**配错的窗口不会让插件崩，也不会静默失效**（0.1.20 起）：逐项校验 `days` 与两个时刻，不合格的那一项被丢弃并在日志里告警一次（同一处坏值只告警一次，不刷屏），其余合法窗口照常生效。写错成 `start: '9点'`、`end: '25:00'`、`days: '1-5'`（字符串而非数组）这类，以前是整项被跳过、看起来像插件完全不拦；现在至少有一行日志告诉你哪一项被丢了、丢了几项。`peakWindows` 里混进 `null` / 数字这类非对象项，也一样被跳过——以前一个 `null` 能让**所有**模型调用都发不出去。

## 命令

- `/peak` —— 现在是不是高峰、本会话开关状态、本次调用什么时候放行、下一个高峰在什么时候。
  > 0.1.17 起那句预测带一句范围限定：「本次调用将在 X 之后放行（仅 DeepSeek 系列：走 deepseek / workbuddy 通道的 deepseek 模型；其它模型高峰时立即发出）」。命令在调用发生前跑，拿不到即将用的 `provider` / `model`，所以它只能给范围说明，不能预测这一次到底会不会等。
  > 0.1.20 起第一行不再报版本号（用户 2026-11-13 拍板：界面不显示版本号，这条口径一并管到命令输出）。要查版本看下节。
- `/peak now` —— 立即放行本会话排队的调用；并且只要本会话还在连续调用就不再拦，停下来 60 秒后恢复。手动插队用这个，和界面上的「立即运行」是同一个动作。

## 怎么确认「现在跑的是哪一版」

`GET /dsh-offpeak/status` 返回体里带 `version` 字段（0.1.7 起）。0.1.20 起 `/peak` 的第一行不再报版本号，所以**这条路现在只剩 status 一条**。
它读的是 `lib/index.js` 里写死的 `VERSION` 常量 —— 也就是**正在内存里运行的那份代码**的版本，
不是磁盘上 `package.json` 的版本。这两个值在「换包了但宿主还没重新加载」时会不一致，正是最需要区分的时候。

```bash
# 1) 先取宿主地址：打开 DSH 界面，地址栏里形如 http://127.0.0.1:<端口> 的那一段就是。
#    在界面里按 F12 → Console 执行 location.origin，也会直接打印出同一个值。
#    端口每次启动可能不同，所以下面这行要填成你当下看到的地址。
# 2) 填好之后整段粘贴执行。这一步只查版本，sessionId 给任意字符串都行；
#    想看某个具体会话的开关状态，再把它换成那个会话的 id。
DSH_WEB_URL='http://127.0.0.1:<端口>'          # ← 换成第 1 步拿到的地址
curl -s -H 'x-dsh-offpeak: 1' \
  "$DSH_WEB_URL/dsh-offpeak/status?sessionId=check-version" \
  | python3 -c 'import json,sys; print(json.load(sys.stdin)["version"])'
```

## 装法

先打成本地 bundle，再交给 DSH 的插件管理器安装：

```bash
cd <项目目录>                                   # 本仓库根目录（README.md 所在处）
mkdir -p dist                                   # npm 不会自己建目标目录，缺了会 ENOENT
npm pack --cache "$(pwd)/临时/npm-cache" --pack-destination dist
rm -rf 临时/npm-cache                           # 打完就删，别把 npm 缓存留在仓库里
```

`--cache` 不是可选项：它把 npm 的缓存与日志目录钉在仓库内，绕开「本机默认缓存目录不可写」这类环境问题（症状是 `npm error Log files were not written due to an error writing to the directory: ~/.npm/_logs`，命令本身还没开始干活就退了）。四行按顺序整段粘贴即可；`npm pack` 那行会打印产物文件名，`dist/` 里就是可安装的 bundle。

再用 `plugin_manager` 的 `install_bundle`，target 填打出来的 `file:.../dist/dsh-offpeak-<版本>.tgz`。
**不要**手写 `pnpm add`：`pnpm` 不一定在 PATH，且 plugin_manager 会顺带把 bundle 行补进 `dsh.profile.bundles`。

## 为什么这样实现

**闸门只能放在 turn 内部。** 用户手打的消息走 `dsh-api-session-controller` 的 `prompt()`，里面直接 `agent.followup(message)`，中间没有任何插件可挂的 waterfall。所以「消息根本不进 inbox」这个假设只对插件自己投递的消息成立。

**`agent/pre-step` 的 `reject` 会永久丢消息。** `inbox.claim()` 在 waterfall 之前就跑了，`reject` 分支只 `toolSet.dispose()` 就返回，消息已经离开 inbox 又没进日志。

**`llm/stream` 是唯一能同时看到「要发请求了」和「请求能不能取消」的位置。** 全 asar 里模型调用都走 `LlmRuntime.stream()` → `ctx.waterfall('llm/stream', ...)` 这一个派发口，没有旁路。也正因为是同一个口子，它同时会看到别的插件的调用（标题生成、压缩、自动审核），必须靠 `isAgentLoopRequest` 把它们区分开放行 —— 见上面「它做什么」第二条。

**`model` 就是派发参数那一个对象上的顶层字段，不是 `args.model` 也不是 `ctx.model`。** 逐字核对过宿主源码（`app.asar` 内，2026-11-13）：

| 事实 | 出处 |
| --- | --- |
| 派发口把 `options` 原样传给监听器 | `dsh-llm/src/index.ts:1193-1199`（`this.ctx.waterfall(this, 'llm/stream', options, () => this.adapterStream(options, prepared))`）；编译产物同一段在 `dsh-llm/lib/index.js:2506-2508` |
| 监听器签名：第一个参数就是完整请求 | `dsh-llm/src/index.ts:76`（`'llm/stream'(this: LlmRuntime, options: GenerateOptions, next: () => AsyncIterable<StreamChunk>)`） |
| `provider` 与 `model` 都是 `GenerateOptions` 的**必填 string**，并列在顶层 | `dsh-llm/src/types.ts:564-567`（`export interface GenerateOptions ... { provider: string; model: string; ... }`） |
| agent-loop 组装请求时把 config 摊平到顶层 | `dsh-agent-loop/lib/index.js:1098-1105`（`markAgentLoopRequest(Object.freeze({ ...header.config, messages, toolHistory, ..., sessionId, signal }))`），而 `header.config` 就是 `LlmCallConfig`，其字段与 `GenerateOptions` 同名的 1:1 映射（`dsh-llm/src/call-config.ts:31-33`） |
| 下游适配器同样按 `options.model` 读 | `dsh-llm/src/index.ts:1095-1096`（`adapter.prepareCall(options.provider, options.model, options.signal)`） |

所以取法就是 `options.provider` 与 `options.model`——和插件本来读 `options.sessionId` / `options.purpose` / `options.signal` 同一层。两者都只读，不作任何修改。**没有 `args.body.provider` 这种东西**：这个 waterfall 传的不是 HTTP 请求体，而是宿主内部已组装好的请求信封，body 要到适配器里才成形。

注意请求是 `Object.freeze` 过的（LOOP 组装的那一份还 `deepFreeze`），所以只能读、不能改——这也正是本插件不需要改它的原因：拦截范围只是**放行判定**，请求本身原样交给 `next()`。

**必须同步返回 AsyncIterable，不能写成 `async function`。** cordis 的 `waterfall` 是同步递归 `dispatch()`，处理器返回 Promise 会让上层拿不到 iterable。

**双条件判定放在「确认是高峰」之后、而不是放进 `shouldGate`。** `shouldGate` 回答的是「这是不是该由本插件管的那次调用」（总开关 / sessionId / 是不是 agent-loop 请求），与峰谷、provider、model 都无关；双条件判定回答的是「这一次值不值得等」，只有在**确实是高峰**时才有意义。所以它落在 `releaseFor(...) !== null` 之后：低谷路径一个字节都不变，也不会给一个没被扣住的调用写下「排到 12:00」的假日志。

**没有看门狗会杀掉长时间不动的 turn。** `agent-loop.js` 全文搜 `timeout|watchdog|deadline` 零命中；`pi-ai` 适配器的 300 秒空闲超时建在生成器**体内**，插件延迟 `next()` 时它还没 arm。

## 实测记录（真实宿主，2026-11-11）

不是只在假 ctx 里跑过。往 profile patch 里临时写一个「过去 30 分钟 → 未来 4 分钟」的高峰窗口，然后在会话日志里逐 step 量「`step/start` → 首个 `assistant/message` 的 `stream[].time0`」：

| step 起点 | 首包 | 间隔 | 判读 |
| --- | --- | --- | --- |
| 19:08:25 | 19:13:24.861 | **299.70s** | 被拦 |
| 19:14:25 | 19:18:03.993 | **218.62s** | 被拦 |
| 其余 18 个 step | — | 中位数 **2.19s**，最大 3.36s | 正常 |

两次等待区间里**没有任何** `request/header` / `assistant/attempt` / `user/message` 事件，只有一条 `step/start` 挂着 → 请求确实没发出去，不是发出去等回包。第二次的 218.62s 与配置精确吻合：19:14:25 到窗口终点 19:18 共 215s，加 1–2s 抖动。

测完临时块已删除，`diff` 与测试前备份逐字节一致。

### 0.1.11 之后的实测（2026-11-12）

装包后宿主热载了新版本，用真实 HTTP 路由核对（不需要重启宿主）：

| 查什么 | 结果 |
| --- | --- |
| 跑的是哪一版 | `GET /status` 的 `version` 与 `package.json` 一致；同时 `judge: "agent-loop"` —— 说明宿主那个标记函数**真拿到了**，没走退化判据 |
| 开关按会话隔离 | `verify-A` 切到 `enabled=0` 后 `sessionEnabled:false`，同时 `verify-B` 仍 `true` |
| 父子链继承 | 本会话关掉后，一个真实子代理会话读到自己 `sessionEnabled:false` + `inheritedOff:true`；子会话自己 POST `enabled=1` 返回 `ok:true`，但状态仍是关 —— 上级关着它就打不开 |
| 互不影响 | 无关会话 `verify-unrelated` 仍 `true` / `inheritedOff:false` |
| 恢复默认 | 主会话切回开之后，那个子代理会话自动回到 `true` |
| 参数与鉴权 | `enabled=maybe` → 400 `{"error":"enabled"}`；缺 `x-dsh-offpeak` 头 → 403 |

### 客户端那一半：真渲染自检（2026-11-12）

宿主把 `/plugins` 路由放在 web 鉴权之后，`curl` 拿 404，所以**从宿主里**抓客户端 bundle 这条路走不通（试过 registry 与 web-login 的凭据，不绕过鉴权）。改用等价的本地真渲染，harness 已随仓库放在 `tools/visual-check/`：

- `tools/visual-check/harness.html` —— 装真 React 18（vendored 的 production UMD，共 152 KB，不联网）、桩掉 `window.__ModuleLoader__` 收 spec、桩 `fetch` 按 `sessionId` 回不同状态、桩 `ctx.slots.register` 抓组件，把十一种状态一次画出来（低谷 / 高峰 / 已排队 / 跨天放行 / 本会话关 / 跟随主会话关 / 总开关关 / **演练中** / **失败态** / 320px 窄窗 / 520px），外加深色主题三格（开蓝 + 关黑 + 禁用）。顶部有个「模拟宿主无响应」开关（也可用 `?fail=1` 打开），勾上后所有 release 请求都 reject，用来看那一句失败提示长什么样。0.1.18 起这一行只剩开关与「立即运行」；0.1.19 起开关是 iOS 观感；0.1.20 起开关外多一圈 1px 光边，深色主题下关态与禁用态才看得出轮廓。
- 它 `<script src="../../lib/client.js">` 直接加载**项目里真正要发出去的那份**客户端代码，不做拷贝，所以自检不会对着旧快照跑。
- `tools/visual-check/` 不在 `package.json` 的 `files` 里，不随 npm 包发布。

复现（无头 Chrome，截完用 `read_image` 看；若模型不支持图像输入，改用 `#measure` 的 DOM 断言 + 像素采样）：

```bash
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless=new --no-sandbox \
  --disable-gpu --hide-scrollbars --window-size=900,1500 --virtual-time-budget=3000 \
  --screenshot=/tmp/offpeak-shot.png \
  "file://$PWD/tools/visual-check/harness.html"
```

`--headless=new --no-sandbox` 是 2026-11-13 在本机实测需要的：老式 `--headless` 与不带 `--no-sandbox` 都会在 GPU 进程初始化处退出（`GPU process exited unexpectedly: exit_code=6` / `sandbox initialization failed: Operation not permitted`），一个字节都截不出来。

0.1.18 真渲染复核：状态文字删掉后，这一行只剩开关与按钮（以及失败时那一句错误）。用 1440×900 与 320px 两档截图确认：开关在左、按钮紧随其后，320px 不溢出、不折成两行；深色主题下轨道与文字靠 `currentColor` 正常。失败句保留 `flex: 0 1 auto` + `overflow-wrap: anywhere`，窄窗时自己折行，不会把按钮挤出容器。

0.1.19 复核（2026-11-13 15:17）：十态 + 深色两格的截图与 `#measure` 都过——轨道一律 51×31、圆点 27×27，开蓝 `(0,122,255)` / 关黑 `(0,0,0)`，深色面板 `(35,35,41)` 上关态描边像素 `(48,48,51)`、黑轨道内部 `(0,0,0)`，轮廓可辨；320px 格 row `298×31` 单行、开关 `x=35..140`、按钮 `x=146..212`。截图按上面的命令现截现看，不随仓库发布。

0.1.20 复核（2026-11-13 21:23）：十一态 + 深色三格（开 / 关 / 禁用）。深色卡片 `(35,35,41)` 上，关态与禁用态的黑轨道靠外圈那 1px 光边撑住轮廓——外圈像素横向 `(117,117,124)`、纵向 `(122,122,126)`，与面板的对比度 **3.42:1 / 3.66:1**（0.1.19 只有内圈时是 1.19:1 / 1.08:1）；开态仍 `(0,122,255)`，白圆点 `(255,255,255)`，禁用态整枚 45%，白圆点 `(134,134,137)`。截图与 `#measure` 的 14 条记录逐格核对，所有格 `rowInside` 全为 true（没有溢出容器）。失败态那格量到 `role='status'` 与文案「没能立即运行：宿主没有响应」。

它替代不了的部分：本机真实 dock 行里与同排 activity / usage 的相互挤压，那要有真会话在跑的页面才看得见。

## 测试

刚 clone 下来就能跑：

```bash
npm test
```

它跑八个零依赖测试文件，**不需要 `node_modules/`**，也不用先装任何东西。跑了多少条、过了多少条看它自己的输出（末尾的 `# tests` / `# pass`）——这个 README 不写死数字，加了用例之后那些数字就会腐坏。

九个文件里的第九个 `test/integration.test.mjs` **不在 `npm test` 里**：它 `import` 的是项目根下的 `node_modules/cordis.js`，而 `node_modules/` 不随仓库发布，刚 clone 下来跑它只会得到 `MODULE_NOT_FOUND`。所以 `npm test` 只列那八个，集成测试单独给了 `test:integration`。

要跑集成测试，先把那份实现原样取出来：从安装的宿主应用包（asar）里 `dsh/node_modules/@deepseek-ai/cordis/lib/index.js` 这个路径取出该文件，**一个字节都不改**地存成项目根下的 `node_modules/cordis.js`。它是宿主自带的那份实现，不是 npm 上的公开包，所以没得 `npm install`。

放好之后：

```bash
npm run test:integration
```

**全量 = `npm test` + `npm run test:integration`**（八个文件 + 一个文件）。两条都过才算全绿；只跑 `npm test` 也不是漏测，是那条命令按设计就不碰需要宿主实现的文件。

九个文件分别测什么：

- `test/peak-window.test.mjs` —— 纯函数：窗口解析、跨午夜、ISO 星期、放行时刻（含「抖动后仍在高峰就继续推」）、抖动区间、坏时区不抛错。
- `test/gate.test.mjs` —— 闸门：假时钟下的等待与取消、分片等待不超 `setTimeout` 上限、`/peak now` 放行与旁路续期、会话链继承（父关子关、关掉时放行子代理的等待、登记后再复查开关、成环保护）、`status()` 的形状与 `judge` 判据、配置归一与幂等、dryRun 真放行且不登记等待、后台调用（非 loop 请求）不排队。
- `test/model-gate.test.mjs` —— 双条件判定（0.1.17）：`shouldHoldForCall` 的 provider×model 真值表（两关都中才扣；模型对但通道不对如 `qwenwork` + `deepseek-chat` 放行；通道对但模型不对如 `workbuddy` + `qwen3.8-max-preview` 放行；两个都不中也放行）、provider 的 `deepseek` / `workbuddy` 是「或」、只做包含匹配（`my-workbuddy-proxy`、`my-deepseek-chat`、裸名 `deepseek` 都算）、大小写不敏感；缺失 / 空 / 非字符串（含 `Symbol`、`String` 包装对象）/ 读字段抛错一律 fail-open 且不抛错；闸门层面覆盖「高峰 + 双条件命中仍扣到 12:00」「高峰 + 任一条件不中立即放行且不写『排到几点』的假日志」「低谷 + 任意组合放行且一条日志都不写」「dryRun 两态」「本会话关 / 子代理继承关 / 后台调用即便双条件命中仍先放行 / enabled:false 下判定不介入」「`status().heldModel` 与 `heldProvider` 的有无人等两态」，以及「已放行的流一个 chunk 都不少」这条不打断在途的红线。
- `test/integration.test.mjs` —— 用 asar 里真实的 cordis 起一个假宿主，走真实 `ctx.waterfall("llm/stream", ...)` 与 `ctx.serial("agent/created", ...)` 派发，验证「高峰扣住 / 低谷透传 / abort 前不调下游 / 带 purpose 的后台调用照常发出去 / **模型对但通道不对（`qwenwork` + `deepseek-chat`）高峰立即放行（走真实派发参数，确认 provider 与 model 的取法）** / 非 deepseek 模型立即放行 / 字段缺失时 fail-open / 双条件命中仍扣得住 / 服务缺席时闸门照样生效 / 卸载后监听器移除 / 续跑监听器不 bail 掉别人」。
- `test/routes.test.mjs` —— 三条 HTTP 路由：假 req/res 直调 handler，覆盖三层校验（自定义头 / 本机 Host / 同源）、400、405、500 兜底与响应形状，以及会话开关的隔离、继承、透传、唤醒与恢复；另有 `heldModel` / `heldProvider` 随 status 送达、通道不对的 deepseek 模型不误报 `waiting`、响应字段不缺项三条。不起服务、不绑端口。
- `test/recover.test.mjs` —— 排队续跑：只认 `resume`、顺序不变、无 `wakeDriver` 时的退路只挪最后一条且不先删后放弃、委派会话跳过、拿不到会话对象时按「不是委派」处理、所有异常都被吞成一条 warn。
- `test/resume-turn.test.mjs` —— 在途续跑：七种 `turn/end.reason` 的判定表、尾部识别（空 / 无 turn / 运行中 / 空闲）、幂等、消息形状、委派跳过、异常不外泄。
- `test/version.test.mjs` —— `VERSION` 与 `package.json.version` 一致，`status()` 与 HTTP 路由都报同一个版本。
- `test/client.test.mjs` —— 客户端半插件：不装 jsdom，自带迷你 React 运行时（`useState` / `useEffect` / `createElement`），桩掉 `window.__ModuleLoader__` 与 `fetch` 后真的渲染组件并收集可见文字，验证注册契约（槽位名 / id / order / `inject` 拿到的 `sessionId`）、**七种状态下可见文字只有「错峰发送」（排队时多一个「立即运行」）且没有任何状态解释**、开关的可见文字与 `aria-label` 仍是「错峰发送」、iOS 开关的 51×31 胶囊 / 开蓝关黑 / 27px 白圆点 / 0.2s 过渡、开关外那圈 1px 光边只加在「关态」和两种禁用态上（开态可点时反而不加，免得蓝轨道多一道边）、禁用态 45% 不透明且黑轨道描边不消失、**点开关这条主交互**（POST 方法与 `enabled` 参数、失败回落到原状态、`canToggle` 为假时点不动）、「立即运行」只在 `waiting && !bypassing && 会话开` 时出现、点它失败时显示「没能立即运行：宿主没有响应」且这句带 `role="status"`（读屏能播报）、轮询成功不会把失败句擦掉、轮询失败保留上次状态且不追加提示、`readStatus` 的六种分支（含 URL 与请求头）、`ctx.effect` 被拒时退回直接登记，以及模块只导出 `inject` / `readStatus` / `apply`（`hintText` 已随状态文案一起删除）、两处 `title` 悬停提示已删除。

> 0.1.17 之前写的那批「高峰扣住」用例，`options` 里**必须同时带一个命中的 provider 与 model**（各文件顶部的 `HELD_PROVIDER` / `HELD_MODEL` 常量，如 `workbuddy` + `deepseek-chat`）。改成双条件后，只补 model 不补 provider 的请求会按 fail-open 放行，那些用例就会以「闸门坏了」以外的原因变绿——测的是别的东西。

`node --test test/`（目录形式）会把它扫进来并报 `MODULE_NOT_FOUND`，所以要按文件显式列 `.mjs`——`npm test` 与 `npm run test:integration` 就是这么分工的。
