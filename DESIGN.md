# dsh-tree

把一个对话的所有分支画成一棵树，贴在聊天区右缘。点一个节点跳到那一轮，点 ＋ 从那儿接着问。

只依赖 dsh 本身。装了就能用，删掉也什么都不坏。

---

## 1. 装 / 卸

插件是两个文件：`index.js`（跑在 dsh 进程里）和 `client.js`（跑在浏览器里）。

**装**：往 `$DSH_HOME/profiles/web/cordis.patch.yml` 里加三行

```yaml
- insert:
    - id: dsh-tree
      name: 'file:///绝对路径/dsh-tree/index.js'
```

**卸**：把这三行删掉，重启 dsh。

改了 `index.js` 要重启 dsh；只改 `client.js` 刷新浏览器就行（插件在 profile 目录之外，host 半没有热重载）。

**它在仓库外留下的东西**，一共两处：

| 什么 | 在哪 | 卸载后 |
|---|---|---|
| 安装条目 | `cordis.patch.yml` 的三行 | 自己删 |
| 节点自定义名字 | 浏览器 `localStorage['dsh-tree.labels']` | 留着，无害（MVP 妥协，以后该挪到 `ctx.storage.domain`） |

另外，**只有在装了 `dsh-claude` 的情况下**，插件会往
`$DSH_HOME/plugins/dsh-claude/sessions/<会话id>.json` 写文件（见 §4）。写的是那个插件
自己也会写的东西，只是提前写好；卸载 dsh-tree 后这些文件照常被 dsh-claude 使用。

---

## 2. 术语

| 叫法 | 是什么 | 在 dsh 里对应 |
|---|---|---|
| **对话** | 一整棵树 | 一组有血缘关系的 session |
| **分支** | 树上的一条链 | 一个 session |
| **节点** | 一问一答 | 一个 turn |
| **空节点** | 树根那个虚点 | 无，纯 UI |
| **压缩节点** | 发生过上下文压缩的那一轮 | `compaction/end` 事件 |
| **岔路点** | 一条分支是从父分支第几轮分出来的 | 继承前缀里最后一个 `turn/end` |

---

## 3. 数据从哪来 —— 树是算出来的，不是存出来的

| 信息 | 来源 |
|---|---|
| 分支之间的父子边 | session header 的 `parentSession` |
| 分支里有哪些轮 | 自己折日志（`turn/start` / `user/message` / `turn/end`） |
| 岔路点 | `session/end-seed {inherited:true}` 之前的最后一个 `turn/end` |
| 现在滑到哪一轮 | DOM 上的 `[data-chat-turn]` |
| 节点自定义名字 | localStorage（唯一自研存储） |

好处：树永远和真实状态一致（它就是真实状态的一个视图），插件删了什么都不坏，不需要迁移。

### 为什么需要 host 半

浏览器那边拿不到**冷分支**（fork 出来但没打开过的）的轮次。宿主的会话列表是这么写的：

```js
header.isSeeded ? undefined : cache?.cachedSnapshot(header, SessionLogOffset(0))
```

—— 对 seeded（= fork 出来的）会话直接返回 `undefined`。而 fork 出来的会话正是"分支"本身。
所以 host 半自己折一遍日志，用一条路由喂给前端：

```
GET /plugins/dsh-tree/outlines?cwd=<工作目录>
```

按 persistence 给的 `revision` 缓存，没变就不重读盘。

---

## 4. 必须修的两个原生缺陷

两个都在 host 半的 `agent/created` 监听里处理 —— **分支一被造出来就接管**，
不管是谁造的（本插件的按钮、原生消息行上的分支按钮、将来的命令行），没有旁路。

> ⚠️ **不要把这件事挪到浏览器里做。** 试过包 `ctx.sessions.fork`，**一次都没生效过**；
> 而且原生那个分支按钮本来就绕过任何客户端包装。

### 缺陷一：fork 会多抄一条待办（所有 provider 都中招）

宿主的切法是"切在 `turn/end`，然后一直吃到下一个 `turn/start` 之前"。真实例子：

```
seq37  inbox 入队「加上44呢？」   ← 用户抢跑打的字，还没轮到它
seq38  turn/start turn3「加上22是多少」
seq45  turn/end   turn3
```

