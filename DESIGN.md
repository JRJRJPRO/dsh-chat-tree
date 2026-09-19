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

### 坐标

- **y = 树深度**，不是"第几行"。所以同一个岔路点分出去的两条支线，第一个节点**同高度**。
- **x = 列**，且**与"当前在哪条分支"无关**。同一会话的延续继承本列（主干天然是直线），
  岔出去的分支各领一个新列往左排。切分支只换颜色，**图的形状不动**。
- **不做省略**，全图永远画全；放不下就压行高。

### 节点四态

| | 长相 |
|---|---|
| 普通 | 圆点 |
| 当前轮 | 实心蓝 + 外发光 |
| 压缩 | 橙色方块（45° 菱形） |
| 空节点（树根） | 虚线圆 |

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
| 树根空节点 | 新建对话 | —— |
| **叶子节点**（后面既无后续轮、也无别的分支） | **就在本会话往下问，不 fork** | 复制一份只会在左边多出一条内容完全重复的会话 |
| 有后续的节点 | 真的 fork | 这才是要岔开 |

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
