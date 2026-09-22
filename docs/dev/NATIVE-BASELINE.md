# dsh 原生能力盘点（dsh-tree 的地基）

> 2026-09-19 实探，对象：`E:\Programs\deepseek-harness`，`@deepseek-ai/dsh` 0.1.5-rc.2，
> web profile（dsh-base + dsh-web-app + @norman-else/dsh-claude 0.1.54 + dshmarket + remote-web-ui）。
> **本文只记「已经验证为真」的东西。每条都带证据位置，方便版本升级后复查。**

一句话结论：**「对话树」想要的东西，dsh 已经做了大半，而且是第一方实现。
dsh-tree 的正确定位是「把这些散在各处的原生能力收进一个树视图」，不是重新实现它们。**

---

> **本文件是「原生有什么」的证据清单，写于动手之前，用来决定哪些不必自己造。**
> 后来实测发现原生 fork 有两个缺陷（多抄一条待办 / 外部引擎的记忆不跟随），
> 见 `DESIGN.md` §4 —— 下面 §1 只描述接口，不代表它开箱即用。

## 1. 分支（fork）——原生，已可用

### 怎么用
聊天区任意一条消息上悬停 → 动作行里有 **分支图标**（`IconBranchOutline16`）。
点它就从这一轮切一个新会话出来，新会话出现在左侧列表里、缩进在父会话下面。
图标变灰（`branchUnavailable`）= 这个位置不在一个已完成的 turn 边界上。

### 程序接口
```ts
// @deepseek-ai/dsh-api-session-controller/client → ctx.sessions
fork(opts: {
  sessionId: SessionId,
  atSeq?: number,        // 省略 = 从当前进度分支
  increaseTitle?: boolean // 继承标题并自动编号
}): Promise<SessionId>
```

官方注释原文（`lib/types/client/contract/sessions.d.ts`）：

> Fork a session from a **completed-turn prefix** of the source; the boundary is
> the first `turn/end` at or after it; an in-log anchor in an open turn is
> **unavailable rather than clipped backward**.

→ **原生 fork 的粒度就是「一个 turn」**，和我们想要的节点粒度天然一致，不需要自己定义。

### 存储表现
fork 出来的会话在 `session.v3.jsonl.zstd` 的 header 里带：

```json
{"type":"session","version":3,"id":"session-40b7d2c0-…",
 "parentSession":"session-a90af914-…","isSeeded":true,"delegationDepth":0}
```

日志里还会打 `{"type":"session/end-seed","data":{"inherited":true}}` 标出继承前缀的终点。

实例（本机 TEST 桶，已核对）：

| 子会话 | 父会话 |
|---|---|
| `session-40b7d2c0-c437-49f4-9afe-48f43b912381` | `session-a90af914-9e9e-4c69-b3e0-15505bb02014` |
| `session-ae5ce89f-d8da-4abd-a133-79aa23459fce` | `session-dafbcac3-2179-4770-842e-cd3aee994f25` |

---

## 2. 谱系（lineage）侧栏——原生，已可用

左侧会话列表已经**按父子关系缩进**。

```ts
// dsh-api-session-controller/lib/types/client/sessions/lineage.d.ts
flattenLineage(summaries, completed): SessionListEntry[]

interface SessionListEntry {
  sessionId; title?; updatedAt; running; blank;
  parentSessionId?;      // ← 边
  origin?: 'subagent';
  depth: number;         // ← 缩进层级，UI 直接乘缩进宽度
  completed: boolean;    // 后台跑完但没被查看过 → 绿点提醒
}
```

**它是缩进平铺列表，不是树形图** —— 看不出「这个分支是从父会话第几轮岔出去的」。
这正是 dsh-tree 的增量价值所在。

---

## 3. 轮次导航（turnOutline + TurnNavigator）——原生，已可用

### 怎么用
聊天区左侧有一条**轮次梯子**（`TurnNavigator`），一轮一个刻度，
悬停出预览，点击跳到那一轮（会自动把历史页加载到那个 seq）。

### 程序接口
`turnOutline` 是一个**会话投影（projection）**，前端一行 hook 就能拿：

```ts
const turnOutline = useProjection('turnOutline')
// readonly { turn: number, seq: SessionSeq, prompt: string, response: string }[]
```

官方注释（`dsh-session-turn-outline`）：

> the whole-log turn outline (turn number, `turn/start` seq, bounded prompt preview)
> … so a client **can offer every turn of a session and target history paging at
> exact seqs without holding the events**.

→ **这就是树的节点列表，而且不用碰会话文件一个字节。**

实测值（本机 projcache）：