在 turn3 后面开岔路，继承前缀到 seq45，**seq37 那条入队也在里面**。新分支一激活先把
「加上44呢？」跑一遍，再跑用户新打的字。

这也是「点节点 N，分支却接在 N+1 后面」的真身：**每条提问都是在上一轮结束后才入队的**，
所以在 N 处开岔路必然继承到"N+1 的那条提问"。不是 UI 的 off-by-one。

**修法**：把继承段的 inbox 折一遍，拿到那几条的 id，逐个 `agent.inbox.remove(id)`。
盘上 21 个真实分支里有 13 个中招。

> ⚠️ **按 id 删，不要 `inbox.clear()`**：dsh 重启会把每个会话 resume 一遍、同样触发
> `agent/created`，那时队列里可能正躺着用户自己排的待办。
>
> ⚠️ **也不要加"只认刚出生的分支"之类的前置判断。** 踩过：判据用
> `session.isOwnSeq(session.inheritedEventCount)`，而 `session/end-seed` 恰好就写在
> `seq == inheritedEventCount` 上、创建那一刻就存在，于是判断恒为 true，
> **整个接管一次都没跑过**。按 id 删本身就是幂等的，不需要任何前置判断。

### 缺陷二：外部引擎的记忆没跟过去（只有 dsh-claude 这类中招）

正常接入的 provider（deepseek 等），对话原文就在 dsh 自己的日志里，
模型每轮的上文也是从这份日志重建的 —— fork 把日志前缀抄过去，新分支自然记得前文，
**插件一个字都不用管**。

`dsh-claude` 是例外：它不是 API provider，而是把本机的 Claude Code 当对话引擎。
日志里每条 `assistant/message` 的 `content` 都是空的：

```
deepseek-official  seq16 assistant/message  content=[{"type":"text","text":"在的，…"}]
claude             seq24 assistant/message  content=[]          ← 一个字都没有
```

真正的对话在 Claude Code 自己的会话里，dsh 只存一个指针（sidecar 的
`binding.claudeSessionId`）。指针没跟过去，新分支就拿到一个全新的空会话。

**修法**：用桥接自己的机制。给 SDK 传 `resume:<父会话>` + `resumeSessionAt:<那一轮的锚点>`，
SDK 会分叉出一个新的 Claude Code 会话而不是改写父会话（原生 `/rewind` 走的就是这条路）。
触发开关是 sidecar 里的 `rewind.pending = { resumeAt }`。所以接管时替新分支把 sidecar 写好：

```
binding         ← 抄父分支的（指向同一个 Claude Code 会话）
rewind.anchors  ← 裁到岔路那一轮
rewind.pending  ← { resumeAt: 那一轮的锚点 uuid }
activities      ← 裁到岔路那一轮（UI 里助手正文的唯一来源）
```

| 边界情况 | 处理 | reason |
|---|---|---|
| 岔路点落在继承段里（分支的分支） | 沿血缘上溯找持有该锚点的祖先 | —— |
| **一路上都没有 sidecar** | **什么都不做**，原生 fork 已经够了 | `native-context-is-enough` |
| 有 sidecar 但缺这一轮的锚点 | 什么都不做 | `no-anchor` |
| 新分支已经有 sidecar | 拒绝覆盖 | `child-already-bound` |
| dsh-claude 升了 sidecar 格式 | 停手（它的解析器遇到不认识的文档会 throw） | `native-context-is-enough` |

**依赖关系：没有。** 不 import dsh-claude，也不要求它装着，判据只有"那个文件在不在"。
最差的后果只是新分支失忆，**不会弄坏任何已有会话**。

> ⚠️ **半成品不许进大纲缓存**：分支刚建出来那一瞬间 `session/end-seed` 可能还没落盘，
> 这时折出来的大纲会把继承轮全当成"自有"。一旦被缓存，要等这条分支下次写日志才会刷掉。
> 判据：宿主说它 seeded，却找不到岔路点。

---

## 5. UI

### `dsh.client.inject` 要跟着挂载点走

`package.json` 里这张表决定浏览器半能用到谁，写漏了就是运行时才炸。当前五项各有出处：

