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

import { check, loadClientPure, report } from './test-kit.mjs'


// ===== 第 1 步：取 client 的真函数 =====

const pure = await loadClientPure()

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

	// 形状必须和状态正交：压缩节点**任何状态下**的形状都一样，且和普通节点不一样。
	// 老做法 `kind = focused ? 'current' : node.kind` 会让它一滑到就变回蓝圆点 ——
	// "一眼看出是压缩节点"恰好在最该看清的时候失效。
	// 这里不写死"菱形"，只比形状指纹 —— 默认形状是可以改的（现在压缩节点默认是倒三角）。
	const fingerprint = (style) => `${style.borderRadius}|${style.borderWidth}|${style.background === 'none'}|${/rotate\(45deg\)/.test(style.transform)}`
	const packed = variants.filter((one) => one.kind === 'compact')
	const plain = variants.filter((one) => one.kind === 'normal')
	for (const variant of packed) check(fingerprint(variant.style) === fingerprint(packed[0].style), `${variant.label}：压缩节点换了个状态就换了形状`)
	for (const variant of plain) check(fingerprint(variant.style) !== fingerprint(packed[0].style), `${variant.label}：普通节点和压缩节点长得一样，一眼看不出哪个是压缩的`)

	// "当前轮"只该换填充和外发光，不许动形状
	const lit = pure.dotStyle('compact', true, false, 9, true)
	const dim = pure.dotStyle('compact', true, false, 9, false)
	check(fingerprint(lit) === fingerprint(dim), '压缩节点滑到时形状变了')
	// 三角的填充画在里面那个 <svg> 上，所以查 inkOf 而不是查方框的 background
	check(pure.inkOf('compact', true, true).fill !== pure.inkOf('compact', true, false).fill, '压缩节点滑到时填充没变，看不出是当前轮')
	// 外发光：能描边的用 box-shadow，剪出来的形状用 drop-shadow（box-shadow 会被一起剪掉）
	check(lit.boxShadow !== dim.boxShadow || lit.filter !== dim.filter, '压缩节点滑到时没有外发光')
	console.log('  压缩节点四种状态形状一致且区别于普通节点；当前轮只换填充和外发光')
}