```json
"turnOutline": { "ver": 2, "seq": 30, "val": { "turns": [
  { "turn": 1, "seq": 7,  "prompt": "在吗", "response": "" },
  { "turn": 2, "seq": 22, "prompt": "逐字翻译这段话You are an AI agent powered by DeepSeek Ha…", "response": "" }
], "draft": "" } }
```

投影**按会话持久化**在 `home/storages/session_projcache/sessions/<sessionId>.json`，
所以冷会话也有值，不需要打开会话才能算。

配套跳转接口（`SessionFace`）：`loadThrough(seq)` —— 把历史加载到指定 seq。

---

## 4. rewind（撤回到某一轮）——dsh-claude 已实现，仅限 claude 会话

**这条最容易被忽略，而且和「rewind = 开新分支」的设计是冲突的，必须看清楚。**

### 怎么用
claude 会话里，每条**用户消息**行上有个 rewind 按钮（dsh-claude 注入的）。
点它 → 这条及之后的消息从转录里消失，claude 侧回到那之前，
可选**把工作树也恢复**到那一轮被接受时的状态。

### 实现方式（关键）
```js
// @norman-else/dsh-claude/lib/index.mjs:2633 附近
const pendingRewind = projection.rewind?.pending
const forkAt = pendingRewind && 'resumeAt' in pendingRewind ? pendingRewind.resumeAt : undefined
// …
resume: binding.claudeSessionId,
...(forkAt === undefined ? {} : { resumeSessionAt: forkAt })
```

- **不新建会话**。在**同一个** dsh 会话里记一组 hidden `ranges`（surface seq 区间），
  前端用 CSS `display:none` 把被撤回的行藏起来（`rewindHiddenCss`）。
- claude 侧走 Agent SDK 的 `resumeSessionAt: <uuid>` 重开 —— **官方路径，不是手术**。
- 旁车状态在 `home/plugins/dsh-claude/sessions/<base64(sessionId)>.json`：
  `rewind { ranges, anchors, snapshots, pending }`
  - `anchors`: turn → claude chain uuid
  - `snapshots`: turn → 工作树快照（`recordRewindSnapshot` / `rewindRestoreTree`）
- HTTP 入口：`POST /plugins/dsh-claude/rewind`，body `{ sessionId, seq, restoreFiles }`，
  返回 `{ filesRestored }`。

### 对我们的约束
1. **不要自己再实现一套 rewind。** 两套「什么还在上下文里」的真相会打架：
   hidden ranges 是 per-session 的旁车状态，fork 出的新会话继承不到（或继承到指向不存在 seq 的区间）。
2. **rewind 会动文件系统。** 任何「跳分支」的交互都得想清楚工作树归谁管——
   原生 rewind 至少给了 `restoreFiles` 开关，我们自己造的 fork 路径什么都没有。
3. **宿主自己有一套"就地撤回"的原语：surface replace。** 每条产生消息的事件都带
   `surfaceOp`，`{op:'replace', startSeq, endSeq}` 把一段 surface 节点遮掉（`dsh-session/surface`，
   `foldSurface` 可重放）。dsh-rewind-plugin 和 dsh-retrace 的撤回走的都是它；宿主每次刷新
   系统提示也是一次 replace。**这条和 dsh-claude 的 `ranges` 是两套互不知道的真相**：
   在 claude 会话里用 rewind-plugin 撤回，surface 遮了、Claude 那边没撤。树上两条都认
   （DESIGN.md 撤回一节），但那种错配本身不是树能修的。

---

## 5. 改名——原生

- `SessionFace.rename(title)`（`dsh-api-session-controller`），返回 `{ title, seq }`。
- 本机已有一个 `/rename` 本地插件（`home/profiles/web/local/dsh-command-rename/index.js`），
  走 `ctx.sessionTitle.rename()`，官方服务负责规范化、80 字节上限、
  以及「用户改名后不再被自动标题覆盖」的钉住语义。
- `title` 本身也是投影，会跟着 `SessionListEntry.title` 一起到前端。

→ **分支命名不需要自建旁车存储，用原生 session title 就够。**

---

## 6. 按分支的 model / effort——原生就是 per-session

`model/selection` 是一个会话事件，会话中途可以反复改：

```json
{"type":"model/selection","data":{"provider":"deepseek-official","model":"deepseek-v4-flash","reasoningEffort":"high"}}
{"type":"model/selection","data":{"provider":"claude","model":"opus[1m]","reasoningEffort":"low"}}
```

（本机 `session-40b7d2c0` 一个会话里连着改了 5 次，已核对。）

前端可读投影：