| 声明 | 为什么要 |
|---|---|
| `dsh-api-session-controller` | `ctx.sessions`（列表 / open / fork / jump） |
| `dsh-api-workspace-controller` | `ctx.workspaces`（归档集） |
| `dsh-client-ui-layout` | **声明 `shell.overlay` 的就是它**，导轨挂在这 |
| `dsh-client-ui-chat` | 我们读它的 DOM：`[data-conversation-scroll]`、`[data-chat-turn]`、`TurnNavigator.module.css` |
| `dsh-client-ui-settings` | 设置卡片的 `settings.plugin.item` |

> ⚠️ 改挂载点时**必须同步改这里**。从 `conversation.session.header.utilities` 换到
> `shell.overlay` 那次，原本写的是 `dsh-client-ui-conversation` —— 那个包既不声明
> `shell.overlay`、也不拥有上面三个 DOM 锚点（它们全在 `ui-chat`），留着是纯误导。

改这张表**要重启 dsh**，光刷新浏览器不够。改完导轨要是没了，先把这里回滚。

### 挂在哪个 slot —— 决定了切会话会不会"闪"

导轨注册在 **`shell.overlay`**（`scope: "root"`，由 `AppFrame` 常驻渲染）。

> ⚠️ **不要**挂回 `conversation.session.header.utilities`。宿主把它声明成
> `scope: "session"`（见 `dsh-client-ui-conversation` 的 slot 注册），切会话时整个
> session 子树连同我们的组件一起卸载重挂：`box`、`activeTurn`、缓存的树全部清零，
> `outlines` 还要重新 fetch（带 120ms 防抖）。导轨会**真的消失再出现**，机器越卡越明显。
> 这不是"渲染慢"，靠保留上一帧数据救不了 —— ref 本身都跟着没了。

代价：导轨变成全局常驻，设置页/全局面板上也会渲染。用"量不量得到聊天区容器"当开关，
并加 `graceMs`(600ms) 宽限期区分两种消失：

| 聊天区容器 | 含义 | 处理 |
|---|---|---|
| 短暂消失（< 600ms） | 正在切会话 | 保留上次几何，什么都不动 |
| 持续消失（≥ 600ms） | 不在会话界面 | `box = undefined`，导轨收起 |

收起时组件**不卸载**，hover / 上一棵树都还在，切回来是瞬时的。

### 坐标

- **y = 树深度**，不是"第几行"。所以同一个岔路点分出去的两条支线，第一个节点**同高度**。
- **x = 列**，且**与"当前在哪条分支"无关**。同一会话的延续继承本列（主干天然是直线），
  岔出去的分支各领一个新列往左排。切分支只换颜色，**图的形状不动**。
- **省略**：只画离当前这一轮 `visibleRadius` 步以内的节点，放不下再压行高。
  距离是树上的**无向**步数 —— 父节点 1 步，父节点的另一个孩子 2 步。

### 省略（`elide`）

裁完要把 `depth` **重新压实**成连续的 `row`，否则藏了节点也腾不出地方，等于白做。
`rowOf` 就是干这个的；`visibleRadius = 0` 时 `row === depth`，整套退化成老画法
（test-elide.mjs 用例 3 钉着这条）。

省略号画在**树被剪断的地方**，不是"最上面一行"：留下来的节点丢了父亲 → 它那一列上方一个
`⋯`；丢了孩子 → 那个孩子所在的**列**下方一个 `⋯`。所以一条被整段砍掉的岔路，也会在它自己
的空列里留个记号，而不是凭空消失。

⚠️ 基准点是**正在看的那一轮**，所以滚动会让可见集变化、树跟着重排。这是功能本身决定的，
不是 bug；嫌晃就把半径调到"不省略"。

### 设置

host 半用 `ctx.inject(['settings'], …)` 注册 namespace `dsh-tree`（**不能**写进顶层
`inject`——没挂设置提供方的部署会让整个 fiber 永远 pending）。浏览器半用
`ctx.settingsScope.bind({namespace:'dsh-tree'})` 读写，并把卡片注册到 `settings.plugin.item`。

宿主只在「host 服务了这个 namespace」**且**「有卡片认领它」时才渲染，所以 host 半没重启时
卡片整个不出现，前端自动退回默认半径 10 —— 这也是为什么改完 `index.js` 必须重启 dsh。
**反过来说：卡片只要出现了，就证明 host 注册成功了**，这时候再出问题一定在前端。

卡片外观照抄 `ui-settings-plugins` 的 `PluginCard` / `fields`：外层 `<li>`（宿主铺的是
`<ul>`）、16px 圆角、点标题行展开、14px 折角箭头转 180°。颜色一律走 `--dsw-alias-*`
变量而不是写死色号，换主题自动跟随。

