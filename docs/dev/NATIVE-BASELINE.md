# dsh 原生能力盘点（dsh-chat-tree 的地基）

> 2026-09-19 实探，对象：`E:\Programs\deepseek-harness`，`@deepseek-ai/dsh` 0.1.5-rc.2，
> web profile（dsh-base + dsh-web-app + @norman-else/dsh-claude 0.1.54 + dshmarket + remote-web-ui）。
> **本文只记「已经验证为真」的东西。每条都带证据位置，方便版本升级后复查。**

一句话结论：**「对话树」想要的东西，dsh 已经做了大半，而且是第一方实现。
dsh-chat-tree 的正确定位是「把这些散在各处的原生能力收进一个树视图」，不是重新实现它们。**

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
这正是 dsh-chat-tree 的增量价值所在。

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

→ 这是 dsh-chat-tree **唯一需要自己写 host 侧逻辑**的地方，而且有正规扩展位（见 DESIGN.md §3.2）。

---

## 8. UI 扩展位——有正规 slot 系统

右侧栏是一个带 tab 的 dock，扩展方式是注册 slot，不是往宿主 DOM 里塞东西：

```js
ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
  name: 'sidebar.right.pane.tab',
  key: 'dsh-chat-tree',
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
dsh plugin --profile web pnpm add file:D:/JRJ/Internship/dsh-chat-tree
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

---

## 附：dsh 0.2.0-rc.1（桌面版）复查

> 2026-09-29 实探，对象：`E:\Programs\DeepSeek-Harness-Desktop`（Electron 44，
> `resources/app.asar/dsh/node_modules/@deepseek-ai/*` 全是 0.2.0-rc.1），
> profile 固定在 **`$DSH_HOME/profiles/desktop`**（bundles = dsh-base + dsh-web-app）。
> 方法：把 asar 解到临时目录，逐包和 0.1.5-rc.2 的 `lib/index.js` / `lib/client.js` 做 diff，
> 再用桌面版自己的 host 进程（`dsh-desktop-host`，IPC 子进程，端口固定 19387）跑真机验证。
>
> ⚠️ profile 路径要看 `DSH_HOME`：没设时才是 `~/.dsh/profiles/desktop`。设了（本机是
> `E:\Programs\deepseek-harness\home`）就在那底下 —— 和网页版 **同一个 home**：`sessions/`、
> `storages/`、`plugins/dsh-chat-tree/`（shape / labels / icons）、`plugins/dsh-claude/sessions/`
> 两代共用，只有 `profiles/web` 和 `profiles/desktop` 各装各的插件。所以"换到桌面版树就不对了"
> 不是数据没跟过来（2026-10-01 核过，数据一直是同一份），是下面「fork 的 atSeq」那条。
> 确认当前 profile 的办法：`Get-CimInstance Win32_Process` 看 `dsh-desktop-host` 进程命令行的第三个参数。
>
> **2026-10-01 复查 0.2.0-rc.2**（应用 2026-09-30 自动更新，`AppData/Local/@deepseek-aidsh-desktop-updater`）：
> 289 个 `@deepseek-ai/*` 包和 rc.1 逐文件 diff，和我们相关的**一行逻辑都没改** ——
> `dsh-api-session-controller` 只多了 `userQuestions` 投影；`ui-sidebar-right / ui-layout /
> ui-settings-plugins` 只是 CSS module 的哈希换了（我们不靠哈希类名，`hideNativeRail` 是从
> `<style data-plugin-css>` 里正则出来的，不受影响）。会话文件两版都是 **v4**
> （`session.v4.jsonl.zstd`，`SESSION_FORMAT_VERSION = 4`），事件格式和 v3 一样；0.1.5 写的 v3
> 文件被 0.2 打开时会多出一份 v4，`list()` 只认最新一代。小版本升级后照这个办法复查：
> `D:\tmp\claude\extract-rc2.cjs` 用 Electron 当 node 把 asar 里的 `@deepseek-ai/*` 抄出来再 `diff -rq`。

### 一样的（插件不用动）

| 我们用的 | 证据 |
|---|---|
| `webServer.register({kind:'exact', path, handler})` | `dsh-host-webserver/lib/index.js` 两版只差 1 行 |
| `connection.requestRejection(req)`（Host/Origin 围栏 + 签名 cookie，403/401） | `dsh-client-connection` 的 `HostConnectionService.requestRejection` 原样；桌面窗口用 `authenticatedUrl` 带 token 进来换 cookie，之后和浏览器一样 |
| `sessionPersistence.list()` → `{header, revision}`；`open(id,'read').read()` → `{events}` | `dsh-session-persistence-jsonl` 的 `list / open / read` 签名相同 |
| `agent/created` 载荷 `{agent, source}`，`agent.session / inbox`，`agents.get(id).status` | `dsh-agent` 的 `announce()`；`agentOf` 两种形状都认 |
| `sessions.fork(source, boundary)` 的 `parentSession / isSeeded / inheritedEventCount` | `dsh-session` 的 `fork()` |
| 浏览器半：`dsh.client` 声明、`exports["./client"]`、`/plugins/<id>/…` 路由 | `dsh-client-modules` 的 `parseDshClient` 同款；bundle 改由 `/plugins/??a/client.js,b/client.js&rev=` 合并下发 |
| `sessions.list` 的 `ids / byId`（`id, displayTitle, running, blank, cwd, parentId, title`） | `dsh-api-session-controller/lib/client.js` 的 `projectList` |
| `sessions.binding(id)`、`create({workspaceId|cwd})`；`fork({sessionId, atSeq, increaseTitle})` 的**签名** | 同上。⚠️ `atSeq` 的**语义变了**，见下面「fork 的 atSeq」 |
| `workspaces.list.archivedSessionIds` | `dsh-api-workspace-controller/lib/client.js` |
| `shell.overlay` 插槽；`[data-conversation-scroll]`、`[data-chat-turn]`、`[data-chat-flow]`、`[data-composer-seat]`、`[data-trajectory-scroll]`、`TurnNavigator.module.css`、侧栏 `role="tree"/"treeitem"`、`data-ds-dark-theme` | grep 0.2.0 的 client bundle 全在；`conversation.view` 页签 `{ only: active.id }` 一次只挂一个、空白会话 `ConversationSession` 返回 null，两代同款 |

### 变了的（DESIGN.md「设置：两代宿主」「宿主 0.2：浏览器半的三处搬家」）

| 0.1.5 | 0.2 |
|---|---|
| `settings.register(ns, schema)` | 没了；读插件 `export const Config`，字段要 `meta.volatile` |
| 浏览器半 `settingsScope.bind({namespace})` | `configForms.get(entryId)`（返回物形状一样） |
| `settings.plugin.item` 插槽 | 没了；插件管理页自动出表单，另有 `settings.section` 可挂一节 |
| `sessions.list.current` | 没了；列表项 `retainedBy.mainView > 0` |
| `sessions.open(id)` | `uiWorkspace.openSession(id)` |
| 列表项 `completed` | `uiSession.sessionStatus`（`Map<id, {running, pendingInteraction, completionUnread}>`） |
| 兼容性门槛 `dsh.engines` | 只看 `peerDependencies` 里的 `@deepseek-ai/dsh*`（`evaluatePluginCompatibility`，含预发布）；我们没声明，不拦 |
| `fork({atSeq})`：边界 = **第一个 seq ≥ atSeq 的 turn/end**，再抄到下一个 turn/start 之前 | `atSeq` 就是**精确的包含式切点**；切进一轮中间就补 `{kind:'forked'}` 的 turn/end 合上（见下） |
| `sessions.list` 列表项的 `updatedAt` 跟日志走（答完就动） | 只在用户发消息时推进（`api-session/activity`）；回答结束不动它 —— 重拉指纹得把 `running` 算进去（hooks.js 的 `listStamp`） |

### fork 的 atSeq：同名不同义（2026-10-01 从盘上的失忆分支倒推出来的）

`dsh-api-session-controller` 两版 `fork()` 的边界算法：

```js
// 0.1.5：取第一个 seq >= atSeq 的 turn/end 做边界，然后一直抄到下一个 turn/start 之前
const boundary = source.events.find((event) => event.type === "turn/end" && event.seq >= atSeq)
let cut = boundary.seq + 1
while (cut < source.events.length && source.events[cut]?.type !== "turn/start") cut++

// 0.2（rc.1、rc.2 一样）：atSeq 就是边界，切到哪算哪；省略时才取"最后一个 turn/end + 后面的零散事件"
const boundary = atSeq ?? latestCompletedPrefixBoundary(source.events)
const seed = buildForkSeed(source.events, boundary)   // prefix + end-seed + openTurnClosers(prefix, {kind:'forked'})
```

插件 0.2.1 以前传的是节点那一轮的 **turn/start** seq。在 0.1.5 上两者无差（往后找到的第一个 turn/end
就是这一轮的）；在 0.2 上新分支只抄到 turn/start，宿主补一条 `forked` 的 turn/end 把它合上 ——
盘上 `session-054a5154`（2026-10-01，TEST 桶，deepseek-flash）就长这样：

```
seq5  agent/inbox/spliced  inserted「在吗」       ← 继承到的最后一条有内容的东西
seq6  turn/start turn1
seq7  session/end-seed {inherited:true}
seq8  turn/end turn1 {reason:{kind:'forked'}}    ← 宿主补的
seq9  agent/inbox/spliced removedCount:1 outcome:canceled   ← 我们的 adoptBranch 删掉了那条待办（没错，但也说明父会话的第 1 轮整个没抄到）
seq16 user/message「累加3呢」 turn2 → 助手："当前会话里没有前文"
```

所以：**切点传这一轮的 turn/end**（`tree.js` 的 `forkCutSeq`），两代都对。空壳轮
（`forked` 且没有提问）在 `foldOutline` 里剔掉，岔路点才落在模型真正记得的那一轮上。
Claude 会话同样中招，只是少一轮而不是全丢（`forkTurnOf` 看的是原始事件，合成的 turn/end
不在继承段里，graft 自然接在 N-1；树却画在 N）。

### 桌面版怎么装插件

- 官方入口是应用里的 **设置 → 插件 → 安装**，填 `dsh-chat-tree`（npm）/ `github:…` / `link:D:/绝对路径`
  （`dsh-plugin-manager` 的 `install-spec` 认这三种；本地路径必须是绝对路径）。
- 桌面版自带的 `dsh` CLI（Electron 当 node 跑 `app.asar/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js`）
  **拒绝** `--profile desktop`：`profile "desktop" is managed exclusively by the Electron application`。
- 应用没开时也可以手改：profile `package.json` 加 `dependencies["dsh-chat-tree"] = "link:…"`、
  `dsh.profile.bundles` 追加 `"dsh-chat-tree"`，然后用自带的 pnpm 11.7
  （`resources/runtime/pnpm/bin/pnpm.mjs`，同样 Electron 当 node 跑）`pnpm --dir <profile> install`。
  这和管理页做的事一样，`node_modules/dsh-chat-tree` 是指向工作目录的符号链接，改完 build 刷新即生效。
- 装在 profile 外的插件也能 `import '@deepseek-ai/…'`：`dsh-app-boot` 的 `installRuntimeInterception`
  把安装范围内的包（含 `@deepseek-ai/schemastery`）从 asar 里解析给任何路径。我们没用，
  npm 版 schemastery 的 `extra('volatile', true)` 就够。

### 桌面版里的 dsh-claude（2026-09-29 实装）

- 桌面 profile 一开始只有 dsh-base + dsh-web-app，**没有 Claude**；网页版那份 `@norman-else/dsh-claude@0.1.54`
  的 peers 是 `>=0.1.5-rc.1`，但它要的 `@deepseek-ai/dsh-agent-presets` / `dsh-client-runtime` 两个包在 0.2 里已经没了。
- 要装 **0.1.64**（2026-09-29 发布，README 写明面向 DSH `0.1.7-rc.2` / Desktop 2.0.15 这条线，peers 换成
  `dsh-agent-preset` + `dsh-agent-preset-registry`，预设改成 cordis.patch.yml 里声明的 `preset-claude`）。
- 装法：应用里 **插件 → 添加插件** 填 `@norman-else/dsh-claude@0.1.64`，装完在「已安装」里把它的开关**拨开**
  （装完默认是关的，不拨不进 `dsh.profile.bundles`），然后**完全退出再打开**应用。新会话的模式选择器里就有「Claude」。
- forkSession 补丁（AGENTS.md 第 4 节第 6 条）应用不会替你打：0.1.64 里 `resumeSessionAt` 那行仍没有 `forkSession`
  （`lib/index.mjs` 第 2985 行，2026-10-01 核过）。要手动把补丁文件放进 `$DSH_HOME/profiles/desktop/patches/`，
  在 `pnpm-workspace.yaml` 加 `patchedDependencies`，再用自带 pnpm 重新 install —— 应用**关着**的时候做：

  ```powershell
  $env:ELECTRON_RUN_AS_NODE = 1
  & "E:\Programs\DeepSeek-Harness-Desktop\DeepSeek Harness.exe" --expose-internals `
      E:\Programs\DeepSeek-Harness-Desktop\resources\runtime\pnpm\bin\pnpm.mjs `
      --dir E:\Programs\deepseek-harness\home\profiles\desktop install
  ```

  装完 `grep forkSession node_modules/@norman-else/dsh-claude/lib/index.mjs` 要能搜到。
  ⚠️ 2026-10-01 发现桌面 profile 的 `patches/` 一直是空的、`pnpm-workspace.yaml` 也没有
  `patchedDependencies` —— 9-29 那次只装了 dsh-claude，补丁没跟上。已把补丁文件和 yaml 补好，
  但 install 要等应用关掉才能跑（跑的时候正在用桌面版和 Claude 对话）。
- dsh-claude 自己也在 `agent/created` 上读新分支的旁车（`align()` → `sidecar.read()`，缓存进
  `#latest`，"disk is read once"）。我们的 graft 是**同步**写在同一个事件里的，所以只要父会话
  空闲，文件先于它那次 `readFile` 落盘，没事；父会话在跑时 graft 要等 2s 后补做，那时 dsh-claude
  已经把"没有旁车"缓存住了，补上的文件它不会再读 —— 这条"补接"在 0.1.54 / 0.1.64 上都接不上
  （AGENTS.md 已知问题）。UI 上 `forkBlockedWhy` 挡住了"在跑的 claude 会话上开岔路"，所以日常碰不到；
  原生消息行上的分支按钮绕得过去。

### 真机验证过的（桌面 host + 无头 Edge，2026-09-29）

四条路由 200 / 无 cookie 401；index 注入里带 `dsh-chat-tree`，合并 bundle 200；
新建会话后导轨出现在聊天区右缘、`__dshTree()` 报"可写=true 状态=ready 模式=host"；
设置导航里有「对话树」一节，3 条滑杆 + 12 个色值框。宿主日志里"2 entries did not activate"
是 telemetry 缺 `serviceVersion`（不经 Electron 壳启动才有），与我们无关。
