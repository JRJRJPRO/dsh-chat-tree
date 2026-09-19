/**
 * dsh-tree —— 高亮规则的合成用例。
 *
 * 【导读】
 * 干嘛的：`test.mjs` 拿真实日志跑，但盘上不一定凑得出"分支的分支的分支"这种深链。
 * 这里手捏几棵小树，把高亮规则的边界情形一次钉死。
 *
 * 规则只有一句话：**你在哪个对话里，这个对话包含的所有节点都亮边框。**
 *   · 节点的会话要在「根 → 当前会话」这条血缘链上
 *   · 轮次不能超过链上**一路下来的最小岔路点**
 *
 * 阅读顺序：
 *   第1步  取 client 的真函数
 *   第2步  造树的小工具
 *   第3步  三个用例：线性 / 一层岔路 / 三层链（沿链取最小值）
 *
 * 跑法：node test-highlight.mjs
 *
 * @module test-highlight
 */

let failures = 0

/**
 * 一条断言。
 * @param ok - 条件
 * @param message - 失败时打印什么
 */
function check(ok, message) {
	if (ok) return
	failures += 1
	console.log(`  ✗ ${message}`)
}

// ===== 第 1 步：取 client 的真函数 =====

const fakeReact = new Proxy({}, { get: () => () => undefined })
let pure
globalThis.window = {
	__ModuleLoader__: {
		load: (definition) => {
			pure = definition.factory((name) => (name === 'react' ? fakeReact : { createPortal: () => null })).__pure
		},
	},
}
globalThis.localStorage = { getItem: () => '{}', setItem: () => {} }
globalThis.document = { querySelector: () => null, head: { appendChild: () => {} }, createElement: () => ({ dataset: {}, remove: () => {} }) }
await import('./client.js')

// ===== 第 2 步：造树的小工具 =====

let clock = 0

/**
 * 捏一条分支。
 *
 * `turns` 写的是**这条分支自有的轮次号**；继承来的那些不用写，
 * 但 `forkTurn` 要如实填（= 它从父分支的第几轮岔出来）。
 * @param id - 会话 id
 * @param parentId - 父会话 id
 * @param forkTurn - 从父分支第几轮岔出来
 * @param turns - 自有轮次号
 * @returns 一条 /outlines 里的会话记录
 */
function branch(id, parentId, forkTurn, turns) {
	clock += 1
	return {
		id,
		cwd: '/x',
		parentId,
		createdAt: clock,
		forkTurn,
		turns: turns.map((turn) => ({ turn, seq: turn * 10, time: turn, prompt: `#${turn}`, compact: false, inherited: false })),
	}
}

/**
 * 站在 `currentId` 的视角建图，返回"亮边框的节点"。
 * @param sessions - 全部分支
 * @param currentId - 当前会话
 * @returns 形如 `A:2` 的 key 集合，已排序
 */
function litOf(sessions, currentId) {
	const visible = new Set(sessions.map((item) => item.id))
	const picked = pure.conversationOf(pure.visibleTree(sessions, visible), currentId)
	const graph = pure.buildGraph(picked, currentId)
	return graph.nodes
		.filter((node) => node.entry !== undefined && node.active)
		.map((node) => `${node.session.id}:${node.entry.turn}`)
		.sort()
}

/**
 * 跑一个用例。
 * @param name - 用例名
 * @param sessions - 分支表
 * @param currentId - 当前会话
 * @param expected - 期望亮起来的 key
 */
function scenario(name, sessions, currentId, expected) {
	const got = litOf(sessions, currentId)
	const want = expected.slice().sort()
	check(JSON.stringify(got) === JSON.stringify(want), `${name}：期望 ${JSON.stringify(want)}，实际 ${JSON.stringify(got)}`)
	console.log(`  ${name} → ${JSON.stringify(got)}`)
}

// ===== 第 3 步：用例 =====

