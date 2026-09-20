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
// 没有轮次，固定叫 `root`。localStorage 的改名表、shape.json 的 detached 清单、
// buildGraph 的 nodeOf 索引用的都是它，所以**只准从这两个函数里出**，
// 别再有第四处手拼 `${id}:${turn}`。

/** 树根那个空节点的 key。 */
export const ROOT_KEY = 'root'

/**
 * 拼一个节点 key。
 * @param sessionId - 会话 id
 * @param turn - 会话内的轮次号
 * @returns `<sessionId>:<turn>`
 */
export function keyOf(sessionId, turn) {
	return `${sessionId}:${turn}`
}

// ===== 形状补丁：改树形只有这四种动作 =====
//
// host 的 `/shape` 收的是 `{session, group?, detach?}`，其中 `session` 这个字段
// **在两种动作里含义不同**（合并时是会话 id，剪边时是节点 key）—— host 半刻意
// 不解析它，好让 key 的格式将来能改。代价是调用方手拼补丁时很容易拼错，
// 所以补丁一律由下面这张表造，Rail 里不许再出现字面量补丁。

/** 改树形的四种动作。每一个都返回一个能直接喂给 `api.reshape` 的补丁。 */
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
 * **叶子节点不 fork**：后面什么都没有，复制一份只会多出一条内容重复的会话。
 * **撤回掉的节点也不给**：见函数体。
 * @param node - 被点的节点
 * @returns 'none' 什么都不该做 | 'fresh' 开新对话 | 'open' 就在本会话接着问 | 'fork' 真的开岔路
 */
export function branchAction(node) {
	// 撤回掉的轮次：claude 那边连锚点都一起删了（planRewind），
	// 从这儿开分支只会开出一条没有上下文的失忆分支，不如不给按钮。
	if (node.rewound === true) return 'none'
	// 根部那个空节点：底下已经有分支了才谈得上"再开一条"。
	// ⚠️ 刚建的对话只有这一个空节点，它自己就是"一条空对话"，
	//    再 fresh 一条只是多出一条一模一样的空会话（和叶子节点同一条道理）。
	if (node.entry === undefined) return node.children.length === 0 ? 'none' : 'fresh'
	return node.children.length === 0 ? 'open' : 'fork'
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
 * 另外三种动作都不需要读它的记录，所以一律不拦：
 *   · `open` —— 就在本会话接着问，没有新会话；
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