```json
"modelSelection": { "val": { "lastUsed": {"provider":"claude","model":"opus[1m]","reasoningEffort":"low"},
                             "pending": null } }
```

→ **不需要 cordis patch 热改全局配置，也不需要给上游提 issue。**
分支 = 会话，会话自带模型状态，切分支即切模型，天然成立。

---

## 7. 压缩（compact）——事件有，前端投影没有

v3 事件目录里有：`compaction/start`、`compaction/end`、`compaction/summary`、`compaction/prune`
（来源：`dsh-session-format-catalog`）。`/compact` 命令由 `dsh-command-compact` 提供。

但**没有任何现成投影把压缩边界暴露给前端**，前端只有
`contextPressure`（`{surfaceTokens, contextWindow, pressureTokens}`）这种压力指标。

→ 这是 dsh-tree **唯一需要自己写 host 侧逻辑**的地方，而且有正规扩展位（见 DESIGN.md §3.2）。

---

## 8. UI 扩展位——有正规 slot 系统

右侧栏是一个带 tab 的 dock，扩展方式是注册 slot，不是往宿主 DOM 里塞东西：

```js
ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
  name: 'sidebar.right.pane.tab',
  key: 'dsh-tree',
  children: { /* kind: 'keyed' | 'list' | 'chain' | 'single', scope: 'session' */ },
}, TreeBody))
```

可用的 slot 名（`dsh-client-ui-sidebar-right/lib/client.js`）：
`rightbar` / `rightbar.session` / `sidebar.right.pane.tab` / `sidebar.right.pane.tab.title` /
`sidebar.right.tab.menu.item` / `conversation.session.header.corner`。

**对照反面教材**：dsh-claude 的 rewind 按钮是 portal 进宿主 DOM 的，
靠 `[data-chat-flow-kind="user"]` 和 `[class*="actions"]` 这种选择器找座位，
它自己的注释写着 *"fails open: a Host rename makes the selector miss"*。
能走 slot 就绝不要走那条路。

---

## 9. 本地插件加载——两条路

**A. 本地目录（开发期最快，本机已有活样本）**

`home/profiles/web/cordis.patch.yml`：
```yaml
- id: command-rename
  name: './local/dsh-command-rename/index.js'
```
目录里就一个 `package.json`（`{"type":"module","main":"index.js","private":true}`）+ `index.js`。
profile 的 `patchReload: live` 使改了即生效。

**B. 包依赖（带 client 半 / 要发布时）**
```
dsh plugin --profile web pnpm add file:D:/JRJ/Internship/dsh-tree
```
进 profile 的 `package.json` dependencies + `dsh.profile.bundles`。
带浏览器半的插件必须在 package.json 里声明：
```json
"dsh": { "client": { "inject": ["@deepseek-ai/dsh-client-ui-sidebar-right", …], "platform": "web" } },
"exports": { ".": "./lib/index.js", "./client": "./lib/client.js" }
```
`dsh-client-modules` 扫 loader entry 里声明了 `dsh.client` 的包，
composite 成 `window.__DSH_BOOT__` 的模块图送到浏览器。

⚠️ **A 路子能不能带 client 半，没验证过** —— 见 DESIGN.md §6 验证清单第 2 条。

---

## 附录：为什么不要自己解析 `session.v3.jsonl.zstd`

方案初稿写「zstd 解压用 `node:zlib`（Node 22.15+ 原生支持）」。这句话字面成立，
但照着写出来的 store 会**静默只读到第一行，而且不报任何错**。

实测 `session-dafbcac3/session.v3.jsonl.zstd`（14892 字节，Node v22.19.0）：

| 方法 | 结果 |
|---|---|
| `zlib.zstdDecompressSync(buf)` | **211 字节 / 1 行**（只有 header 那行） |
| `zlib.createZstdDecompress()` 流式吃整个文件 | **211 字节 / 1 行**（一样） |
| 逐 frame 切开分别解 | **42192 字节 / 21 行** ✅ |

原因：v3 是**多 frame 拼接**（每次 flush 追加一个独立 zstd frame，这个文件 9 个），
而 Node 的 zstd 绑定解完第一个 frame 就停，不继续、不抛错。

顺带答了原方案的确认点⑥：**frame 级追加**，所以增量解活会话在理论上可行
（记住上次消费到的字节偏移，从那里继续切 frame）。

但这整件事在新方案里已经**不需要了**——`turnOutline` 投影把同样的信息
以结构化、增量、跨平台的形式直接送到前端。把上面这张表留在这里，
只是为了记住「绕开框架自己读文件」的代价长什么样。