console.log('\n用例 6：hover intent —— 赶路途中谁都不许抢走卡片')
{
	// 为什么要守这条：列间距只有 17px 而命中区宽 22px，往左挪几像素就进了左邻居的地盘。
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
		const railWidth = Z.hit + maxColumn * Z.lane
		const xOf = (column) => railWidth - Z.hit / 2 - column * Z.lane
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

	// 父会话正在跑的时候不许开岔路：新分支要继承上下文就得读它的记录，
	// 而读那个文件会打断它正在跑的那一轮。**不偷偷开一条失忆分支，也不延后，当场说原因。**
	const idle = { claude: true }
	const running = { claude: true, running: true }
	const plain = { running: true } // 普通 provider：对话原文在 dsh 日志里，没什么要读的
	const node = (session, children) => ({ entry: { turn: 3 }, children, session })

	check(pure.forkBlockedWhy(node(running, [{}, {}])) !== '', 'claude 会话正在跑时，＋ 必须拦下来')
	check(pure.forkBlockedWhy(node(running, [{}, {}])).includes('跑完'), '拦下来还得告诉用户什么时候能再试')
	check(pure.forkBlockedWhy(node(idle, [{}, {}])) === '', '空闲时不许拦 —— 拦了就是把功能关了')
	check(pure.forkBlockedWhy(node(plain, [{}, {}])) === '', '普通 provider 没有要读的记录，在跑也照开')
	// 另外三种动作都不读父会话的记录，一律不拦
	check(pure.forkBlockedWhy(node(running, [])) === '', '叶子上是"就地接着问"，不新建会话，不该拦')
	check(pure.forkBlockedWhy({ entry: undefined, children: [{}], session: running }) === '', '空节点上是"开新对话"，没有上下文可继承，不该拦')
	check(pure.forkBlockedWhy({ entry: { turn: 3 }, children: [{}, {}], session: running, rewound: true }) === '', '撤回掉的节点本来就是 none，不该再报别的原因')
	console.log(`  claude 在跑 → 「${pure.forkBlockedWhy(node(running, [{}, {}]))}」；空闲 / 普通 provider / 非 fork → 照常`)

	// 「无上下文」那块牌子只挂在岔路口那一个节点上，挂满整条分支会刷屏
	const branch = { turns: [{ turn: 7, inherited: true }, { turn: 8 }, { turn: 9 }] }
	check(pure.isBranchHead({ entry: { turn: 8 }, session: branch }) === true, '分支的第一个自有轮次就是分支头')
	check(pure.isBranchHead({ entry: { turn: 9 }, session: branch }) === false, '后面的轮次不是分支头')
	check(pure.isBranchHead({ entry: { turn: 7 }, session: branch }) === false, '继承来的轮次画的是父会话的节点，不算分支头')
	check(pure.isBranchHead({ entry: undefined, session: branch }) === false, '空节点不属于任何分支')
	console.log('  「无上下文」只挂在分支头上（继承段和后续轮次都不挂）')

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
	// 剪点：**不是**你点的那个节点。一路往上，直到撞见有多个孩子的父亲，
	// 剪点是它底下的那个节点。
	{
		check(pure.cutPointOf(byKey.get('M:6')) === byKey.get('M:2'), '在 6 上点分离，该剪在 2（6 的父亲 2 是独苗，要继续往上）')
		check(pure.cutPointOf(byKey.get('M:2')) === byKey.get('M:2'), '2 本身就贴着岔路，剪点就是它自己')
		check(pure.cutPointOf(byKey.get('P:3')) === byKey.get('P:3'), '分支起点的剪点是它自己')
		check(pure.cutPointOf(byKey.get('M:1')) === undefined, '一路到根都没岔路，没得剪')
		// 和 canDetach 必须是同一件事，否则会出现"按钮在但点了没用"
		for (const node of whole.nodes) {
			check((pure.cutPointOf(node) !== undefined) === (node.canDetach === true), `${node.key}：canDetach 和 cutPointOf 对不上`)
		}
		console.log('  剪点：6→2、2→2、3→3、1→无；和 canDetach 完全一致')
	}
}

console.log('\n用例 11：分离后两棵树不能互相残留（John 报的"不同步"）')
{
	// 1-2-3-5 和 1-2-4-6 本来一棵树，在 6 上点分离。
	// 期望：新树 1-2-4-6，旧树 1-2-3-5 —— **4 必须跟着走**，不能留在旧树里。
	// A 自有 1,2,3,4；B 从 A 第 2 轮岔出，自有 3,4。
	// 图上：root → A:1 → A:2 → { A:3 → A:4, B:3 → B:4 }
	const A = branch('A', undefined, undefined, [1, 2, 3, 4])
	const B = branch('B', 'A', 2, [3, 4])
	const sessions = [A, B]
	const visible = new Set(['A', 'B'])
	const graphOf = (currentId, cuts) =>
		pure.buildGraph(pure.conversationOf(pure.visibleTree(sessions, visible), currentId, undefined), currentId, cuts)
	const keysOf = (graph) =>
		graph.nodes
			.filter((node) => node.entry !== undefined)
			.map((node) => node.key)
			.sort()

	const whole = graphOf('B')
	const clicked = whole.nodes.find((node) => node.key === 'B:4')
	const at = pure.cutPointOf(clicked)
	check(at !== undefined && at.key === 'B:3', `在 B:4 上点分离该剪在 B:3，实际 ${at && at.key}`)

	const cuts = [at.key]
	const mine = keysOf(graphOf('B', cuts))
	const other = keysOf(graphOf('A', cuts))
	check(JSON.stringify(mine) === '["A:1","A:2","B:3","B:4"]', `拆出来的该是 1-2-4-6，实际 ${JSON.stringify(mine)}`)
	check(JSON.stringify(other) === '["A:1","A:2","A:3","A:4"]', `旧树该是 1-2-3-5，实际 ${JSON.stringify(other)}`)
	check(!other.includes('B:3'), 'B:3（图上的 4）还留在旧树里 —— 这就是"不同步"的样子')
	// 除了照抄的前缀，两棵树不该有交集
	const overlap = mine.filter((key) => other.includes(key))
	check(JSON.stringify(overlap) === '["A:1","A:2"]', `两棵树只该共享前缀 1-2，实际重合 ${JSON.stringify(overlap)}`)
	console.log('  在 6 上分离 → 新树 1-2-4-6、旧树 1-2-3-5，只共享前缀 1-2')
}


