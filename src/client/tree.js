/**
 * 一棵树由哪些会话组成 —— 过滤、归组、以及节点上能做什么。
 *
 * 这里全是**纯函数**，不碰 react、不碰 fetch，离线测试直接 import 就能跑。
 * 数据流：host 的 /outlines → visibleTree（扣归档）→ conversationOf（只留当前那棵树）
 * → 交给 graph.js 摊成节点。
 */

// ===== 节点 key：全插件唯一的"一个节点"的写法 =====
//
// 一个节点 = (会话, 该会话自己的第几轮)，写成 `<sessionId>:<turn>`；树根那个空节点
// 没有轮次，写成 `root:<树根会话 id>`。localStorage 的改名表、shape.json 的 detached 清单、
// buildGraph 的 nodeOf 索引用的都是它，所以**只准从这几个函数里出**，
// 别再有别处手拼 `${id}:${turn}`。
//
// ⚠️ 树根 key 曾经是常量 `root`，所有树共用 —— 给一棵树的空节点改名 / 收藏，
//    别的树的空节点全跟着变（John 2026-10-04 报的）。现在按树区分，`ROOT_KEY` 只剩前缀的用处。

/** 树根 key 的前缀。**不是**任何一个节点的 key —— 判"是不是树根"用 `isRootKey`。 */
export const ROOT_KEY = 'root'

/**
 * 某棵树的树根空节点 key。
 * @param sessionId - 这棵树的树根会话 id（合并过的树用被并进去那棵的，即 `treeOf` 给的编号）
 * @returns `root:<sessionId>`
 */
export function rootKeyOf(sessionId) {
	return `${ROOT_KEY}:${sessionId}`
}

/**
 * 是不是树根空节点的 key。
 * @param key - 节点 key
 * @returns 是 `rootKeyOf` 造出来的就 true；老数据里的裸 `root` 也算（读标注时靠它扔掉）
 */
export function isRootKey(key) {
	return typeof key === 'string' && (key === ROOT_KEY || key.startsWith(`${ROOT_KEY}:`))
}

// ===== 会话列表：两代宿主的差异在这儿抹平 =====
//
// `ctx.sessions.list` 的快照 `{ids, byId}` 两代都有，差的是两件事：
//   · 当前会话：0.1.5 直接给 `current`；0.2 没有这个字段，改成列表项上的
//     `retainedBy.mainView > 0`（宿主自己的 ui-session 也是这么判的）。
//   · 跑完未读：0.1.5 在列表项的 `completed`；0.2 挪到 `uiSession.sessionStatus`
//     那张 `Map<id, {running, completionUnread}>` 里。
// 下面两个函数把这些揉回 0.1.5 的形状，别处（rail / sidebar / graph）一律按老形状读。

/**
 * 当前会话 id。
 * @param listState - `ctx.sessions.list` 的快照
 * @returns 会话 id；没有当前会话就 undefined
 */
export function currentOf(listState) {
	if (!listState) return undefined
	if (typeof listState.current === 'string') return listState.current
	const byId = listState.byId || {}
	for (const id of listState.ids || []) {
		const kept = byId[id] && byId[id].retainedBy
		if (kept && typeof kept === 'object' && kept.mainView > 0) return id
	}
	return undefined
}

/**
 * 把 0.2 的状态表并进列表项：有表就按表填 `running` / `completed`，没有原样返回。
 * @param listState - `ctx.sessions.list` 的快照
 * @param statuses - `uiSession.sessionStatus` 的快照（Map），0.1.5 上是 undefined
 * @returns 同形状的快照；没有状态表时**就是传进来的那个对象**（引用不变，别处的 memo 才不会白刷）
 */
