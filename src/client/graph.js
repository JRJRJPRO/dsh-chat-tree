/**
 * 把一棵对话树摊成带 (column, depth) 坐标的节点图。
 *
 * 整个插件最核心的一步，也是唯一一处"图的形状"的定义。改之前先看 DESIGN.md §5，
 * 尤其是"x 与当前在哪条分支无关"这一条。
 */
import { ROOT_KEY, indexOf, keyOf } from './tree.js'

/**
 * 把一棵对话树摊成带 (column, depth) 坐标的节点图。一个节点 = (会话, 自有轮次)。
 *
 * 四步：① 连节点 ② 算 depth ③ 定高亮范围 ④ 算 column。
 *
 * 小例子（父有 1-2-3-4，子从第 2 轮岔出、自有 3'-4'）：
 *     column  1        0
 *     depth2           2
 *     depth3   3'      3      ← 同高度，这就是"两个 3 该并排"
 *     depth4   4'      4
 *   切到子分支时只有颜色变，列不动。
 * @param sessions - 本对话的分支（已过滤）
 * @param currentId - 当前会话
 * @returns {nodes, maxDepth, maxColumn}
 */
export function buildGraph(sessions, currentId, cuts) {
	const byId = indexOf(sessions)
	const ownTurns = (session) => (session.turns || []).filter((entry) => !entry.inherited)

	// 父在前、子在后，保证接线时父节点已经建好
	const ordered = []
	const emitted = new Set()
	const emit = (session) => {
		if (emitted.has(session.id)) return
		if (session.parentId !== undefined && byId.has(session.parentId)) emit(byId.get(session.parentId))
		emitted.add(session.id)
		ordered.push(session)
	}
	for (const session of sessions) emit(session)

	const root = { key: ROOT_KEY, kind: 'empty', session: ordered[0], entry: undefined, parent: undefined, children: [], depth: 0 }
	let nodes = [root]
	const nodeOf = new Map()
	const attachOf = new Map() // 会话 → 它挂在哪个节点下

	// ① 连节点 + ② 算 depth
	for (const session of ordered) {
		let anchor = root
		if (session.parentId !== undefined && byId.has(session.parentId)) {
			const hit = nodeOf.get(keyOf(session.parentId, session.forkTurn))
			// forkTurn 落在父分支的继承段里（爷爷辈岔出来的）→ 退到父分支自己的挂载点
			anchor = hit || attachOf.get(session.parentId) || root
		}
		attachOf.set(session.id, anchor)

		// 撤回过的轮次不能当"下一轮的父亲"：它已经不在对话里了。
		// previous = 上一个画出来的节点（含撤回的），live = 上一个**还在对话里**的节点。
		// 于是撤回的那一段自己串成一条支线，撤回之后新发的轮次接回 live —— 也就是
		// 1-2-3-4（撤回）-5 画成 1-2-3-4 和 1-2-3-5 两条，而不是一条 1-2-3-4-5。
		let previous = anchor
		let live = anchor
		for (const entry of ownTurns(session)) {
			const rewound = entry.rewound === true
			// 答到一半被中止、然后撤回 —— 这一轮什么都没留下，节点直接不画。
			// key 仍指到最近还活着的祖先，免得有分支正好从这一轮岔出去、找不到挂载点。
			if (rewound && entry.done !== true) {
				nodeOf.set(keyOf(session.id, entry.turn), live)
				continue
			}
			const parent = rewound ? previous : live
			const node = {
				key: keyOf(session.id, entry.turn), kind: entry.compact ? 'compact' : 'normal',
				session, entry, rewound, parent, children: [], depth: parent.depth + 1,
			}
			parent.children.push(node)
			nodes.push(node)
			nodeOf.set(node.key, node)
			previous = node
			if (!rewound) live = node
		}
	}

	// ③ 剪边：被"分离"的节点断开与父亲的连接，自成一棵树。
	//
	// 判据是**图上的分叉**，不是会话边界 —— "会话自己的下一轮"和"fork 出来的新会话"
	// 在图上都只是某个节点的一个孩子，凭什么只准剪后者？
	//
	// 剪在 N：新树 = 根到 N 父亲那段路径（前缀，照抄）+ N 的整棵子树；
	//         旧树 = 原树扣掉 N 的子树。
	// 所以每个节点归属于"它头顶最近的那个被剪节点"，没有就归 root。
	const cutAt = cuts instanceof Set ? cuts : new Set(cuts || [])
	const ownerOf = new Map([[root, root]])
	for (const node of nodes) {
		if (node === root) continue
		// 标出剪缝本身：分离完新树里照抄了根到剪点父亲的前缀，所以剪缝**看得见**，
		// 接回去接到哪一目了然 —— 这个标记就是给那个「接回去」按钮用的
		node.cut = cutAt.has(node.key)
		ownerOf.set(node, node.cut ? node : ownerOf.get(node.parent))
	}

	// 站在哪棵上：取当前会话最深的那个节点；这条会话一轮都还没有就待在 root 那棵
	let here = root
	for (const node of nodes) if (node.session.id === currentId && node.depth > here.depth) here = node
	const mine = ownerOf.get(here) || root

	if (mine !== root || cutAt.size > 0) {
		const keep = new Set()
		for (const node of nodes) if (ownerOf.get(node) === mine) keep.add(node)
		// 前缀：从被剪点的父亲一路抄到根（只抄这条链，不带它身上挂的别的岔路）
		for (let node = mine.parent; node !== undefined; node = node.parent) keep.add(node)
		nodes = nodes.filter((node) => keep.has(node))
		for (const node of nodes) node.children = node.children.filter((kid) => keep.has(kid))
	}

	// ④ 高亮范围：给血缘链上每个会话记一个"轮次上限"，
	//    从当前会话往祖先走，上限取一路上岔路点的**最小值**。
	//    （A→B→C→D 时 D 只继承 C 的前 2 轮而 C 继承 B 的前 3 轮，
	//     那么 B 的第 3 轮不在 D 的对话里 —— 只看相邻一层会多算。）
	// ⚠️ 别改回"沿 node.parent 往上爬"，会跳过节点（DESIGN.md §5）。
	//    岔路点缺失时不设限，宁可多亮不要少亮。
	const limitOf = new Map()
	let running = Infinity
	for (let item = byId.get(currentId); item !== undefined && !limitOf.has(item.id); item = byId.get(item.parentId)) {
		limitOf.set(item.id, running) // 当前会话拿到 Infinity = 自有轮次全要
		if (item.forkTurn !== undefined) running = Math.min(running, item.forkTurn)
	}

	// ⑤ 算 column —— **刻意和 currentId 无关**，否则每切一次分支整张图就左右翻一遍。
	//    必须排在剪边**之后**：剪掉的子树不该再占着列宽。
	//
	// 【为什么不是"来一条新分支就发一个新列号"】那是最早的写法：深度优先走一遍，
	// 遇到岔路就 `nextColumn += 1`，发出去的号永不回收。它保证了一件要紧的事 ——
	// **一棵子树占一段连续的列**，于是连线永远不会从别的节点头顶压过去。
	// 但它从不回收，所以深处才出现的分支会先占掉小列号，把浅处那条挤到更外面，
	// 中间空出一整列。John 报的就是这个：
	//
	//     主干 1-2-3-4，5 从 1 岔出；然后在 3 后面再开一个 6
	//       col2 col1 col0            col1 col0
	//   d1     ·    ·    1        d1     ·    1
	//   d2     5    ·    2   →    d2     5    2     ← 5 不该被挤出去，
	//   d3     ·    ·    3        d3     ·    3        col1 那个洞底下还横穿着
	//   d4     ·    6    4        d4     6    4        一条 3→6 的线，很难看
	//
	// 【换成什么】Reingold–Tilford 那套**紧凑树**（tidy tree，1981 年那篇，
	// d3.tree / graphviz 用的都是它的后裔）。换掉的只是"往外挪多少"这一步：
	// 每棵子树先各自排好，再让兄弟子树**按轮廓**互相贴紧 —— 一条只有一行的短支线，
	// 可以整个嵌进旁边那棵子树空着的那几行里，而不是白占一整列。
	//
	// ⚠️ 试过 git 提交图那套泳道复用（`git log --graph` / GitKraken）。洞是没了，
	//    但它是给 **DAG** 用的，允许连线交叉；我们这儿有一条"连线不许压过任何节点"的
	//    硬约束（test.mjs 断言 5b），压测里它当场画出从别人头顶压过去的横线。
	//    树就该用树的算法。

	/**
	 * 一棵子树的**轮廓**：行 → 这一行用到的最外侧那一列（相对子树根那一列）。
	 *
	 * 这就是 Reingold–Tilford 紧凑树的核心数据。有了它，兄弟子树才能"贴着彼此的
	 * 凹凸互相嵌进去"，而不是各占一整段互不相让的列。
	 */
	const outline = (node) => {
		const edge = new Map([[node.depth, 0]])
		const kids = node.children.slice().sort((left, right) => (left.session.createdAt || 0) - (right.session.createdAt || 0))
		if (kids.length === 0) return edge
		// ⚠️ 撤回掉的那一轮虽然也是"本会话的延续"，但它是条废弃支线，
		//    让它占住主列的话，还活着的下一轮反而被挤到旁边去了。
		const same = (kid) => kid.session.id === node.session.id
		const trunk = kids.find((kid) => same(kid) && kid.rewound !== true) || kids.find(same) || kids[0]

		const shape = new Map()
		for (const kid of kids) shape.set(kid, outline(kid))
		const paste = (from, shift) => {
			for (const [row, at] of from) edge.set(row, Math.max(edge.get(row) ?? -1, at + shift))
		}

		trunk.column = 0 // 延续那条继承本列，主干天然是直线
		paste(shape.get(trunk), 0)
		for (const kid of kids) {
			if (kid === trunk) continue
			// 挪到刚好躲开已经放好的那些兄弟：它子树用到的每一行都要让开，
			// **外加父节点那一行** —— 拐进来的那一下会占住那一格（先横后竖）。
			let shift = (edge.get(node.depth) ?? -1) + 1
			for (const [row] of shape.get(kid)) shift = Math.max(shift, (edge.get(row) ?? -1) + 1)
			kid.column = Math.max(shift, 1) // 岔路只许往外长，不许压回主干那一列
			paste(shape.get(kid), kid.column)
			edge.set(node.depth, Math.max(edge.get(node.depth) ?? -1, kid.column)) // 拐弯那一格也占着
		}
		return edge
	}
	outline(root)

	// 上面算的是**相对父亲**的列，从根往下累加成绝对列
	root.column = 0
	const settle = (node) => {
		for (const kid of node.children) {
			kid.column += node.column
			settle(kid)
		}
	}
	settle(root)

	// 全局编号按时间排：每条分支各自从 1 数会撞车（父的 #3 和子的 #3 是两个节点）
	const timed = nodes.filter((node) => node.entry !== undefined).sort((left, right) => (left.entry.time || 0) - (right.entry.time || 0))
	timed.forEach((node, index) => {
		node.no = index + 1
	})

	let maxDepth = 0
	let maxColumn = 0
	for (const node of nodes) {
		// 根部那个空节点永远算在路径上
		// 撤回掉的轮次恒不在路径上——它就在当前会话里，limitOf 是 Infinity，
		// 不挡一下的话整条废弃支线会跟着亮成"当前路径"。
		node.active =
			node.entry === undefined
				? true
				: node.rewound !== true && node.entry.turn <= (limitOf.has(node.session.id) ? limitOf.get(node.session.id) : -1)
		// 能不能分离：一路往上只要有哪个祖先有多个孩子就能。
		// 父在前子在后遍历，所以这里可以直接吃父亲算好的结果 —— O(1)，
		// 不用点击时再回溯，也不会因为别处新增/分离而过期。
		node.canDetach = node.parent !== undefined && (node.parent.children.length > 1 || node.parent.canDetach === true)
		maxDepth = Math.max(maxDepth, node.depth)
		maxColumn = Math.max(maxColumn, node.column || 0)
	}
	return { nodes, maxDepth, maxColumn }
}