⚠️ `writable` 要**逐帧**判断。第一帧几乎必然是 `status:'loading'` + `writable:false`，
当时若把 `set` 删掉就再也加不回来，滑杆永远是灰的（踩过，test-elide.mjs 用例 8 钉着）。

设置项写在 `FIELDS` 表里，卡片按表渲染、store 按表取值 —— 加一项只改这张表和 host 的
schema，别再去动卡片。**字段名两边必须一模一样**。

### 缩放（`scaleZ`）

`Z` 里的几何量按百分比整体缩放：`dot` / `lane` / `hit` / `row` / `ell`。
`restMs`（时间）和 `card`（详情卡宽度）**不缩** —— 卡片跟着放大只会挡住聊天区。

关键不变式：`scaleZ(100)` 必须与 `Z` **逐字段相等**，否则"默认值"会悄悄改掉现有画法
（用例 10 钉着）。另外 `hit / lane` 的比值必须恒定 —— 命中区比列距宽 4px，
只缩一个会让相邻列的命中区互相吞掉。

描边宽度和外发光在 `dotStyle` 里按 `size / Z.dot` 同比走，不然点放大后边框细得看不见。

### 节点形态：形状归 kind，状态归 active/focused

两者**正交**，`dotStyle(kind, active, hover, size, focused)` 一次性算出所有字段。

| | 形状 | 谁决定 |
|---|---|---|
| 普通轮次 | 正圆 | `kind` |
| **压缩轮次** | **菱形**（转 45°、几乎不倒角）+ 橙色 | `kind` |
| 树根空节点 | 虚线圆 | `kind` |
| 在当前路径上 | 边框变亮、填充淡色、不透明 | `active` |
| 正看着这一轮 | 实心填充 + 外发光 | `focused` |

> ⚠️ 别再写 `kind = focused ? 'current' : node.kind`。那样压缩节点一滑到就变回蓝圆点，
> "一眼看出是压缩节点"恰好在最该看清的时候失效（test-highlight 用例 5 钉着）。

压缩标记来自 host 半：`compaction/end` 的 `data.turn`。

> ⚠️ **压缩失败也会发 `compaction/end`**，只是带 `error`（宿主校验器：成功的 end 必须
> 配一条 `compaction/summary`）。不看 `error` 就会把没压成的轮次画成菱形。

**桥接兑底**：`dsh-claude` 这类桥接里，`/compact` 不会被 dsh 的命令分发拦下，
而是当普通提示词发给外部引擎，压缩全程在引擎内部完成 —— dsh 日志里一条
`compaction/*` 都没有（盘上 64 个会话实测为 0）。所以还认一条：**本轮提示词以
`/compact` 开头**。两条判据并存，原生 provider 走 `compaction/end` 那条。

### 高亮：边框归路径，填充归滚动

```
边框蓝  ⟺  这个节点在当前会话的对话里
填充蓝  ⟺  边框已经是蓝的  且  轮次号 == 现在滑到的那一轮
```

落成代码是给血缘链上每个会话记一个"轮次上限"，从当前会话往祖先走，
上限取**一路上岔路点的最小值**（A→B→C→D 时，D 只继承 C 的前 2 轮而 C 继承 B 的前 3 轮，
那么 B 的第 3 轮不在 D 的对话里 —— 只看相邻一层会多算）。

> ⚠️ **别改回"从末端节点沿 `node.parent` 往上爬"**：一条分支的岔路点若落在父分支继承来的
> 那一段里，挂载点会退回好几层，沿 parent 走就跳过中间节点 —— 屏幕上是"稀稀疏疏几个蓝点"。
>
> ⚠️ **填充那条不许加"节点属于当前会话"**：继承来的那几轮画在图上的是**父会话的节点**，
> 加了这个条件，往上滑到继承段就一个点都不亮。
>
> ⚠️ **节点样式的 key 集合必须在所有形态间一致，边框只用 longhand。**
> 踩过一次，症状极具迷惑性："滑过一个点它就白一个，越滑越花"，看着像高亮算错了，
> 其实是 React 的内联样式 diff —— 它会把**上一帧有、这一帧没有**的属性置空。
> base 写 `border: '1.5px solid 蓝'`（简写）、"当前轮"那一支额外写 `borderColor`，
> 切回来时 `borderColor` 被清成 `''`，border-color 退回 `currentColor` → 白边框，
> 而 `border` 简写字符串没变、React 不会重写回去。

