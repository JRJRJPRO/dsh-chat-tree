/**
 * 分列算法（graph.js 第 ⑤ 步）的用例：紧凑树。
 *
 * 【为什么单独一套】分列是整个插件唯一一处"图的形状"的定义，而它的毛病**全是观感问题**：
 * 不会报错、不会画错，只是难看。难看没有断言就守不住。这里守两样：
 *
 *   ① 具体那张图 —— John 报的那个洞，钉死它不许回来
 *   ② 随机树扫一遍 —— 五条不变式。光靠手写用例覆盖不到奇形怪状的树，
 *      而这几条一旦破了，界面上就是"线从别的点身上压过去""两个点叠在一起"这种
 *      一眼看得出、却没人说得清为什么的怪样子
 *
 * @module test-tidy
 */

import { check, report, loadClientPure } from './test-kit.mjs'

const pure = await loadClientPure()

// ===== 第 1 步：造树的工具 =====

/** mulberry32。**别用 `种子 % n` 那种 LCG** —— 它低位会退化，造出来 3000 棵其实是同一棵。 */
function rng(seed) {
	let a = seed >>> 0
	return (n) => {
		a = (a + 0x6d2b79f5) >>> 0
		let t = a
		t = Math.imul(t ^ (t >>> 15), t | 1)
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
		return ((((t ^ (t >>> 14)) >>> 0) / 4294967296) * n) | 0
	}
}

/**
 * 造一棵随机对话树。
 * @param rnd - 随机数
 * @param forks - 岔多少条
 * @returns 会话数组，形状和 /outlines 给的一样
 */
function randomTree(rnd, forks) {
	const sessions = [{ id: 'S0', createdAt: 1, turns: [] }]
	const cap = new Map([['S0', 0]])
	const grow = (id, count) => {
		const one = sessions.find((item) => item.id === id)
		const base = one.turns.length === 0 ? one.forkTurn || 0 : one.turns[one.turns.length - 1].turn
		for (let i = 1; i <= count; i += 1) one.turns.push({ turn: base + i, time: base + i, inherited: false })
		cap.set(id, base + count)
	}
	grow('S0', 3 + rnd(8))
	for (let k = 1; k <= forks; k += 1) {
		const from = sessions[rnd(sessions.length)]
		const room = cap.get(from.id)
		if (room < 1) continue
		const kid = { id: `S${k}`, createdAt: k + 1, parentId: from.id, forkTurn: 1 + rnd(room), turns: [] }
		sessions.push(kid)
		cap.set(kid.id, kid.forkTurn)
		grow(kid.id, 1 + rnd(5))
	}
	return sessions
}

/**
 * 五条不变式，一条都不许破。
 * @param graph - buildGraph 的结果
 * @returns 违规说明，空数组表示干净
 */
function audit(graph) {
	const bad = []
	const at = new Map()
	for (const node of graph.nodes) {
		const cell = `${node.column},${node.depth}`
		if (at.has(cell)) bad.push(`两个节点叠在 ${cell}：${node.key} / ${at.get(cell)}`)
		at.set(cell, node.key)
	}
	for (const node of graph.nodes) {
		const columns = node.children.map((kid) => kid.column)
		if (new Set(columns).size !== columns.length) bad.push(`${node.key} 的几个孩子挤在同一列`)
		if (node.parent === undefined) continue
		// 同一条会话的延续必须走直线（撤回掉的那一轮除外，它本来就是条岔路）
		if (node.session.id === node.parent.session.id && node.rewound !== true && node.column !== node.parent.column) {
			bad.push(`同分支却换了列：${node.key}`)
		}
		// 岔路只许往外长。长回主干那一侧的话，"越靠外越晚岔出去"这个读法就没了
		if (node.column < node.parent.column) bad.push(`${node.key} 长回了主干那一侧`)
	}
	// 连线按"先横后竖"走，一格一格数过去，不许踩到任何节点
	for (const node of graph.nodes) {
		if (node.parent === undefined) continue
		const cells = []
		if (node.column === node.parent.column) {
			for (let depth = node.parent.depth + 1; depth < node.depth; depth += 1) cells.push(`${node.column},${depth}`)
		} else {
			const lo = Math.min(node.column, node.parent.column)
			const hi = Math.max(node.column, node.parent.column)
			for (let column = lo + 1; column < hi; column += 1) cells.push(`${column},${node.parent.depth}`)
			for (let depth = node.parent.depth; depth < node.depth; depth += 1) cells.push(`${node.column},${depth}`)
		}
		for (const cell of cells) if (at.has(cell)) bad.push(`连线 ${node.parent.key}→${node.key} 压过 ${at.get(cell)}（格 ${cell}）`)
	}
	// 同一列上下紧挨着的两个点，必须是父子。不然看起来就是一条分支，可它们之间没有线
	const byColumn = new Map()
	for (const node of graph.nodes) {
		if (!byColumn.has(node.column)) byColumn.set(node.column, [])
		byColumn.get(node.column).push(node)
	}
	for (const [, list] of byColumn) {
		list.sort((left, right) => left.depth - right.depth)
		for (let i = 1; i < list.length; i += 1) {
			if (list[i].depth === list[i - 1].depth + 1 && list[i].parent !== list[i - 1]) {
				bad.push(`${list[i - 1].key} 和 ${list[i].key} 同列紧挨着，却不是父子`)
			}
		}
	}
	return bad
}

