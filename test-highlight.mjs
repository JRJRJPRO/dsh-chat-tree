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
		// 真实大纲里，分支**也带着**继承来的那几轮（inherited: true），会被 ownTurns 滤掉。
		// 照造出来是为了贴近真实数据，别让测试在一份比现实干净的输入上跑绿。
		turns: [
			...Array.from({ length: forkTurn === undefined ? 0 : forkTurn }, (_, i) => ({ turn: i + 1, seq: (i + 1) * 10, time: i + 1, prompt: `#${i + 1}`, compact: false, inherited: true })),
			...turns.map((turn) => ({ turn, seq: turn * 10, time: turn, prompt: `#${turn}`, compact: false, inherited: false })),
		],
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

console.log('\n用例 5：节点样式 —— key 集合恒定、边框 longhand、形状与状态正交')
{
	// 为什么要守 key 集合：React 更新内联样式时，会把**上一帧有、这一帧没有**的属性置空。
	// 如果某个形态多写了 `borderColor` 而 base 用的是 `border` 简写，
	// 那么从那个形态切回来时 borderColor 被清成 ''，border-color 退回 currentColor
	// —— 屏幕上就是"滑过一个点白一个"。key 集合恒定就根本不会触发这个清空。
	const variants = []
	for (const kind of ['normal', 'compact', 'empty']) {
		for (const active of [true, false]) {
			for (const hover of [true, false]) {
				for (const focused of [true, false]) {
					variants.push({
						kind,
						label: `${kind}/${active ? '路径上' : '路径外'}/${hover ? '悬停' : '常态'}/${focused ? '当前轮' : '非当前'}`,
						style: pure.dotStyle(kind, active, hover, 9, focused),
					})
				}
			}
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

	// 形状必须和状态正交：压缩节点**任何状态下**都得是菱形。
	// 老做法 `kind = focused ? 'current' : node.kind` 会让它一滑到就变回蓝圆点 ——
	// "一眼看出是压缩节点"恰好在最该看清的时候失效。
	const spun = /rotate\(45deg\)/
	for (const variant of variants) {
		const want = variant.kind === 'compact'
		check(spun.test(variant.style.transform) === want, `${variant.label}：${want ? '压缩节点没转成菱形' : '普通节点不该旋转'}`)
		check((variant.style.borderRadius === '50%') === !want, `${variant.label}：${want ? '压缩节点还是个正圆' : '普通节点该是正圆'}`)
	}

	// "当前轮"只该换填充和外发光，不许动形状
	const lit = pure.dotStyle('compact', true, false, 9, true)
	const dim = pure.dotStyle('compact', true, false, 9, false)
	check(lit.transform === dim.transform && lit.borderRadius === dim.borderRadius, '压缩节点滑到时形状变了')
	check(lit.background !== dim.background && lit.boxShadow !== dim.boxShadow, '压缩节点滑到时看不出是当前轮')
	console.log('  压缩节点四种状态全是菱形；当前轮只换填充和外发光')
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

console.log('\n用例 8：＋ 在空节点 / 叶子上该做什么')
{
	// John 报的：新建一个对话，图上只有一个空节点，点 ＋ 却又建了一条空对话。
	// 空节点代表"对话开始之前"，它底下什么都没有时，当前这条会话本身就是那条空对话，
	// 再 fresh 一条只是多出一条一模一样的（和叶子节点不该 fork 是同一条道理）。
	const leafRoot = { entry: undefined, children: [] }
	const rootWithKids = { entry: undefined, children: [{}] }
	const leaf = { entry: { turn: 3 }, children: [] }
	const forked = { entry: { turn: 3 }, children: [{}, {}] }

	check(pure.branchAction(leafRoot) === 'none', '光秃秃的空节点点 ＋ 不该有任何反应')
	check(pure.branchAction(rootWithKids) === 'fresh', '底下已有分支的空节点，＋ 才是"再开一条新对话"')
	check(pure.branchAction(leaf) === 'open', '叶子节点该就地接着问，不 fork')
	check(pure.branchAction(forked) === 'fork', '有后续的节点才真的 fork')
	console.log('  空节点(无子)=none / 空节点(有子)=fresh / 叶子=open / 有后续=fork')

	// 工作区归属：侧栏按 workspace.sessionIds 分组，不是按 cwd。
	// 只传 cwd 建出来的会话谁都不认领，就掉进"未分组"。
	const state = { items: [{ workspaceId: 'w1', sessionIds: ['s1', 's2'] }, { workspaceId: 'w2', sessionIds: ['s3'] }] }
	check(pure.workspaceOf(state, 's2') === 'w1', 's2 明明在 w1 里却没查出来')
	check(pure.workspaceOf(state, 's3') === 'w2', 's3 该归 w2')
	check(pure.workspaceOf(state, 'nope') === undefined, '查不到就该是 undefined，好退回 cwd')
	check(pure.workspaceOf(undefined, 's1') === undefined, '快照还没到时不该崩')
	check(pure.workspaceOf({ items: [{ workspaceId: 'w' }] }, 's1') === undefined, 'sessionIds 缺失不该崩')
	console.log('  工作区归属：命中 / 另一个 / 查不到 / 空快照 / 字段缺失，五种都对')
}

console.log('\n用例 9：分组与分离 —— 哪几条对话算同一棵树')
{
	// 分组：必须**主动登记**。a / b / c 三条互不相干的对话各自成树；
	// 在 b 的空节点上按 ＋ 开出来的 d 才登记进 b 那棵。
	// ⚠️ 曾经试过"整个 cwd 全算一棵"，16 条对话把导轨撑到 326px。别再回去。
	const pick = (sessions, currentId, groupOf) => {
		const visible = new Set(sessions.map((item) => item.id))
		return pure
			.conversationOf(pure.visibleTree(sessions, visible), currentId, groupOf)
			.map((item) => item.id)
			.sort()
	}

	const a = branch('a', undefined, undefined, [1, 2])
	const b = branch('b', undefined, undefined, [1, 2])
	const c = branch('c', undefined, undefined, [1])
	const d = branch('d', undefined, undefined, [1])
	const all = [a, b, c, d]

	check(JSON.stringify(pick(all, 'a')) === '["a"]', '没登记过分组时 a 该自成一棵')
	check(JSON.stringify(pick(all, 'b', { d: 'b' })) === '["b","d"]', 'b 和 d 该同树')
	check(JSON.stringify(pick(all, 'd', { d: 'b' })) === '["b","d"]', '从 d 看过去也该是同一棵')
	check(JSON.stringify(pick(all, 'a', { d: 'b' })) === '["a"]', 'a 不该被卷进 b 那棵树')
	console.log('  三条独立对话各自成树；＋ 登记后同树')
}

console.log('\n用例 10：分离 —— 剪的是图上的边，不是会话边界')
{
	// John 报的：节点 1 后面跟着 2/3/4/5，其中 2 是**会话自己的下一轮**、3/4/5 是 fork。
	// 老做法只认"fork 出来的新会话"，于是唯独 2 没有分离按钮 —— 但它在图上和 3/4/5
	// 一样只是 1 的一个孩子，凭什么区别对待。
	//
	// 规矩：一路往上只要有哪个祖先有多个孩子，这个节点就能分离。
	// 剪在 N：新树 = 根到 N 父亲那段路径（前缀）+ N 的整棵子树；旧树 = 原树扣掉 N 的子树。
	//
	// 造一棵：主干 M 自有 1,2,6（1→2→6 一条直线），
	//        三条分支 P/Q/R 都从 M 的第 1 轮岔出，各自有一轮（图上就是 1 的另外三个孩子）。
	const M = branch('M', undefined, undefined, [1, 2, 6])
	const P = branch('P', 'M', 1, [3])
	const Q = branch('Q', 'M', 1, [4])
	const R = branch('R', 'M', 1, [5])
	const sessions = [M, P, Q, R]
	const visible = new Set(sessions.map((item) => item.id))

	const graphOf = (currentId, cuts) =>
		pure.buildGraph(pure.conversationOf(pure.visibleTree(sessions, visible), currentId, undefined), currentId, cuts)
	const keysOf = (graph) =>
		graph.nodes
			.filter((node) => node.entry !== undefined)
			.map((node) => node.key)
			.sort()

	const whole = graphOf('M')
	const byKey = new Map(whole.nodes.map((node) => [node.key, node]))

	// 能不能分离：1 是独苗（root 只有它一个孩子）→ 不能；2/3/4/5 互为兄弟 → 都能；
	// 6 跟在 2 后面，虽然自己是独苗，但祖先 1 有四个孩子 → 也能。
	check(byKey.get('M:1').canDetach === false, '节点 1 头顶没有岔路，不该给分离')
	for (const key of ['M:2', 'P:3', 'Q:4', 'R:5']) {
		check(byKey.get(key).canDetach === true, `${key} 是 1 的孩子之一，该能分离`)
	}
	check(byKey.get('M:6').canDetach === true, '6 自己是独苗，但祖先 1 有岔路，该能分离（John 报的第二种）')
	console.log('  能否分离：1 不能；2/3/4/5 能；跟在 2 后面的 6 也能')

	// 剪掉 2（会话自己的下一轮）—— 老做法根本剪不了这种
	{
		const rest = keysOf(graphOf('P', ['M:2']))
		const gone = keysOf(graphOf('M', ['M:2']))
		check(JSON.stringify(rest) === '["M:1","P:3","Q:4","R:5"]', `剪掉 2 之后旧树该剩 1/3/4/5，实际 ${JSON.stringify(rest)}`)
		check(JSON.stringify(gone) === '["M:1","M:2","M:6"]', `拆出来的该是 1-2-6（带前缀 1），实际 ${JSON.stringify(gone)}`)
	}

	// 剪掉 6（更深的一层）：新树 = 1-2-6，旧树 = 1-2 + 三条分支
	{
		const mine = keysOf(graphOf('M', ['M:6']))
		check(JSON.stringify(mine) === '["M:1","M:2","M:6"]', `站在 M 上该看到 1-2-6，实际 ${JSON.stringify(mine)}`)
		const other = keysOf(graphOf('P', ['M:6']))
		check(JSON.stringify(other) === '["M:1","M:2","P:3","Q:4","R:5"]', `旧树该扣掉 6，实际 ${JSON.stringify(other)}`)
	}

	// 剪掉一条 fork（老做法唯一支持的情形，不能回归）
	{
		const cut = keysOf(graphOf('P', ['P:3']))
		check(JSON.stringify(cut) === '["M:1","P:3"]', `拆出来的支线该是 1-3，实际 ${JSON.stringify(cut)}`)
		const left = keysOf(graphOf('M', ['P:3']))
		check(JSON.stringify(left) === '["M:1","M:2","M:6","Q:4","R:5"]', `旧树该扣掉 3，实际 ${JSON.stringify(left)}`)
	}

	// 剪完之后列宽要跟着缩：剪掉的子树不该还占着列
	{
		const before = graphOf('M').maxColumn
		const after = graphOf('M', ['P:3', 'Q:4', 'R:5']).maxColumn
		check(after < before, `剪掉三条分支后列宽该变窄（${before} → ${after}）`)
		console.log(`  剪边后列宽 ${before} → ${after}`)
	}

	// 剪完之后 canDetach 要自动跟上：只剩独苗链了就都不能再分离
	{
		const lone = graphOf('M', ['P:3', 'Q:4', 'R:5'])
		check(
			lone.nodes.every((node) => node.canDetach !== true),
			'旁边的岔路都拆光了，剩下的独苗链不该还显示分离',
		)
		console.log('  岔路拆光后，剩下的独苗链自动收起分离按钮')
	}

	// 老格式（纯会话 id）要还能用，不能让之前拆过的悄悄失效
	{
		const legacy = pure.cutSet(['P', 'M:2'], sessions)
		check(legacy.has('P:3') && legacy.has('M:2'), `老格式该翻成 P:3，实际 ${JSON.stringify([...legacy])}`)
		check(pure.cutSet(['查无此人'], sessions).size === 0, '找不到落点的老记录该直接丢掉')
		check(pure.cutSet(undefined, sessions).size === 0, '空清单不该崩')
		console.log('  老格式的会话 id 自动翻成节点 key')
	}
}

console.log(failures === 0 ? '\n✓ 全部断言通过' : `\n✗ ${failures} 条断言失败`)
process.exit(failures === 0 ? 0 : 1)