export function withStatus(listState, statuses) {
	if (!listState || !statuses || typeof statuses.get !== 'function' || statuses.size === 0) return listState
	const byId = Object.assign({}, listState.byId || {})
	let changed = false
	for (const [id, status] of statuses) {
		const item = byId[id]
		if (item === undefined || !status) continue
		// 宿主自己的写法是 `status.running ?? item.running`：状态表还没见过这条会话时不盖列表项
		const running = status.running === undefined ? item.running === true : status.running === true
		const completed = status.completionUnread === true
		if (item.running === running && (item.completed === true) === completed) continue
		byId[id] = Object.assign({}, item, { running }, completed ? { completed: true } : {})
		if (!completed) delete byId[id].completed
		changed = true
	}
	return changed ? Object.assign({}, listState, { byId }) : listState
}

/**
 * 拼一个节点 key。
 * @param sessionId - 会话 id
 * @param turn - 会话内的轮次号
 * @returns `<sessionId>:<turn>`
 */
export function keyOf(sessionId, turn) {
	return `${sessionId}:${turn}`
}

// ===== 形状补丁：改树形只有这几种动作 =====
//
// host 的 `/shape` 收的是 `{session, group?, detach?, adopt?}`，其中 `session` 这个字段
// **在不同动作里含义不同**（合并 / 认领时是会话 id，剪边时是节点 key）—— host 半刻意
// 不解析它，好让 key 的格式将来能改。代价是调用方手拼补丁时很容易拼错，
// 所以补丁一律由下面这张表造，Rail 里不许再出现字面量补丁。

/** 改树形的几种动作。每一个都返回一个能直接喂给 `api.reshape` 的补丁。 */
export const shapeOps = {
	/**
	 * 把一棵树整个并进另一棵。
	 * @param treeRoot - 被合并那棵树的**树根会话 id**
	 * @param into - 目标树的编号
	 */
	merge: (treeRoot, into) => ({ session: treeRoot, group: into }),
	/**
	 * 把合进来的那棵树拆回独立的一棵。
	 * @param treeRoot - 它的树根会话 id
	 */
	unmerge: (treeRoot) => ({ session: treeRoot, group: '' }),
	/**
	 * 剪断一个节点和它父亲的连接，自成一棵树。
	 * @param nodeKey - 剪点的节点 key（必须是 `cutPointOf` 算出来的那个）
	 */
	cut: (nodeKey) => ({ session: nodeKey, detach: true }),
	/**
	 * 把剪出去的支线接回来。
	 * @param nodeKey - 剪缝所在的节点 key
	 */
	heal: (nodeKey) => ({ session: nodeKey, detach: false }),
	/**
	 * 让一条**新会话**归到某棵拆出去的树。
	 *
	 * 拆出去的树里，根到剪点父亲那段前缀是**照抄**的 —— 那几个节点仍然属于旧会话。
	 * 在前缀上按 ＋ 开出来的分支，父亲是旧会话、岔路点在前缀段，按血缘算自然落回旧树
	 * （youli42 报的 issue #4）。所以新会话一出生就要登记"我归剪点那棵"。
	 * @param sessionId - 新会话 id
	 * @param cutKey - 那棵树的剪点节点 key（`buildGraph` 返回的 `owner`）
	 */
	adopt: (sessionId, cutKey) => ({ session: sessionId, adopt: cutKey }),
	/**
	 * 撤销认领：这条会话回到按血缘算的那棵树。
	 * @param sessionId - 会话 id
	 */
	disown: (sessionId) => ({ session: sessionId, adopt: '' }),
}

/**
 * 按可见集过滤，并把"父亲被归档"的孤儿重接到最近的可见祖先。
 *
 * 小例子：A ← B ← C，B 被归档 → 剩 {A, C}，C 沿原链上溯到 A → 重接成 A ← C。
 * 树仍是一棵，而不是裂成两棵。
 * @param all - host 返回的全部分支（含已归档）
 * @param visible - 可见 sessionId 集合
 */
export function visibleTree(all, visible) {
	const byId = indexOf(all)
	return all
		.filter((item) => visible.has(item.id))
		.map((item) => {
			let parent = item.parentId
			const guard = new Set()
			while (parent !== undefined && !visible.has(parent) && byId.has(parent) && !guard.has(parent)) {
				guard.add(parent)
				parent = byId.get(parent).parentId
			}
			return Object.assign({}, item, { parentId: parent !== undefined && visible.has(parent) ? parent : undefined })
		})
}