### 交互

| 操作 | 结果 |
|---|---|
| 单击节点 | 跳到那一轮 |
| 悬停节点 | 右侧滑出详情卡（名字 / ＋ / ↺） |
| 双击节点名 | 就地改名 |
| ＋ | 从这之后接着问（见下） |
| ↺ | 这一轮重来 |

**点击：尽量不换路径。** 点的节点如果就在当前路径上，**留在当前会话里滚过去**，
不要切到"这个节点所属的那个会话"。能这么干是因为 fork 把父分支日志原样抄了一份、
**seq 一个都没变**，所以同一个 seq 在当前会话里指的就是同一轮。

> 不这么干的后果：路径是 1-2-6-7-8 时点一下节点 2 → 切到父会话 → 高亮整条换成 1-2-3-4-5。

**＋ 什么时候才真的 fork：**

| 点的是 | 动作 | 为什么 |
|---|---|---|
| 树根空节点，**底下还没有分支** | **什么都不做**（＋ 直接不画） | 刚建的对话本身就是那条空对话，再开一条只是复制粘贴 |
| 树根空节点，底下已有分支 | 新建对话 | 这才谈得上"再开一条" |
| **叶子节点**（后面既无后续轮、也无别的分支） | **就在本会话往下问，不 fork** | 复制一份只会在左边多出一条内容完全重复的会话 |
| 有后续的节点 | 真的 fork | 这才是要岔开 |

新建对话时**必须传 `workspaceId`，不能只传 `cwd`**。

> ⚠️ 侧栏按 `workspace.sessionIds` 这张显式成员表分组，和 cwd 无关。只传 cwd 建出来的
> 会话不在任何成员表里，于是掉进"未分组"分组。宿主自己的新建按钮就是
> `sessions.create({ workspaceId })`。查不到归属时才退回 cwd。

### 哪几条对话算同一棵树（`shape.json`）

dsh 只记 fork 血缘（`parentSession`）。"两条互不相干的对话算同一棵树"和"这条支线被
手动拆出去了"是**我们自己的概念**，任何日志里都没有，只能自己存：
`$DSH_HOME/plugins/dsh-tree/shape.json`。

```json
{ "version": 1, "groupOf": { "<会话>": "<树编号>" }, "detached": ["<会话>"] }
```

放 home 不放 localStorage：换浏览器、进手机都还在。跟 `/outlines` 一起下发，少一个往返，
也避免"大纲到了形状没到"那一帧的错分组。

**分组必须是主动登记的。** 在空节点上按 ＋ 开出来的新对话，才登记进当前这棵树
（`api.fresh` 拿到新 id 后立刻 `reshape`）。没登记过的对话各自成树。

> ⚠️ 试过"整个 cwd 全算一棵"：16 条未归档对话把导轨撑到 326px，而且三条毫不相干的
> 对话挤在同一个空节点下面。别再回去。

**分离**：剪的是**图上的边**，不是会话边界。

> ⚠️ 别按"是不是 fork 出来的新会话"来判断。节点 1 后面跟着 2/3/4/5 时，2 是会话自己的
> 下一轮、3/4/5 是 fork，但它们在图上都只是 1 的一个孩子 —— 按会话判断会让唯独 2 没有
> 分离按钮（踩过，test-highlight 用例 10 钉着）。

| | |
|---|---|
| **能不能剪** | 一路往上只要有**任一祖先有多个孩子**就能。`node.canDetach = parent.children.length > 1 &#124;&#124; parent.canDetach`，父在前子在后遍历时 O(1) 顺带算出来，不用点击时回溯，也不会因为别处新增/分离而过期 |
| **剪在 N 之后** | 新树 = 根到 N 父亲那段**路径（前缀，照抄）** + N 的整棵子树；旧树 = 原树扣掉 N 的子树 |
| **站在哪棵** | 当前会话最深的那个节点所属的那棵；这条会话一轮都还没有就待在 root 那棵 |

`detached` 记的是**节点 key**（`<会话>:<轮次>`）。早先记的是纯会话 id，`cutSet()` 会把
老记录翻成它第一个自有轮次的节点，免得之前拆过的悄悄失效。