console.log('\n用例 12：自定义颜色与形状')
{
	// 设置里能改三个角色的颜色和形状。要守住的是：
	//   · 换了主色，派生色（路径垫色 / 外发光 / 连线）必须跟着换，不能还硬编码蓝
	//   · key 集合仍然恒定（否则又是"滑过一个点白一个"）
	//   · 认不得的值退回默认，不能把树搞崩
	const skin = {
		normalColor: '#112233', normalShape: 'square',
		currentColor: '#00ff00', currentShape: 'rounded',
		compactColor: '#ff00ff', compactShape: 'circle',
	}

	// 主色换成绿色 → 当前轮的填充、外发光都该是绿的，不能残留蓝
	const lit = pure.dotStyle('normal', true, false, 9, true, skin)
	check(lit.background === '#00ff00', `当前轮填充该用主色，实际 ${lit.background}`)
	check(/0,\s*255,\s*0/.test(lit.boxShadow), `外发光该跟着主色，实际 ${lit.boxShadow}`)
	check(!/88,\s*166,\s*255/.test(JSON.stringify(lit)), `换了主色还残留默认蓝：${JSON.stringify(lit)}`)

	// 在路径上但不是当前轮 → 边框和垫色都从主色派生
	const onPath = pure.dotStyle('normal', true, false, 9, false, skin)
	check(/0,\s*255,\s*0/.test(onPath.borderColor), `路径上的边框该跟着主色，实际 ${onPath.borderColor}`)
	check(/0,\s*255,\s*0/.test(onPath.background), `路径上的垫色该跟着主色，实际 ${onPath.background}`)

	// 不在路径上 → 用普通节点色
	const off = pure.dotStyle('normal', false, false, 9, false, skin)
	check(off.borderColor === '#112233', `路径外该用普通节点色，实际 ${off.borderColor}`)

	// 当前路径的形状**必须独立生效**。曾经 shapeOf 把 current 和 normal 合成一个，
	// 于是设置里"当前路径形状"怎么改都没反应 —— John 报的"改了好像没反应"就是这条。
	check(onPath.borderRadius === '30%', `当前路径该用 currentShape（圆角方 30%），实际 ${onPath.borderRadius}`)
	check(off.borderRadius !== onPath.borderRadius, '路径内外形状设得不一样，画出来却一样')
	const swapped = Object.assign({}, skin, { currentShape: 'diamond' })
	check(/rotate\(45deg\)/.test(pure.dotStyle('normal', true, false, 9, false, swapped).transform), '当前路径设成菱形却没转 45°')
	check(!/rotate/.test(pure.dotStyle('normal', false, false, 9, false, swapped).transform), '只把当前路径设成菱形，路径外的点不该跟着转')
	// 让开量也得跟着当前路径的形状走，否则菱形的尖角会戳到线上
	check(
		pure.reachFor('normal', true, 9, swapped) > pure.reachFor('normal', false, 9, swapped),
		'当前路径是菱形、路径外是方形，让开量却一样',
	)

	// 压缩节点：颜色独立，形状也独立（这里特意设成圆形，就不该再转 45°）
	const packed = pure.dotStyle('compact', true, false, 9, false, skin)
	check(packed.borderColor === '#ff00ff', `压缩节点该用自己的颜色，实际 ${packed.borderColor}`)
	check(!/rotate/.test(packed.transform), '压缩节点被设成圆形了，不该还转 45°')
	check(packed.borderRadius === '50%', `压缩节点设成圆形后该是正圆，实际 ${packed.borderRadius}`)

	// 普通节点设成方形 → 不转，但也不是正圆
	check(!/rotate/.test(off.transform), '方形不该旋转')
	check(off.borderRadius !== '50%', '设成方形了却还是正圆')

	// 菱形仍然要转
	const spun = pure.dotStyle('compact', true, false, 9, false, Object.assign({}, skin, { compactShape: 'diamond' }))
	check(/rotate\(45deg\)/.test(spun.transform), '菱形没转 45°')

	// key 集合：换了主题也必须和默认主题逐字段对齐
	const base = Object.keys(pure.dotStyle('normal', true, false, 9, false)).sort()
	for (const one of [lit, onPath, off, packed, spun]) {
		check(JSON.stringify(Object.keys(one).sort()) === JSON.stringify(base), `自定义主题下 key 集合变了：${JSON.stringify(Object.keys(one).sort())}`)
	}

	// 认不得的值要退回默认，不能把样式弄成 undefined
	const junk = pure.dotStyle('normal', true, false, 9, false, { normalShape: '八边形', currentColor: 'not-a-color' })
	check(junk.borderRadius === '50%', '认不得的形状该退回圆形')
	check(typeof junk.borderColor === 'string' && junk.borderColor.length > 0, '认不得的颜色不该产出空边框')

	// fade() 本身
	check(pure.fade('#58a6ff', 0.5) === 'rgba(88,166,255,0.5)', `fade 算错了：${pure.fade('#58a6ff', 0.5)}`)
	check(pure.fade('nope', 0.5) === 'nope', 'fade 认不出来时该原样返回')
	console.log('  主色联动派生色 / 三个角色各自独立（含当前路径形状）/ key 集合恒定 / 脏值退回默认')
}

