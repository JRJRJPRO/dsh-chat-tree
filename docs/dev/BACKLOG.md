# 待办卡

每张卡的格式和派活流程见 [WORKFLOW.md](WORKFLOW.md) §2–§3。级别判据在 §5。
做完的卡挪到文末「已完成」，别删 —— 下一个人要知道为什么是这么改的。

John 2026-10-04 报的桌面版问题共 5 条：第 3 条已修（见文末），其余 4 条是 T1–T4（全部已修）。
T5 起是框架搭建时顺手发现、以及 AGENTS.md §5 里原来的 P1。

---

### T5  Rail 的组件级 smoke 测试                                       级别：L3（基础设施）

**目标** `Rail` 现在只有纯函数被测，组件本身没挂过。用 react-lite 挂一次：假 `api`
（`list` / `status` / `workspaces` / `settings` 四个 observable + `open` / `jump` / `fork` / `fresh` / `reshape`），
`dom.body` 里放一个 `[data-conversation-scroll]`（带 `rect`）和几行 `[data-chat-turn]`，
`globalThis.fetch` 假成返回 `/outlines` 的 body。断言：画出的点数 = 节点数、点击点叫了 `api.jump`、
`__dshTree()` 能倒出状态、卸载后 `document` / `window` 上没监听、没活着的 interval。

**改哪些** 新建 `tests/test-rail.mjs`；可能要给 `tests/kit/dom-lite.mjs` 补 `ResizeObserver` /
`MutationObserver` 的空实现（挂在 globalThis 上）。**不改 src**（真要改说明 Rail 有测不了的硬依赖，先报告）。

**为什么是 L3** `useChatBox` 用了 rAF、setInterval(800)、graceMs 600ms 的宽限 —— 要用 `tick()` 配时序，
第一次搭容易在"为什么 box 一直 undefined"上耗掉很多轮。搭好之后 T2 / T4 的 Rail 侧断言就都有地方放了。

---

### T6  `atomicWrite` 的 rename 失败时清掉 .tmp                          级别：L1

**症状** AGENTS §5 P1："`atomicWrite` 的 `rename` 失败时 `.tmp` 不清理，留孤儿文件。"
**改哪些** `src/host/paths.js` 一处 try/catch。
**先写测试** `tests/test-icon.mjs` 或新建 `test-paths.mjs`：把目标路径做成一个**目录**让 rename 必败，
断言抛错后同目录下没有 `.tmp`。
**坑** 别改成"失败就直接 writeFileSync 目标"——那就不原子了（ARCHITECTURE §4 第 5 条）。

---

### T7  `shape.json` 只增不减                                           级别：L2

**症状** AGENTS §5 P1：删掉的会话永远留在 `groupOf` / `detached` / `adopted` 里。
**改哪些** `src/host/shape.js`：`readShape` 之后、`collect` 之前，按 `sessionPersistence.list()` 给的
会话集过滤一遍（detached / adopted 的 key 要拆出会话 id 比）；过滤结果**不回写**，只在响应里用 ——
回写会和"两个客户端并发 reshape 丢补丁"（T8）撞。
**先写测试** `tests/test-shape.mjs` 新用例：shape 里有一个不存在的会话 id，`/outlines` 的 `shape` 不带它。

---

### T8  `reshape` 读-改-写并发丢补丁；`ICON_KEEP` 静默删图              级别：L2

两条都是 AGENTS §5 的 P1，各自一张卡也行。前者在 `src/host/shape.js` 加一个进程内的串行队列
（Promise 链）就够 —— host 是单进程。后者在 `src/host/icons.js`：超过 200 张时**不删被引用的**
（引用在 settings / labels.json 的 `img:<id>` 里），或者至少把删了的 id 记进响应让前端画一个占位。

---

## 已完成

### ✅ T3  删除节点                                                       （2026-10-04）

John 第 4 条。定义成**归档整条支线**（DESIGN.md「删除 = 归档整条支线」，那张表从这张卡搬过去了）。
`tree.js`：`deletePlan(node)` → `{sessions, turns, running}` 或 `{blocked}`；`deleteBlockedWhy`；`escapeFrom`
（名单里有正在看的那条时先切到哪：父亲那轮所在的会话 → 可见列表里第一个不在名单里的 → undefined 交给宿主）。
和卡上写的有两处不同：① "能不能删"看**图上的父亲**（`isChainHead`：父亲是空节点或别的会话），不是 `isBranchHead` ——
头一轮答到一半被撤回、节点没画的会话按后者永远删不了；② 子孙按 `node.children` 走（所见即所删），从继承段岔出去的
分支图上挂在祖先那轮底下、不跟着没；轮数和 running 按名单里的会话在整张图上数（撤回的废弃支线也一起归档，得算进去）。
`apply.js`：`api.canArchive`（认服务不认版本号）、`api.archive(ids, {stopActivity})` 一条条归、失败只 warn。
`ui-detail.js`：展开档最右红色 ✕；第一下摊开确认行（`deleteAsk`），第二下才 `onDelete(node, plan)`；换节点、收起卡片、
有草稿都清掉第一下；`canDelete` 为 false 整颗不画。`rail.js`：`marked` 顺带并入列表项的 `running`（0.2 的实时状态
在那张表上，开岔路的拦截也受益）；`onDelete` 先 `escapeFrom` 切走、再归档、清 hover、催重拉。
测试：新建 `test-delete.mjs`（五个用例）、`test-card` 用例 9；五处变异（中间轮放行 / 子孙不收 / 去处不排除名单 /
第一下就删 / 收起不清确认）各红。**没做**：真机验证 —— 桌面版里删一条带子分支的支线，看左侧进归档、树上消失、
归档列表里能恢复；0.1.5 网页版上归档正在跑的会话会怎样没实测（它没有 stopActivity 选项）。