> ⚠️ 剪边必须排在**算列之前**，否则剪掉的子树还占着列宽，导轨白白变宽。

**合并**还没做。

### hover intent：让鼠标够得到自己那个 ＋

详情卡贴在导轨**左**外侧（右边是聊天区边缘，没地方放），＋ 在卡片右缘。于是鼠标从
节点走到 ＋ 必须**横穿左边每一列**。而列间距只有 14px、命中区却宽 18px ——

> ⚠️ 往左挪 5px 就进了左邻居的命中区，悬停被抢、卡片换人。结果就是
> **只要一个节点左边还有节点，它的 ＋ 就永远按不到**，按下去加的是左邻居的子树。

做法是业界标准的 hover intent（jQuery hoverIntent，2007）：**整条导轨只有一个
`mousemove`**，节点上不挂 `onMouseEnter`。

| 状态 | 行为 |
|---|---|
| 还没开卡片 | 碰到点立刻开（要跟手） |
| 卡片开着，压着同一个点 | 不动 |
| 卡片开着，压着别的点 | 起 `restMs`(140ms) 计时器；**任何一次移动都把它清掉** |

于是"手还在动"= 你在赶路，谁都抢不走卡片；"停下来"= 你真想选这个点，换过去。
横穿多少列都无所谓，这是几何上绕不开的问题，只能靠时间维度区分意图。

决策抽成纯函数 `hoverNext(hover, at)`，返回 `keep` / `now` / `rest`。

> ⚠️ 卡片开着时换目标**必须**返回 `rest`。改成 `now` 就等于退回挂 `onMouseEnter`
> 的老做法，＋ 立刻又够不着了（test-highlight 用例 6 钉着，改回去炸 9 条）。

**推翻过的方案**（别再试）：透明走廊 + 梯形 `clip-path` + "掉头就让位" + 超时拆除。
四套启发式互相兜底，实测仍够不着；而且 `handOver()` 让位时若算出"压着的还是当前这个
点"，`hover` 不变 → 依赖 `hover.node.key` 的 effect 不重跑 → `bridge` 永久停在
`false`，走廊再也不出现。鼠标右移抖 2px 就能触发。

### 连线：先横后竖

跨列那条折线**必须先横向挪到自己那一列、再往下走**。

> ⚠️ 反过来（先竖后横）时，从节点 2 岔到节点 4 的竖线会在第 0 列从 2 一路压到节点 3
> 头上再拐弯，看着像"经过 3 之后转个弯到 4"。

### 和原生轮次导轨的关系

原生那条只管当前会话的轮次，我们这条是它的超集，所以把原生那条藏掉
（从它自己注入的 `<style data-plugin-css*="TurnNavigator.module.css">` 里正则出带哈希的类名前缀）。
取不到就不藏 —— fail-open，宁可两条并存也不要整个导轨崩掉。

---

## 6. 测试

三个离线脚本，都不用开浏览器。**每个断言都验证过"能抓住对应的 bug"**（把修复退回去会当场炸）。

```bash
node test.mjs                 # 拿真实会话日志跑整条渲染管线，--print 打印 ASCII 树
node test-highlight.mjs       # 手捏的小树，钉死高亮的边界情形 + 样式 key 集合
DSH_HOME_REAL='...' node test-branch.mjs   # 把真实分支倒带到"刚出生"那一刻，重放接管逻辑
```

`test.mjs` 和 `test-highlight.mjs` 取的是 `client.js` 的 `__pure` 出口 ——
**测的是真代码，不是复制品**。

浏览器控制台里 `__dshTree()` 可以把当前树的真实状态倒出来（每个节点的蓝/白、血缘、岔路点、归档集）。

---

## 7. 还没做

- 节点名字存在 localStorage，换浏览器就没了；应该挪到 host 的 `ctx.storage.domain`。
- 左侧会话列表仍是平的（宿主 SPA，没有可用的 slot，也没有 `data-session-*` 钩子），
  一个对话有几条分支就占几行。
- 超过约 60 轮的对话在最小行高下会溢出。
- 新分支第一轮仍会带上宿主注入的 runtime-context 快照（优先级低）。
- fork 的两个缺陷本质上该在上游修：切点应落在 `turn/end`，而不是"下一轮 `turn/start` 之前"。