/**
 * 某条会话所在那棵树的编号。
 *
 * 先顺着 parentId 爬到树根（被"分离"的会话在 visibleTree 里已经断了父链，
 * 自然就是自己的根），再看这个根有没有被登记进别人的组。
 * @param byId - id → 会话
 * @param groupOf - 登记表 `{sessionId: groupId}`
 * @param id - 会话 id
 * @returns 树编号；查不到返回 undefined
 */
export function treeOf(byId, groupOf, id) {
	let root
	const seen = new Set()
	for (let node = byId.get(id); node !== undefined && !seen.has(node.id); node = byId.get(node.parentId)) {
		seen.add(node.id)
		root = node
	}
	if (root === undefined) return undefined
	return (groupOf && groupOf[root.id]) || root.id
}

/**
 * 把会话列表变成 `treeOf` 要的那张索引表。
 *
 * 单独抽出来是因为它在四个地方各建了一遍，其中两处还是直接写在渲染里的
 * `new Map(all.map((item) => [item.id, item]))` —— 一眼看不出那是张什么表。
 * @param sessions - 会话列表
 * @returns id → 会话
 */
export function indexOf(sessions) {
	return new Map((sessions || []).map((item) => [item.id, item]))
}

/**
 * `treeOf` 的顺手版：直接给会话列表，不用自己建索引。
 * 一次只问一个会话时用它；要连问很多个就自己 `indexOf` 一次再反复调 `treeOf`。
 * @param sessions - 会话列表
 * @param groupOf - 登记表
 * @param id - 会话 id
 * @returns 树编号
 */
export function treeOfSession(sessions, groupOf, id) {
	return treeOf(indexOf(sessions), groupOf, id)
}

/**
 * 本 cwd 下**别的**对话，供「合并」挑。
 *
 * 合并是整棵树对整棵树的，所以这里按树归并，一棵树只出现一次。
 * 合并结果不需要指定"接到哪个节点"：两棵树的节点互不相同，合完就是
 * 各自的链并排挂在同一个空根下 —— 谁合进谁，结果都是确定的。
 * @param sessions - 本 cwd 下全部可见分支（已过 visibleTree）
 * @param currentId - 当前会话
 * @param groupOf - 登记表
 * @returns `[{tree, root, title, turns, joined, blocked}]`，按创建时间排
 */
export function mergeTargets(sessions, currentId, groupOf) {
	const byId = indexOf(sessions)
	const mine = treeOf(byId, groupOf, currentId)
	const own = (item) => (item.turns || []).filter((entry) => !entry.inherited).length
	const trees = new Map()
	// 一棵树只要有**任何一条分支**在跑就不能合并。整棵树是一起并过来的，
	// 只看被点中那条分支的话，"跑着的那条"照样会被顺手带进来。
	const running = new Set()
	for (const item of sessions) {
		const tree = treeOf(byId, groupOf, item.id)
		if (tree === undefined) continue
		if (item.running === true) running.add(tree)
	}
	for (const item of sessions) {
		const tree = treeOf(byId, groupOf, item.id)
		if (tree === undefined || tree === mine) continue
		const seat = trees.get(tree)
		if (seat === undefined) trees.set(tree, { tree, root: item.id, title: item.title, turns: own(item), at: item.createdAt || 0 })
		else {
			seat.turns += own(item)
			if ((item.createdAt || 0) < seat.at) Object.assign(seat, { root: item.id, title: item.title, at: item.createdAt || 0 })
		}
	}
	// 已经合进来的那些：登记表里指着我这棵树的，拆得回去
	const joined = []
	for (const [key, value] of Object.entries(groupOf || {})) {
		if (value !== mine || !byId.has(key)) continue
		const item = byId.get(key)
		joined.push({ tree: key, root: key, title: item.title, turns: own(item), at: item.createdAt || 0, joined: true })
	}
	const mineBusy = running.has(mine)
	return [...joined, ...trees.values()]
		.map((one) => Object.assign(one, { blocked: blockedWhy(mineBusy, running.has(one.tree)) }))
		.sort((left, right) => left.at - right.at)
}