console.log('\n用例 13：连线必须在节点边缘停住，不许穿过节点')
{
	// John 报的："很多个圆环中间有个竖线，橙色菱形中间有条蓝的，很奇怪。"
	// 根因：线从父节点圆心画到子节点圆心，而节点填充是半透明的（路径上垫一层淡色），
	// 于是线从节点正中间透出来。改法是两端各让开一个节点的半高。
	const { Z } = pure
	const dot = Z.dot

	// 让开量：圆形是半径，菱形要多让（正方形转 45°，半高是半边长的 √2 倍），且恒大于 0
	const circle = pure.reachFor('normal', false, dot, pure.THEME)
	const diamond = pure.reachFor('compact', false, dot, Object.assign({}, pure.THEME, { compactShape: 'diamond' }))
	const empty = pure.reachFor('empty', false, dot, pure.THEME)
	check(circle > dot / 2, `圆形让开量该超过半径，实际 ${circle}`)
	check(diamond > circle, `菱形该比圆形让得多，实际 ${diamond} vs ${circle}`)
	check(empty > circle, `树根空节点画得大一圈，该让得更多，实际 ${empty}`)
	// 把形状改成圆形，让开量就该降回圆形那档
	check(pure.reachFor('compact', false, dot, Object.assign({}, pure.THEME, { compactShape: 'circle' })) === circle, '压缩节点改成圆形后，让开量该和普通节点一致')

	// 鱼眼淡出的点画得小，线就得多连一截过去。不跟着缩的话，边界那两圈的点
	// 和线之间会各空出一截，看着像"线没接上"
	{
		const eye = pure.fisheye(pure.FADE.rings).scale
		const small = pure.reachFor('normal', false, dot, pure.THEME, eye)
		check(small < circle, `淡出圈的让开量该比正常的小，实际 ${small} vs ${circle}`)
		// 恒大于 0 的保证不能被缩没：让开量为 0 时线会画到圆心，正是用例 13 在防的事
		check(small > 0, `让开量必须恒大于 0，实际 ${small}`)
		check(pure.reachFor('normal', false, dot, pure.THEME, 1) === circle, 'grow=1 该与不传时完全一致')
		check(pure.reachFor('normal', false, dot, pure.THEME, undefined) === circle, 'grow 缺省该退回 1')
		// 空节点那 +2 的"画大一圈"也得跟着缩，否则淡出圈的根节点会多让 2px
		const smallEmpty = pure.reachFor('empty', false, dot, pure.THEME, eye)
		check(Math.abs(smallEmpty - small - ((empty - circle) * eye)) < 1e-9, `空节点的加宽没跟着鱼眼缩：${smallEmpty} vs ${small + (empty - circle) * eye}`)
	}

	/** 某个 y 落在哪一段线上（用来判断线有没有压到节点身上）。 */
	const covers = (parts, x, y) =>
		parts.some((part) => x >= part.left && x <= part.left + part.width && y >= part.top && y <= part.top + part.height)

	// 直上直下：父在 (100,0)、子在 (100,40)，两端各让开 circle
	{
		const parts = pure.segments(100, 100, 0, 40, circle, circle)
		check(!covers(parts, 100, 0), '竖线压在父节点圆心上了')
		check(!covers(parts, 100, 40), '竖线压在子节点圆心上了')
		check(covers(parts, 100, 20), '两个节点中间反而没线了')
		check(parts.every((part) => part.tag === 'v'), '同一列不该冒出横段')
	}

	// 拐弯：父在 (100,0)、子在 (72,40) —— 先横后竖
	{
		const parts = pure.segments(100, 72, 0, 40, circle, circle)
		check(!covers(parts, 100, 0), '横段压在父节点圆心上了')
		check(!covers(parts, 72, 40), '竖段压在子节点圆心上了')
		check(covers(parts, 86, 0), '横段该走在父节点那一行')
		check(covers(parts, 72, 20), '竖段该走在子节点那一列')
		// 先横后竖：折角必须在父节点那一行，不能在子节点那一行
		check(!covers(parts, 100, 39), '画成先竖后横了 —— 竖线会一路压过中间的节点再拐弯')
	}

	// 行距被压得很扁时，让开量超过间距 → 干脆不画，不能画出负长度或反向的段
	{
		const parts = pure.segments(100, 100, 0, 6, circle, circle)
		check(
			parts.every((part) => part.width > 0 && part.height > 0),
			`行距被压扁时冒出了非正尺寸的段：${JSON.stringify(parts)}`,
		)
	}
	// 线要和节点**左右对称**：1px 的线占 [x, x+1)，中心在 x+0.5，而点的中心在 x。
	// 不把线往左挪半像素，线性的树看着就是"一段线一个点"整体偏右（John 报的）。
	{
		const straight = pure.segments(100, 100, 0, 40, circle, circle)[0]
		check(straight.left + straight.width / 2 === 100, `竖线没和节点对中：中心 ${straight.left + straight.width / 2}，节点在 100`)
		const bent = pure.segments(100, 72, 0, 40, circle, circle)
		const hz = bent.find((part) => part.tag === 'hz')
		const v = bent.find((part) => part.tag === 'v')
		check(hz.top + hz.height / 2 === 0, `横段没和父节点那一行对中：中心 ${hz.top + hz.height / 2}`)
		check(v.left + v.width / 2 === 72, `拐弯后的竖线没和子节点对中：中心 ${v.left + v.width / 2}`)
		// 折角要严丝合缝：横段得盖住竖线的整个笔画宽度，否则拐角上缺个小口
		check(hz.left <= v.left && hz.left + hz.width >= v.left + v.width, `折角缺口：横段 ${hz.left}..${hz.left + hz.width}，竖线 ${v.left}..${v.left + v.width}`)
	}

	console.log(`  让开量 圆${circle} / 菱${diamond.toFixed(1)} / 空${empty}；直线与折线两端都不压节点；笔画与节点对中`)
}