### ✅ T2  同一层三个节点以上，自定义文字就只剩「…」                    （2026-10-04）

John 第 2 条。根因如卡上所说：字框宽按**压完的列距**一刀切。新加 `rowSlots` / `boxShift`（geometry.js）：
每一行当一条线段分给这一行画出来的节点，字框向空格子借地方、邻居之间对半分（来回扫，夹在中间的那个
不会被两头挤成「…」）、遇到圆点 / 星星 / **别人的**岔路拐角停住，最左一列可以借到 `railRoom` 的左缘；
框在地盘里不一定居中，`glyphBoxStyle` 认 spec 上的 `shift`。`segments` 加第 7 个参数：父节点是字框时
横段从框边起、框盖住孩子那列就不画横段。细节和取舍见 DESIGN.md「自定义字：按"这一行"的空位摊开」。
**和卡上不同的两处**：① `widestOf` 仍按字框全宽撑列距 —— John 的场面是同一行相邻三格都有字，
没得借，列距一缩空间宽裕时也会被挤；② `GLYPH_SPAN` 没放宽（2~4 个字在 3 em 里字号 ≥ 0.75 倍，
放宽会连带撑宽设置卡的预览）。`railRoom` 核过：算法本身不保守，但 `contentRightOf` 量的是
`[data-chat-turn]` 的右缘 —— 桌面版里这个元素如果是整行宽，room 会被量得很小，**要真机核一下**
（控制台看 `__dshTree()` / 量 `box.contentRight`），离线测不出来。
测试：`test-layout` 用例 9（8 组断言，变异过：去掉来回扫 / 横段不看第 7 参 / 核心不留 / 恒居中各红至少一条），
用例 7 照旧绿。改了 `shapes.js` 的 `glyphBoxStyle`（卡上没列，挪框必须改它）。

### ✅ T1  收藏 / 改名树根空节点时，所有树的空节点一起变                （2026-10-04）

树根空节点的 key 从常量 `root` 改成 `rootKeyOf(树 id)` = `root:<树根会话 id>`；`ROOT_KEY` 只剩前缀，
判别走 `isRootKey`。**树 id 取 `treeOf` 的结果**（Rail 把 `treeOfSession(picked, groupOf, current)` 作为
`buildGraph` 的第 5 个参数传进来），没有用卡上说的 `ordered[0]` / 最早 createdAt —— 原因：把一棵**更早**
建的树并进来时，最早的那条是被并进来的那棵的根，空节点 key 会跟着变，原来起的名字就丢了；`treeOf` 给的
是 groupOf 的目标，合并前后不变。不传第 5 个参数时退到"最早建的那条无父会话"，单棵树上两者一致。
`rail.js` 的认领判据改成 `!isRootKey(graph.owner)`。`labels.js` 四个 read* 都扔掉老的裸 `root` 条目（不迁移）。
测试：`test-highlight` 用例 28（不相干的树不同 / 同一棵树换分支相同 / 乱序 / 合并沿用目标树）、
`test-labels` 用例 4（浏览器半）；`test-merge` 三处 owner 断言和 `test-card` 用例 6 跟着改成 `rootKeyOf(...)`，
`test-highlight` 用例 21 / 26 原来拿 `'root'` 当样例 key，换成 `rootKeyOf('s1')`。

### ✅ T4  卡片展开着，点卡片外面应该收起                              （2026-10-04）

John 第 5 条。`src/client/ui-detail.js` 的 `Detail` 里加了一个 effect：展开且没在改名时，
在 `document` 上捕获阶段挂 `pointerdown`，点到卡片根元素（新加的 `ref`）之外就收起
（同时清掉合并清单和小牌子）。改名中（`busy`）不收，和 `onMouseLeave` 同一条规矩。
`tests/test-card.mjs` 用例 8 钉住三件事：点外面收、点卡片自己不收、改名中不收；
去掉 `busy` 判断或 `contains` 判断各会红一条。鼠标还在导轨上时整张卡不消失 —— 那是 Rail 的 hover，没动。

### ✅ T0  显示范围：默认按层数 18；按步数改成 10–60、默认 30             （2026-10-04）

John 第 3 条。改了 `src/client/const.js` 的 `DEPTH` / `RADIUS` 和 `src/host/settings.js` 的 schema，
`tests/test-elide.mjs` 用例 6 / 13 的期望值跟着改。顺手搭了 `tests/test-contract.mjs`，以后两边
默认值对不上会直接红 —— 这张卡就是契约测试存在的理由。按层数本来就是默认量法，没动。