/**
 * 不能合并的话，原因是什么人话。
 *
 * 现在只有一种：有一头还在跑。**合并本身不危险**（只写 shape.json，不碰对话），
 * 但正在跑的那棵树形状算不准 —— 它的撤回记录这会儿读不了（见 src/host/rewind.js），
 * 刚合进来就画错更难解释。等跑完再合，一切都是确定的。
 * @param mineBusy - 当前这棵树在跑
 * @param theirsBusy - 对方那棵树在跑
 * @returns 原因；能合并就是空串
 */
export function blockedWhy(mineBusy, theirsBusy) {
	if (theirsBusy && mineBusy) return '两边都还在运行，跑完再合'
	if (theirsBusy) return '这条对话还在运行，跑完再合'
	if (mineBusy) return '当前对话还在运行，跑完再合'
	return ''
}

/**
 * 当前该画出来的那棵树。
 *
 * 同一棵树 = 树根相同，**或者**树根被显式登记进了同一组。
 *
 * ⚠️ 别改成"整个 cwd 全要"。那样 a/b/c 三条互不相干的对话会挤在一个空节点下面，
 *    实测 16 条对话把导轨撑到 326px。分组必须是**主动登记**的：
 *    只有在空节点上按 ＋ 开出来的新对话才登记进当前这棵树（见 onFork）。
 * @param sessions - 本 cwd 下全部可见分支（已过 visibleTree）
 * @param currentId - 当前会话
 * @param groupOf - 登记表
 * @returns 这棵树里的分支
 */
export function conversationOf(sessions, currentId, groupOf) {
	const byId = indexOf(sessions)
	const mine = treeOf(byId, groupOf, currentId)
	if (mine === undefined) return []
	return sessions.filter((item) => treeOf(byId, groupOf, item.id) === mine)
}

/**
 * 某个会话属于哪个工作区。
 *
 * 侧栏的分组按 `workspace.sessionIds` 这张显式成员表算，不是按 cwd。
 * @param state - `ctx.workspaces` 的快照 `{items, archivedSessionIds}`
 * @param sessionId - 会话 id
 * @returns workspaceId，查不到就 undefined
 */
export function workspaceOf(state, sessionId) {
	const hit = ((state && state.items) || []).find((item) => (item.sessionIds || []).includes(sessionId))
	return hit === undefined ? undefined : hit.workspaceId
}

/**
 * 在某个节点上点"分离"，实际该剪在哪。
 *
 * **不是剪在你点的那个节点上。** 一路往上走，只要父亲只有这一个孩子就继续往上，
 * 直到撞见一个有多个孩子的父亲 —— 剪点就是它底下的那个节点。
 *
 * 小例子：1 → 2 → {3 → 5, 4 → 6}，在 6 上点分离。
 *   6 的父亲 4 只有一个孩子 → 上移；4 的父亲 2 有两个孩子 → 停，剪点是 **4**。
 *   新树 = 1-2-4-6，旧树 = 1-2-3-5。
 * ⚠️ 剪在 6 上的话，4 会留在旧树里，两棵树看起来"没同步"（踩过）。
 * @param node - 被点的节点
 * @returns 该剪的节点；一路到根都没岔路就 undefined（这时也不该给按钮）
 */
export function cutPointOf(node) {
	let at = node
	while (at.parent !== undefined && at.parent.children.length === 1) at = at.parent
	return at.parent === undefined ? undefined : at
}

/**
 * 把存盘的 `detached` 翻成一组**节点 key**。
 *
 * 现在剪的是图上的边，所以记的是 `<会话>:<轮次>`。早先记的是纯会话 id
 * （那一版只会剪"fork 出来的新会话"），遇到就翻成它第一个自有轮次的节点，
 * 免得你之前拆过的东西悄悄失效。
 * @param detached - 存盘的清单
 * @param sessions - 本树的分支，用来给老格式找落点
 * @returns 节点 key 集合
 */