console.log('用例 1：一条线性对话，站在自己身上，全亮')
{
	const A = branch('A', undefined, undefined, [1, 2, 3, 4, 5])
	scenario('线性 A(1-5)，当前 A', [A], 'A', ['A:1', 'A:2', 'A:3', 'A:4', 'A:5'])
}

console.log('\n用例 2：一层岔路 —— 站在岔路上，父分支只亮到岔路点')
{
	// A: 1,2,3,4,5      B 从 A 的第 2 轮岔出，自有 3,4
	const A = branch('A', undefined, undefined, [1, 2, 3, 4, 5])
	const B = branch('B', 'A', 2, [3, 4])
	scenario('当前 A（主干）', [A, B], 'A', ['A:1', 'A:2', 'A:3', 'A:4', 'A:5'])
	scenario('当前 B（岔路）', [A, B], 'B', ['A:1', 'A:2', 'B:3', 'B:4'])
}

console.log('\n用例 3：三层链 —— 限制必须沿链取最小值')
{
	// A: 1,2,3,4
	// B 从 A 第 1 轮岔出，自有 2,3,4
	// C 从 B 第 3 轮岔出，自有 4,5
	// D 从 C 第 2 轮岔出（这一轮在 C 里是继承来的），自有 6
	//
	// D 的对话 = A 的第 1 轮 + B 的第 2 轮。
	// **B 的第 3 轮不在里面**：C 虽然继承到第 3 轮，但 D 只继承到第 2 轮。
	// 只看相邻一层（"C 从 B 第 3 轮岔出"）就会把 B:3 错误地算亮。
	const A = branch('A', undefined, undefined, [1, 2, 3, 4])
	const B = branch('B', 'A', 1, [2, 3, 4])
	const C = branch('C', 'B', 3, [4, 5])
	const D = branch('D', 'C', 2, [6])
	scenario('当前 C', [A, B, C, D], 'C', ['A:1', 'B:2', 'B:3', 'C:4', 'C:5'])
	scenario('当前 D', [A, B, C, D], 'D', ['A:1', 'B:2', 'D:6'])
}

console.log('\n用例 4：岔路点落在父分支"继承来的"那一段里')
{
	// A: 1,2,3        B 从 A 第 1 轮岔出，自有 2,3
	// C 从 B 第 1 轮岔出 —— 第 1 轮在 B 里是继承来的，B 自己没有这个节点。
	// 老做法（沿 node.parent 往上走）在这里会退到 B 的挂载点，把中间节点漏掉。
	const A = branch('A', undefined, undefined, [1, 2, 3])
	const B = branch('B', 'A', 1, [2, 3])
	const C = branch('C', 'B', 1, [2])
	scenario('当前 C', [A, B, C], 'C', ['A:1', 'C:2'])
}

console.log('\n用例 5：节点样式的 key 集合必须恒定，且边框不许用简写')
{
	// 为什么要守这条：React 更新内联样式时，会把**上一帧有、这一帧没有**的属性置空。
	// 如果某个形态多写了 `borderColor` 而 base 用的是 `border` 简写，
	// 那么从那个形态切回来时 borderColor 被清成 ''，border-color 退回 currentColor
	// —— 屏幕上就是"滑过一个点白一个"。key 集合恒定就根本不会触发这个清空。
	const variants = []
	for (const kind of ['normal', 'current', 'compact', 'empty']) {
		for (const active of [true, false]) {
			for (const hover of [true, false]) variants.push({ label: `${kind}/${active ? '路径上' : '路径外'}/${hover ? '悬停' : '常态'}`, style: pure.dotStyle(kind, active, hover, 9) })
		}
	}
	const reference = Object.keys(variants[0].style).sort()
	for (const variant of variants) {
		const keys = Object.keys(variant.style).sort()
		check(JSON.stringify(keys) === JSON.stringify(reference), `${variant.label} 的样式 key 和别的形态对不上：多/少了 ${JSON.stringify(keys.filter((k) => !reference.includes(k)).concat(reference.filter((k) => !keys.includes(k))))}`)
		check(variant.style.border === undefined, `${variant.label} 用了 border 简写，会和 borderColor 打架`)
		check(typeof variant.style.borderColor === 'string' && variant.style.borderColor.length > 0, `${variant.label} 没有显式的 borderColor`)
	}
	console.log(`  ${variants.length} 种形态组合，key 集合一致（${reference.length} 个），边框全是 longhand`)
}