console.log('\n用例 14：倒三角、自定义字符、自定义图片')
{
	// 压缩节点默认改成倒三角。John 报的：三角"质感和其他图案不一样，其他都是一个边框
	// 没填充的，就倒三角是有填充的，还明显暗一点"，而且"感觉小了点"。
	const shapeField = pure.FIELDS.find((one) => one.field === 'compactShape')
	check(pure.THEME.compactShape === 'triangle', `压缩节点默认该是三角，实际 ${pure.THEME.compactShape}`)

	const tri = pure.shapeSpec('triangle')
	check(Array.isArray(tri.poly) && tri.poly.length === 3, '三角该是个多边形')
	// 尖朝下：最低的那个顶点只有一个，且在水平居中处
	const lowest = tri.poly.slice().sort((a, b) => b[1] - a[1])[0]
	check(lowest[0] === 0.5, `倒三角的尖该在正中间，实际 x=${lowest[0]}`)
	check(tri.poly.filter(([, y]) => y === lowest[1]).length === 1, '倒三角该只有一个最低点（尖朝下）')

	// ① 质感：描边和填充必须**和别的形状同一套**，不能自己另算一份
	const skin = pure.inkOf('compact', true, false)
	check(skin.ink === pure.THEME.compactColor, `三角的描边色该就是压缩节点色，实际 ${skin.ink}`)
	check(skin.fill !== skin.ink, '三角被整块填实了 —— 别的形状都是描边 + 淡填充')
	const circleSkin = pure.inkOf('normal', true, false)
	const circleStyle = pure.dotStyle('normal', true, false, 9, false)
	check(circleStyle.background === circleSkin.fill && circleStyle.borderColor === circleSkin.ink, '方框类形状没走 inkOf，和多边形必然对不齐')
	// polygon 上挂的属性也得用同一套：描边 = ink、填充 = fill、线宽 = 同尺寸下的边框宽
	const drawn = pure.polyProps(tri, 9, skin, 1.5)
	check(drawn.stroke === skin.ink, `三角的描边该是 ${skin.ink}，实际 ${drawn.stroke}`)
	check(drawn.fill === skin.fill, `三角的填充该是 ${skin.fill}，实际 ${drawn.fill}`)
	check(drawn.fill !== drawn.stroke, '三角被填成和描边一样的实色了 —— 摆在一排空心圆里就是另一拨人画的')
	check(drawn.strokeWidth === 1.5, `三角的线宽该和方框边一样，实际 ${drawn.strokeWidth}`)

	// 方框要让位：三角靠里面那个 <svg> 成形，外面再套个框就是"框里画了个三角"
	const packed = pure.dotStyle('compact', true, false, 9, false)
	check(packed.borderWidth === '0px', `多边形不该再套方框边，实际 ${packed.borderWidth}`)
	check(packed.background === 'none', `多边形不该再有方框底色，实际 ${packed.background}`)
	// 外发光也得换：box-shadow 画的是方框的光晕，套在三角外面是个方的光
	const litTri = pure.dotStyle('compact', true, false, 9, true)
	check(litTri.boxShadow === 'none' && /drop-shadow/.test(litTri.filter), `三角的外发光该走 filter，实际 ${litTri.filter} / ${litTri.boxShadow}`)

	// ② 大小：按**面积**配齐，不是按边长。底 1 高 0.87 的三角只占单位框的 0.435，
	//    而正圆占 π/4 ≈ 0.785 —— 不放大的话摆在一排圆里就是明显小一号。
	const width = Math.max(...tri.poly.map(([x]) => x)) - Math.min(...tri.poly.map(([x]) => x))
	const high = Math.max(...tri.poly.map(([, y]) => y)) - Math.min(...tri.poly.map(([, y]) => y))
	const grown = pure.shapeBox(tri, 9) / 9
	const area = ((width * high) / 2) * grown * grown
	check(Math.abs(area - Math.PI / 4) < 0.05, `三角和正圆的面积该看齐，实际 ${area.toFixed(3)} vs ${(Math.PI / 4).toFixed(3)}`)
	check(grown > 1, '三角没放大，会比同尺寸的圆小一圈')
	// 让开量得跟着实际画多大走，不然放大后的尖角会戳到线上
	check(
		pure.reachFor('compact', true, 9, pure.THEME) > pure.reachFor('compact', true, 9, Object.assign({}, pure.THEME, { compactShape: 'circle' })),
		'三角放大了，连线却按圆的尺寸让位 —— 尖角会压到线上',
	)

	// 顶点换算：要往里缩半条描边，否则外侧半条会被画布边缘切掉
	const points = pure.polyPoints(tri.poly, 20, 1).split(' ').map((one) => one.split(',').map(Number))
	check(points.every(([x, y]) => x >= 1 && x <= 19 && y >= 1 && y <= 19), `顶点顶到画布边上了：${JSON.stringify(points)}`)

	// ③ 自定义字符
	check(shapeField.accept('char:★'), 'char:★ 该是合法形状')
	check(shapeField.accept('char:🌟'), 'emoji 也该收（代理对算一个字）')
	check(!shapeField.accept('char:'), '空的自定义值不该算数')
	check(!shapeField.accept('char:一二三'), '塞一串字进去不该算数')
	check(!shapeField.accept('八边形'), '认不得的预设名不该算数')
	check(pure.shapeSpec('char:★').glyph === '★', '自定义形状没把字取出来')
	check(pure.shapeSpec('char:一二三').value === 'circle', '超长的自定义值该退回圆形')

	const starred = pure.dotStyle('normal', true, false, 9, false, Object.assign({}, pure.THEME, { currentShape: 'char:★' }))
	check(starred.background === 'none', '画成字的节点不该再有底色')
	check(starred.borderWidth === '0px', '画成字的节点不该再描边')
	check(starred.color === pure.inkOf('normal', true, false).ink, '字的颜色该和描边色一致')

	// ④ 自定义图片。id 是内容哈希，要直接拼进 URL 和文件名 —— 认宽了就是路径穿越
	const id = 'a'.repeat(32)
	check(shapeField.accept(`img:${id}`), 'img:<32位哈希> 该是合法形状')
	check(!shapeField.accept('img:../../etc/passwd'), '路径穿越的 id 必须拒掉')
	check(!shapeField.accept('img:ABCDEF'), '长度对不上的 id 不该算数')
	check(!shapeField.accept(`img:${'g'.repeat(32)}`), '非十六进制的 id 不该算数')
	check(pure.shapeSpec(`img:${id}`).image === id, '图片形状没把 id 取出来')
	check(pure.shapeSpec('img:../x').value === 'circle', '认不得的图片 id 该退回圆形')

	const pictured = pure.dotStyle('normal', true, false, 9, false, Object.assign({}, pure.THEME, { currentShape: `img:${id}` }))
	check(pictured.background.includes(id) && /contain/.test(pictured.background), `图片节点该用 contain 铺底，实际 ${pictured.background}`)
	check(pictured.borderWidth === '0px', '图片节点不该再套方框边')
	// 存多大要够屏幕上最大的那个点：直径 × 最大缩放 × 悬停放大 × 二倍屏
	const biggest = pure.Z.dot * (pure.SCALE.max / 100) * 1.4 * 2
	check(pure.ICON_EDGE >= biggest, `图存成 ${pure.ICON_EDGE}px，但最大能画到 ${biggest.toFixed(0)}px —— 放大后会糊`)
	check(pure.ICON_EDGE <= 4 * biggest, `图存成 ${pure.ICON_EDGE}px，比用得上的 ${biggest.toFixed(0)}px 大太多了`)

	// key 集合仍然恒定 —— 三角 / 字 / 图 / 圆都得逐字段对齐
	const base = Object.keys(pure.dotStyle('normal', true, false, 9, false)).sort()
	for (const one of [packed, litTri, starred, pictured]) {
		check(JSON.stringify(Object.keys(one).sort()) === JSON.stringify(base), `key 集合变了：${JSON.stringify(Object.keys(one).sort())}`)
	}
	console.log(`  三角描边填充与圆同源、面积配齐（放大 ${grown} 倍）/ char:<字> 与 img:<哈希> 的合法性 / key 集合恒定`)
}