export function cutSet(detached, sessions) {
	const out = new Set()
	for (const item of detached || []) {
		if (typeof item !== 'string' || item.length === 0) continue
		if (item.includes(':')) {
			out.add(item)
			continue
		}
		const session = (sessions || []).find((one) => one.id === item)
		const first = session && (session.turns || []).find((entry) => !entry.inherited)
		if (first !== undefined) out.add(keyOf(item, first.turn))
	}
	return out
}

/**
 * 在某个节点上按 ＋ 该干什么。
 * **叶子节点不画 ＋**：后面什么都没有，复制一份只会多出一条内容重复的会话；
 * 而"就在本会话接着问"等于什么都不做 —— 一颗按了没反应的按钮比没有更让人发毛
 * （youli42 报的 issue #3：叶子上那颗 ＋ 写着"新开分支"，按下去却毫无动静）。
 * **撤回掉的节点也不给**：见函数体。
 * @param node - 被点的节点
 * @returns 'none' 什么都不该做（也不画按钮） | 'fresh' 开新对话 | 'fork' 真的开岔路
 */
export function branchAction(node) {
	// 撤回掉的轮次：claude 那边连锚点都一起删了（planRewind），
	// 从这儿开分支只会开出一条没有上下文的失忆分支，不如不给按钮。
	if (node.rewound === true) return 'none'
	// 根部那个空节点：底下已经有分支了才谈得上"再开一条"。
	// ⚠️ 刚建的对话只有这一个空节点，它自己就是"一条空对话"，
	//    再 fresh 一条只是多出一条一模一样的空会话（和叶子节点同一条道理）。
	if (node.entry === undefined) return node.children.length === 0 ? 'none' : 'fresh'
	return node.children.length === 0 ? 'none' : 'fork'
}

/**
 * 从某一轮开岔路时，交给宿主 `fork({atSeq})` 的那个 seq —— **这一轮的 turn/end**，
 * 不是 turn/start。
 *
 * 两代宿主对 `atSeq` 的解释不一样（NATIVE-BASELINE.md 末尾「fork 的 atSeq」）：
 *   · 0.1.5：取"第一个 seq ≥ atSeq 的 turn/end"做边界，再一直抄到下一个 turn/start 之前。
 *     传 turn/start 和传 turn/end 结果一样，都是整轮抄过去。
 *   · 0.2（桌面版起）：atSeq 就是**精确的包含式切点**，切在哪就到哪为止；切进一轮中间
 *     就补一条 `forked` 的 turn/end 把它合上。传 turn/start 的话，新分支只抄到这一轮的
 *     turn/start —— 提问和回答都不在，模型只记得到上一轮。John 报的"分叉就失忆"
 *     （deepseek 整轮丢、claude 少一轮）就是它；盘上 2026-10-01 的 TEST 桶里那条
 *     `session-054a5154` 就长这样：继承段只有 turn/start，接着就是 end-seed 和 forked。
 * 传 turn/end 两代都对：0.1.5 下"≥ 它的第一个 turn/end"就是它自己。
 *
 * 没有 turn/end（这一轮还在跑）就退回 turn/start —— 0.2 会把它切成空壳、0.1.5 会报
 * fork-unavailable，两边都不会多抄一轮；`branchAction` 本来也不该在这种节点上给出 ＋。
 * @param entry - 大纲里的一轮（host 半 foldOutline 的产物）
 * @returns 交给 `fork` 的 atSeq
 */
export function forkCutSeq(entry) {
	if (!entry) return undefined
	return Number.isFinite(entry.endSeq) ? entry.endSeq : entry.seq
}