console.log('\n用例 6：走廊必须盖住鼠标去 ＋ 路上的每一个命中区')
{
	// 为什么要守这条：列间距 14px 而命中区宽 18px，往左挪 5px 就进了左邻居的地盘。
	// ＋ 在卡片右缘（导轨外侧），鼠标必须横穿左边所有列才够得着 —— 沿途每个点
	// 都会抢走悬停，于是 ＋ 永远变成最左边那个点的。走廊就是用来挡这一路抢夺的。
	const { Z } = pure
	const HIT = 18 // 命中区宽度，和 client.js 里画的那条对齐

	// 走廊是个梯形（clip-path），所以"盖没盖住"要按多边形算，不能只比左右边界。
	// 传进来的是**绝对坐标**（导轨内坐标系，y 以悬停点为 0）。
	const inWedge = (span, ax, ay) => {
		const lx = ax - span.left
		const ly = ay + span.height / 2
		let inside = false
		for (let i = 0, j = span.points.length - 1; i < span.points.length; j = i++) {
			const [xi, yi] = span.points[i]
			const [xj, yj] = span.points[j]
			if (yi > ly !== yj > ly && lx < ((xj - xi) * (ly - yi)) / (yj - yi) + xi) inside = !inside
		}
		return inside
	}

	for (const maxColumn of [1, 2, 5]) {
		const railWidth = 18 + maxColumn * Z.lane
		const xOf = (column) => railWidth - 9 - column * Z.lane
		for (let hovered = 0; hovered <= maxColumn; hovered++) {
			const hx = xOf(hovered)
			const span = pure.bridgeBox(hx, Z.dot, Z.row)
			const tag = `maxColumn=${maxColumn} 悬停第${hovered}列`

			check(span.left <= -4, `${tag}：走廊左缘 ${span.left} 没够到卡片右缘 -4`)
			check(!inWedge(span, hx, 0), `${tag}：走廊盖住了自己的圆心，点不动了`)

			// ＋ 在卡片右端，和点同高 —— 这是整条路的终点，必须在走廊里
			check(inWedge(span, -4, 0), `${tag}：卡片右缘(-4)没被走廊盖住，最后一步就被抢`)

			for (let other = hovered + 1; other <= maxColumn; other++) {
				// 左邻居命中区的右端 —— 沿途最先抢的就是它
				check(inWedge(span, xOf(other) + HIT / 2, 0), `${tag}：第${other}列的命中区右端露在走廊外面，鼠标一过就被抢`)
			}
		}
	}
	console.log('  3 种列宽 × 每一列悬停，左侧命中区全部被盖住，自身圆心和卡片右缘都对')

	// 梯形的意义：越靠近卡片张得越开（斜着奔 ＋ 不掉出去），越靠近点越窄（想脱身往上下行走一步就行）。
	{
		const span = pure.bridgeBox(80, Z.dot, Z.row)
		check(span.far > span.near, `走廊没张开：近端半高 ${span.near}，远端 ${span.far}`)
		check(inWedge(span, -4, span.near + 3), `卡片那一端不够高，斜着奔 ＋ 会掉出去`)
		check(!inWedge(span, 80 - Z.dot / 2 - 2, span.near + 3), `贴着点那一端太胖，往上下行脱身要绕远`)
		console.log(`  梯形：贴着点 ±${span.near}，贴着卡片 ±${span.far}`)
	}

	// 走廊高度：树压缩时 rowH 会掉到 rowMin(7px)，直接拿 rowH 当高度的话走廊成了一条窄缝，
	// 鼠标竖直抖一下就滑出去被上下行抢走。至少要盖住一个点的直径。
	for (const rowH of [Z.row, Z.rowMin, 5]) {
		const height = pure.bridgeBox(100, Z.dot, rowH).height
		check(height >= Z.dot * 2, `rowH=${rowH} 时走廊只有 ${height}px 高，竖直方向抖一下就滑出去`)
		check(height >= rowH, `rowH=${rowH} 时走廊 ${height}px 比行还矮，本行自己都盖不满`)
	}
	console.log(`  行高 ${Z.row}/${Z.rowMin}/5 三档，走廊高度都不小于 ${Z.dot * 2}px`)

	// 让位那一刻要自己算鼠标压着谁：元素在静止的鼠标下出现不会触发 mouseenter。
	const seats = [{ x: 100, node: 'A' }, { x: 86, node: 'B' }, { x: 72, node: 'C' }]
	check(pure.nodeUnder(seats, 86, 9) === 'B', '正压着 B 却没选中 B')
	check(pure.nodeUnder(seats, 90, 9) === 'B', '偏 B 一点应该还是 B（离 B 4px，离 A 10px）')
	check(pure.nodeUnder(seats, 40, 9) === undefined, '离所有点都远，不该硬塞一个')
	check(pure.nodeUnder([], 86, 9) === undefined, '空行不该崩')
	console.log('  让位时的取点：压中 / 偏一点 / 够不着 / 空行，四种都对')
}

