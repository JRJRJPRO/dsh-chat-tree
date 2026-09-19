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

console.log('\n用例 6：hover intent —— 赶路途中谁都不许抢走卡片')
{
	// 为什么要守这条：列间距 14px 而命中区宽 18px，往左挪 5px 就进了左邻居的地盘。
	// ＋ 在卡片上（导轨外侧），鼠标必须横穿左边所有列才够得着。
	//
	// 上一版靠"透明走廊 + 梯形 clip-path + 掉头就让位 + 超时拆除"四套启发式互相兜底，
	// 实测仍然够不着。现在改成业界标准的 hover intent：**只有鼠标停下来才换目标**。
	// 下面这个 replay 是 client.js 里那个 onMouseMove 的纯逻辑版本。
	const { Z } = pure

	/**
	 * 把一条鼠标轨迹喂进 hover intent，返回最终停在哪个点上。
	 * @param seats - 可见的点
	 * @param path - 轨迹，每项 {x, y, pause}；pause=true 表示在这里停够了 restMs
	 * @param from - 起始已开着的卡片（null = 还没开）
	 * @returns 最终悬停的点
	 */
	const replay = (seats, path, from) => {
		let hover = from
		let pending
		for (const step of path) {
			const at = pure.nodeAt(seats, step.x, step.y, Z.hit, Z.row)
			pending = undefined // 每次移动都清计时器 —— 这是整套机制的关键
			const want = pure.hoverNext(hover, at)
			if (want === 'now') hover = at
			else if (want === 'rest') pending = at
			if (step.pause && pending !== undefined) hover = pending
		}
		return hover
	}

	for (const maxColumn of [1, 2, 5]) {
		const railWidth = 18 + maxColumn * Z.lane
		const xOf = (column) => railWidth - 9 - column * Z.lane
		const seats = Array.from({ length: maxColumn + 1 }, (_, column) => ({ x: xOf(column), y: 0, node: `c${column}` }))

		for (let hovered = 0; hovered <= maxColumn; hovered++) {
			const tag = `maxColumn=${maxColumn} 悬停第${hovered}列`
			// 从这个点一路向左走到卡片右缘(-4)，每 1px 采一个点，中途不停
			const path = []
			for (let x = xOf(hovered); x >= -4; x -= 1) path.push({ x, y: 0 })
			check(replay(seats, path, `c${hovered}`) === `c${hovered}`, `${tag}：横穿 ${xOf(hovered) + 4}px 到卡片，卡片被别的点抢走了`)
		}

		// 反过来：真想选左边那个点时，停下来就得换过去 —— 不能为了防抢把正常选择也堵死
		if (maxColumn >= 1) {
			const path = []
			for (let x = xOf(0); x >= xOf(1); x -= 1) path.push({ x, y: 0 })
			path[path.length - 1].pause = true
			check(replay(seats, path, 'c0') === 'c1', `maxColumn=${maxColumn}：停在第 1 列上却没换过去，正常选择被堵死了`)
		}
	}
	console.log('  3 种列宽 × 每一列，不停地走 → 卡片不被抢；停下来 → 正常换目标')

	// 还没开卡片时要跟手：第一次碰到点就立刻开，不能也等 restMs
	{
		const seats = [{ x: 100, y: 0, node: 'A' }]
		check(replay(seats, [{ x: 100, y: 0 }], null) === 'A', '卡片还没开的时候第一次碰到点没立刻开，手感发粘')
	}

	// 命中测试本身：压中 / 偏一点 / 够不着 / 隔壁行 / 空行
	{
		const seats = [{ x: 100, y: 0, node: 'A' }, { x: 86, y: 0, node: 'B' }, { x: 100, y: 20, node: 'C' }]
		check(pure.nodeAt(seats, 86, 0, Z.hit, Z.row) === 'B', '正压着 B 却没选中 B')
		check(pure.nodeAt(seats, 90, 0, Z.hit, Z.row) === 'B', '偏 B 一点应该还是 B（离 B 4px，离 A 10px）')
		check(pure.nodeAt(seats, 40, 0, Z.hit, Z.row) === undefined, '离所有点都远，不该硬塞一个')
		check(pure.nodeAt(seats, 100, 20, Z.hit, Z.row) === 'C', '下一行的点没认出来')
		check(pure.nodeAt([], 86, 0, Z.hit, Z.row) === undefined, '空行不该崩')
		console.log('  命中测试：压中 / 偏一点 / 够不着 / 隔壁行 / 空行，五种都对')
	}
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