/**
 * 这个 ＋ 现在为什么按不了。**按不了就说清楚，别开出一条看着正常其实失忆的分支。**
 *
 * 只有一种情况：从一条**托管给外部引擎**（claude 这类）的会话上真的开岔路，
 * 而它正在跑。新分支要继承上下文就得读它的记录，而读那个文件会打断它正在跑的那一轮
 * （见 src/host/rewind.js 顶上的说明）—— 所以我们不读，也就接不上。
 *
 * 为什么不是"照开，只是没上下文"：那条分支看起来和别的一模一样，你发现不了它失忆，
 * 直到它答得驴唇不对马嘴。为什么不是"先开着、等跑完再补"：那几秒里你看到的仍然是
 * 一条看着正常的分支，而且你会以为卡住了去瞎点。
 *
 * 另外两种动作都不需要读它的记录，所以一律不拦：
 *   · `fresh` —— 空节点上开一条全新对话，本来就没有上下文可继承；
 *   · 普通 provider —— 对话原文就在 dsh 日志里，原生 fork 抄过去就够了。
 * @param node - 被点的节点
 * @returns 原因；能开就是空串
 */
export function forkBlockedWhy(node) {
	if (branchAction(node) !== 'fork') return ''
	if (node.session.claude !== true || node.session.running !== true) return ''
	return '这条对话正在运行，现在读它的记录会打断那一轮，所以开不了分支 —— 跑完再开'
}

/**
 * 这个节点是不是一条分支的头一个自有轮次。
 *
 * 「没继承到上下文」这件事是**整条分支**的属性，但挂在每个节点上会刷屏，
 * 挂在岔路口那一个上最贴合"从这儿往后它就不记得前面了"。
 * @param node - 节点
 * @returns 是不是分支头
 */
export function isBranchHead(node) {
	if (node.entry === undefined) return false
	const first = (node.session.turns || []).find((entry) => !entry.inherited)
	return first !== undefined && first.turn === node.entry.turn
}

/**
 * 点一个节点时该在哪个会话里跳过去。**尽量不换路径**：节点若在当前路径上，
 * 就留在当前会话里滚过去（fork 抄日志时 seq 没变，同一个 seq 就是同一轮）。
 *
 * ⚠️ 无脑切到"节点所属的会话"会把整条高亮路径换掉（DESIGN.md §5）。
 * @param node - 被点的节点
 * @param currentId - 当前会话
 * @returns 要跳进去的会话 id
 */
export function jumpTarget(node, currentId) {
	return node.active ? currentId : node.session.id
}

/**
 * 该填实心蓝的是不是这一个。判据只有两条：在当前路径上 + 轮次号对得上
 * （轮次号在一条路径上不重复，所以最多亮一个）。
 *
 * ⚠️ 别再加 `node.session.id === current`：继承来的那几轮画的是**父会话的节点**，
 *    加了它往上滑到继承段就一个点都不亮。
 * @param node - 节点
 * @param activeTurn - 当前滑到的轮次
 * @returns 是否该填实心蓝
 */
export function isFocusedNode(node, activeTurn) {
	return node.entry !== undefined && node.active === true && node.entry.turn === activeTurn
}

// ===== 删除 = 归档整条支线 =====
//
// dsh 的会话日志**只追加**，没有"删一轮"的原语；宿主给的是**归档**（可逆，归档的会话树上已经不画）。
// 所以"删一个节点"定义成：把它所在的整条支线 —— 它自己的会话，加上图上挂在它底下的全部子孙会话 ——
// 一起归档。能删的只有**支线的头一个节点**：删它就是删整条会话；会话中间 / 末尾的一轮删不了半截，
// 那是撤回的活（消息行上有）。整张表见 DESIGN.md「删除 = 归档整条支线」。

/**
 * 这个节点是不是它所在会话在图上的头一个节点。
 *
 * 判的是**图上的父亲**：父亲是树根空节点，或者属于别的会话，就是头。同一条会话的节点
 * 串成一条链（撤回的那段除外），所以只有链头满足。和 `isBranchHead`（按大纲里第一个自有轮次判）
 * 几乎总是一致，差别在"头一轮答到一半被撤回、节点没画"那种会话：大纲上的头一轮没有节点，
 * 按 isBranchHead 这条会话就永远删不了，按图上的父亲仍然删得了。
 * @param node - 节点
 * @returns 是不是链头
 */