console.log('\n用例 7：几个孩子的横线叠在一起时，蓝线必须压在最上面')
{
	// A 的第 1 轮后面挂了 4 条后续：A 自己走直线（同列），B/C/D 各占左边一列。
	// 这几条的横段都贴在 A:1 那一行，越远的横段越长 —— 短的会整段盖住长的右半截。
	// 站在 D 上时只有 D 的横段是蓝的，B、C 的是灰的；灰的要是后画，
	// 屏幕上就是 John 报的"横线只有左边一半是蓝的，右边一半是灰的"。
	const A = branch('A', undefined, undefined, [1, 2, 3])
	const B = branch('B', 'A', 1, [2, 3])
	const C = branch('C', 'A', 1, [2])
	const D = branch('D', 'A', 1, [2])
	const sessions = [A, B, C, D]
	const visible = new Set(sessions.map((item) => item.id))
	const bent = (node) => node.parent !== undefined && node.column !== node.parent.column
	let total = 0

	for (const currentId of ['A', 'B', 'C', 'D']) {
		const graph = pure.buildGraph(pure.conversationOf(pure.visibleTree(sessions, visible), currentId), currentId)

		// 照 client.js 的顺序刷一遍"油漆"：横段占 [lo列, hi列) 这些单位区间，后画的盖先画的。
		const paint = new Map()
		const span = (node) => {
			const lo = Math.min(node.column, node.parent.column)
			const hi = Math.max(node.column, node.parent.column)
			return Array.from({ length: hi - lo }, (_, i) => `${node.parent.depth}:${lo + i}`)
		}
		for (const node of pure.edgeOrder(graph.nodes)) {
			if (!bent(node)) continue // 直上直下的边只有竖段，各占各的列，不会打架
			for (const cell of span(node)) paint.set(cell, node.active ? 'blue' : 'gray')
		}

		let lit = 0
		for (const node of graph.nodes) {
			if (!bent(node) || !node.active) continue
			for (const cell of span(node)) {
				lit += 1
				check(paint.get(cell) === 'blue', `当前 ${currentId}：${node.parent.key} → ${node.key} 的横段在格 ${cell} 被灰线盖掉了`)
			}
		}
		total += lit
		console.log(`  当前 ${currentId} → 横段共 ${paint.size} 段，其中该蓝的 ${lit} 段`)
	}
	check(total > 0, '这组用例一条带折角的蓝线都没造出来，等于什么都没测')
}

console.log(failures === 0 ? '\n✓ 全部断言通过' : `\n✗ ${failures} 条断言失败`)
process.exit(failures === 0 ? 0 : 1)