console.log('\n用例 15：空节点也归自己管')
{
	// John：“空结点长什么样应该也可以设置呀。”
	// 空节点 = 树根那个“新对话”占位。它以前蹭普通/当前路径的颜色和形状，设置里够不着。
	const skin = {
		normalColor: '#111111', normalShape: 'square',
		currentColor: '#222222', currentShape: 'rounded',
		compactColor: '#333333', compactShape: 'triangle',
		emptyColor: '#444444', emptyShape: 'diamond',
	}

	// ① 颜色和形状都走自己那一份
	check(pure.shapeOf('empty', false, skin).value === 'diamond', '空节点没用 emptyShape')
	check(pure.inkOf('empty', false, false, skin).ink === '#444444', '空节点没用 emptyColor')

	// ② 而且**不跟着在不在当前路径上变**。空节点永远是树根、永远在当前路径上，
	//    要是还按 active 切色，那 emptyColor 就只在某些时候生效，等于半个死设置。
	for (const active of [true, false]) {
		check(pure.inkOf('empty', active, false, skin).ink === '#444444', `active=${active} 时空节点的颜色跑了`)
		check(pure.shapeOf('empty', active, skin).value === 'diamond', `active=${active} 时空节点的形状跑了`)
	}
	// 反过来：普通节点该跟着 active 切，别把这条一起改没了
	check(pure.shapeOf('normal', true, skin).value === 'rounded' && pure.shapeOf('normal', false, skin).value === 'square', '普通节点不跟着当前路径切形状了')

	// ③ 四个角色配成四样，就得画出四样来
	const face = (kind, active) => {
		const style = pure.dotStyle(kind, active, false, 11, false, skin)
		return `${pure.shapeOf(kind, active, skin).value}|${pure.inkOf(kind, active, false, skin).ink}|${style.borderStyle}`
	}
	const faces = [face('normal', false), face('normal', true), face('compact', false), face('empty', false)]
	check(new Set(faces).size === 4, `四个角色配成四样却画重了：${JSON.stringify(faces)}`)

	// ④ 虚线边是空节点自己的记号，不跟着配置走 —— 那是“还没说话”的意思
	for (const value of ['circle', 'square', 'char:★', 'img:' + 'a'.repeat(32)]) {
		const style = pure.dotStyle('empty', true, false, 11, false, Object.assign({}, skin, { emptyShape: value }))
		check(style.borderStyle === 'dashed', `空节点配成 ${value} 之后虚线边没了`)
	}
	for (const kind of ['normal', 'compact']) {
		check(pure.dotStyle(kind, true, false, 11, false, skin).borderStyle === 'solid', `${kind} 不该是虚线`)
	}
	// 多边形的边画在 <svg> 上，虚线得自己描
	const dashed = pure.polyProps(pure.shapeSpec('triangle'), 11, pure.inkOf('empty', true, false, skin), 1.5, true)
	const solid = pure.polyProps(pure.shapeSpec('triangle'), 11, pure.inkOf('empty', true, false, skin), 1.5, false)
	check(dashed.strokeDasharray !== 'none' && solid.strokeDasharray === 'none', `多边形的虚线没描上：${dashed.strokeDasharray} / ${solid.strokeDasharray}`)

	// ⑤ 结构不变式：THEME 里每一个角色都得在设置里露面。
	//    以后再加角色时，光改 THEME 不加设置项会直接炸在这里。
	const inFields = new Set(pure.FIELDS.map((one) => one.field))
	for (const key of Object.keys(pure.THEME)) check(inFields.has(key), `THEME 有 ${key}，设置里却没有这一项`)
	const inRows = new Set(pure.ROWS.flatMap((one) => [one.color, one.shape]))
	for (const key of Object.keys(pure.THEME)) check(inRows.has(key), `设置卡上没有 ${key} 这一行`)
	check(pure.ROWS.length === Object.keys(pure.THEME).length / 2, `角色数对不上：${pure.ROWS.length} 行 vs ${Object.keys(pure.THEME).length / 2} 个角色`)

	// key 集合照旧
	const base = Object.keys(pure.dotStyle('normal', true, false, 11, false)).sort()
	for (const kind of ['normal', 'compact', 'empty']) {
		const keys = Object.keys(pure.dotStyle(kind, true, false, 11, false, skin)).sort()
		check(JSON.stringify(keys) === JSON.stringify(base), `${kind} 的 key 集合变了`)
	}
	console.log(`  空节点独立配色配形、不随路径变、虚线边恒定；${pure.ROWS.length} 个角色全在设置里露面`)
}

report()