function isChainHead(node) {
	const parent = node.parent
	return parent === undefined || parent.entry === undefined || parent.session.id !== node.session.id
}

/**
 * 在某个节点上按「删除」会归档哪些会话。
 *
 * 子孙按**图上**算（`node.children` 一路往下），不按 `parentId`：从继承段岔出去的分支在图上
 * 挂在祖先那一轮底下、和这条支线并排，看着就不在它底下，自然不该跟着没；被拆到别的树上的子树
 * 已经不在这张图里，同理。**所见即所删。**
 *
 * 轮数和"有没有在跑"按名单里的会话在**整张图**上数，不只数这棵子树：同一条会话撤回掉的那段
 * 在图上是旁边一条废弃支线，归档时一样跟着没，确认文案里得把它算进去。
 *
 * 小例子：A 1-2-3-4，B 从 A:2 岔出自有 3-4，C 从 B:3 岔出自有 4-5，D 从 B 的第 2 轮（继承自 A）岔出。
 *   删 B:3 → 归档 B、C（4 轮）；D 挂在 A:2 底下，不动。删 A:2 → 不行，那是 A 的中间一轮。
 * @param node - 被点的节点
 * @returns `{sessions, turns, running}`：要归档的会话 id（点的那条排头）、它们合起来有几轮、
 *   有没有正在跑的；删不了就是 `{blocked: 原因}`
 */
export function deletePlan(node) {
	if (!node || node.entry === undefined) return { blocked: '树根空节点不是哪一轮，删不了；要清掉整棵树，逐条删它底下的分支' }
	if (!isChainHead(node)) return { blocked: '只能删整条支线（从分支头那一轮起），日志删不了半截；要撤掉这几轮，用消息行上的撤回' }
	const sessions = []
	const seen = new Set()
	const collect = (at) => {
		if (!seen.has(at.session.id)) {
			seen.add(at.session.id)
			sessions.push(at.session.id)
		}
		for (const kid of at.children || []) collect(kid)
	}
	collect(node)
	let top = node
	while (top.parent !== undefined) top = top.parent
	let turns = 0
	let running = false
	const count = (at) => {
		if (at.entry !== undefined && seen.has(at.session.id)) {
			turns += 1
			if (at.session.running === true) running = true
		}
		for (const kid of at.children || []) count(kid)
	}
	count(top)
	return { sessions, turns, running }
}

/**
 * 这个「删除」现在为什么按不了。和 `forkBlockedWhy` 同一套："按不了就说清楚"。
 * @param node - 被点的节点
 * @returns 原因；能删就是空串
 */
export function deleteBlockedWhy(node) {
	const plan = deletePlan(node)
	return typeof plan.blocked === 'string' ? plan.blocked : ''
}

/**
 * 删的名单里有正在看的那条会话时，归档前先切到哪儿去。
 *
 * 宿主的当前会话一归档就没了（主视图空掉），所以**先走再删**。先沿图往上找：父亲那一轮
 * 所在的会话（分支头的父亲就是岔出来的那条）；一路到树根都在名单里（删的是树根底下最早的
 * 那条，树根空节点挂的会话就是它）就从 `others` 里挑第一个不在名单里的。
 * @param node - 被点的节点
 * @param plan - `deletePlan` 的结果
 * @param others - 备选会话 id（Rail 给的是可见会话列表）
 * @returns 该先打开的会话 id；实在没有就 undefined（交给宿主自己处理）
 */
export function escapeFrom(node, plan, others) {
	const gone = new Set((plan && plan.sessions) || [])
	for (let at = node === undefined || node === null ? undefined : node.parent; at !== undefined; at = at.parent) {
		if (at.session !== undefined && !gone.has(at.session.id)) return at.session.id
	}
	for (const id of others || []) if (!gone.has(id)) return id
	return undefined
}