/** 一行里，两个有节点的列之间夹了几个空列。 */
function holesOf(graph) {
	const rows = new Map()
	for (const node of graph.nodes) {
		if (!rows.has(node.depth)) rows.set(node.depth, new Set())
		rows.get(node.depth).add(node.column)
	}
	let holes = 0
	for (const [, columns] of rows) {
		const list = [...columns].sort((left, right) => left - right)
		for (let i = 1; i < list.length; i += 1) holes += list[i] - list[i - 1] - 1
	}
	return holes
}

// ===== 第 2 步：用例 =====

console.log('用例 1：浅处的分支不许被深处后开的分支挤出去')
{
	// John 报的原话：主干 1-2-3-4，5 从 1 岔出；然后在 3 后面再开一个 6。
	// 老的"深度优先发号"会先钻进主干子树、把 col1 发给深处的 6，回头 5 只能领 col2 ——
	// 于是第二行的 2 和 5 中间空出一格，那个洞底下还横穿着一条 3→6 的线。
	const turns = (count, from) => Array.from({ length: count }, (_, i) => ({ turn: (from || 0) + i + 1, time: 0, inherited: false }))
	const sessions = [
		{ id: 'A', createdAt: 1, turns: turns(4) },
		{ id: 'B', createdAt: 2, parentId: 'A', forkTurn: 1, turns: turns(1, 1) }, // 节点 5，落在第 2 行
		{ id: 'C', createdAt: 3, parentId: 'A', forkTurn: 3, turns: turns(1, 3) }, // 节点 6，落在第 4 行
	]
	const graph = pure.buildGraph(sessions, 'A', new Set())
	const seat = new Map(graph.nodes.filter((node) => node.entry !== undefined).map((node) => [node.key, node]))
	check(seat.get('B:2').column === 1, `5 该紧挨着主干坐 col1，实际 col${seat.get('B:2').column}`)
	check(seat.get('C:4').column === 1, `6 该接手空下来的 col1，实际 col${seat.get('C:4').column}`)
	check(graph.maxColumn === 1, `统共一条岔路宽就够了，实际用了 ${graph.maxColumn + 1} 列`)
	check(holesOf(graph) === 0, '这张图不该有洞')
	check(audit(graph).length === 0, audit(graph).join('；'))
	console.log('  5 和 6 共用 col1，没有洞，两列画完')
}

console.log('用例 2：短支线嵌进旁边子树空着的那几行')
{
	// 紧凑树和"一条分支占死一列"的差别就在这儿：B 只有一行，
	// 它该嵌进 C 那棵子树上方空着的位置，而不是白占一整列。
	const turns = (count, from) => Array.from({ length: count }, (_, i) => ({ turn: (from || 0) + i + 1, time: 0, inherited: false }))
	const sessions = [
		{ id: 'A', createdAt: 1, turns: turns(6) },
		{ id: 'B', createdAt: 2, parentId: 'A', forkTurn: 1, turns: turns(1, 1) },
		{ id: 'C', createdAt: 3, parentId: 'A', forkTurn: 4, turns: turns(2, 4) },
		{ id: 'D', createdAt: 4, parentId: 'A', forkTurn: 5, turns: turns(1, 5) },
	]
	const graph = pure.buildGraph(sessions, 'A', new Set())
	check(audit(graph).length === 0, audit(graph).join('；'))
	check(graph.maxColumn <= 2, `三条岔路该挤进 ${2 + 1} 列以内，实际 ${graph.maxColumn + 1} 列`)
	console.log(`  三条岔路画进 ${graph.maxColumn + 1} 列`)
}

console.log('用例 3：3000 棵随机树，五条不变式一条都不许破')
{
	// ⚠️ 这一套是拿来防"改分列算法时自以为想清楚了"的。我就栽过一次：
	//    照 git 提交图那套泳道复用改完，手写用例全过，随机树一扫当场露出
	//    "连线从别人头顶压过去" —— 那套是给 DAG 用的，允许交叉，树不行。
	let bad = []
	let wide = 0
	let holes = 0
	const total = 3000
	for (let i = 0; i < total; i += 1) {
		const rnd = rng(1000 + i)
		const sessions = randomTree(rnd, 1 + rnd(11))
		const graph = pure.buildGraph(sessions, sessions[rnd(sessions.length)].id, new Set())
		const found = audit(graph)
		if (found.length > 0 && bad.length === 0) bad = [`第 ${i} 棵：${found[0]}`]
		wide += graph.maxColumn
		holes += holesOf(graph)
	}
	check(bad.length === 0, bad[0])
	// 下面这两个数是**当前算法的水位**，不是什么理论值。松一点，留给以后微调的余地；
	// 真冲破了就说明改坏了 —— 旧那版深度优先的水位是 15054 / 32566。
	check(wide <= 14500, `列宽总和 ${wide} 超出水位，图变宽了`)
	check(holes <= 28000, `空洞总和 ${holes} 超出水位，图变稀了`)
	console.log(`  ${total} 棵树全干净；列宽合计 ${wide}、空洞合计 ${holes}（旧算法 15054 / 32566）`)
}

report()
