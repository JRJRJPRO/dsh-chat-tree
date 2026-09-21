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
	check(!shapeField.accept('八边形'), '认不得的预设名不该算数')
	check(pure.shapeSpec('char:★').glyph === '★', '自定义形状没把字取出来')

	// 上限是 GLYPH_MAX（5 个**码点**），输入框和渲染共用同一份 —— 以前输入框写 4、
	// shapeSpec 只认 2，于是打到第 3 个字时框里有字、树上却悄悄退回默认。
	const full = '一二三四五'
	check([...full].length === pure.GLYPH_MAX, '这条用例按 GLYPH_MAX 写的，上限改了就该改它')
	check(shapeField.accept(`char:${full}`), `正好 ${pure.GLYPH_MAX} 个字该收`)
	check(pure.shapeSpec(`char:${full}`).glyph === full, `正好 ${pure.GLYPH_MAX} 个字该照原样画出来`)
	check(!shapeField.accept(`char:${full}六`), `超过 ${pure.GLYPH_MAX} 个不该算数`)
	check(pure.shapeSpec(`char:${full}六`).value === 'circle', '超长的自定义值该退回圆形')
	// 裁的那一手按码点算：emoji 的 .length 是 2，按它算一个 emoji 就吃掉两格配额
	check(pure.clampGlyph('🙂🙂🙂🙂🙂🙂') === '🙂🙂🙂🙂🙂', '裁字该按码点数，不是 .length')
	check(pure.clampGlyph('一二三') === '一二三', '没超上限的不该被动')
	check(pure.clampGlyph('') === '' && pure.clampGlyph(undefined) === '', '空值不该炸')

	// 字是横着摊开的：宽度跟着字数长，高度永远只有一个字高。
	// 列距按宽度留（否则隔壁列被糊住），连线让位按高度留（否则上下凭空空两倍）。
	const one = pure.shapeSpec('char:甲')
	const three = pure.shapeSpec('char:甲乙丙')
	check(pure.drawnWidth(three, 10) > pure.drawnWidth(one, 10), '三个字该比一个字宽')
	check(pure.shapeHeight(three, 10) === pure.shapeHeight(one, 10), '不管几个字，高度都只有一个字高')
	check(pure.drawnWidth(pure.shapeSpec(`char:${full}`), 10) === 10 * pure.GLYPH_SPAN,
		`宽度该封顶在 ${pure.GLYPH_SPAN} 倍，不然一个 5 字标签能把整棵树的列距撑开`)
	// 字号跟着字数缩，好让这几个字正好填满那个封顶的宽度
	check(pure.glyphFont('甲', 10) === 10, '一个字该用满字号')
	check(pure.glyphFont('甲乙', 10) === 10, '两个字宽度也跟着翻倍，字号不用缩')
	check(pure.glyphFont(full, 10) < pure.glyphFont('甲乙丙', 10), '宽度封顶之后，字数越多字号越小')
	check(pure.glyphFont(full, 10) * [...full].length <= 10 * pure.GLYPH_SPAN + 1e-9, '五个字合起来不该超出封顶宽度')

	// ⑤ 收藏的颜色：默认那个黄，改过的按点走
	const gold = pure.starSkin(true, true)
	const red = pure.starSkin(true, true, undefined, '#F85149')
	check(gold.fill === pure.STAR_COLOR, '没改过颜色的收藏，星身该还是那个黄')
	check(red.fill === '#f85149', `改过颜色的收藏，星身该用他挑的那个（大小写要归一），实际 ${red.fill}`)
	// ⚠️ 这个字符串直接进 CSS，认宽了就是个注入口子
	for (const bad of ['red', '#fff', 'url(javascript:1)', '#12345g', '', undefined, null, 123]) {
		check(pure.starSkin(true, true, undefined, bad).fill === pure.STAR_COLOR, `认不得的颜色「${String(bad)}」该退回默认的黄`)
	}
	check(pure.starSkin(true, false).ink !== pure.STAR_COLOR, '亮色模式下描边该被压深')
	check(pure.starSkin(true, false).fill === pure.STAR_COLOR, '星身不该跟着明暗变 —— 变的只有描边')
	// 用户自己挑的颜色**也过 fitContrast** —— 挑一个亮绿，白底上同样看不清
	check(pure.contrastRatio(pure.starSkin(true, true, undefined, '#56d364').ink, '#56d364') >= pure.STAR_EDGE - 0.05,
		'深底上描边也得比星身深一档，不然星星是块没轮廓的色斑')
	check(pure.contrastRatio(pure.starSkin(true, false, undefined, '#56d364').ink, '#ffffff') >= pure.CONTRAST_MIN - 1e-9,
		'用户挑的颜色在亮色下也该被压到够对比度')
	check(pure.starSkin(true, false, undefined, '#56d364').fill === '#56d364', '星身该是他挑的原色，不是压深过的')
	// 存盘那一层：改过的才进字典，恢复默认是**删掉**而不是存一个黄
	check(pure.nextFavColors({}, 'a:1', '#58A6FF')['a:1'] === '#58a6ff', '存进去该归一成小写')
	check(pure.nextFavColors({ 'a:1': '#58a6ff' }, 'a:1', '')['a:1'] === undefined, '恢复默认该把这一条删掉，而不是存一个默认色')
	check(pure.nextFavColors({ 'a:1': '#58a6ff' }, 'a:1', '红')['a:1'] === undefined, '认不得的值等同于恢复默认')
	check(Object.keys(pure.nextFavColors({ 'a:1': '#58a6ff' }, '', '#fff')).length === 1, '空 key 不该改动任何东西')
	const before = { 'a:1': '#58a6ff' }
	pure.nextFavColors(before, 'b:2', '#56d364')
	check(before['b:2'] === undefined, 'nextFavColors 必须是纯函数，不许改原来那张字典')
	// 预设色板：第一格是"恢复默认"，其余都得是合法色值
	check(pure.FAV_COLORS[0] === '', '色板第一格该是恢复默认（空串）')
	check(pure.FAV_COLORS.slice(1).every(pure.isColor), '色板里有认不得的色值')
	check(new Set(pure.FAV_COLORS).size === pure.FAV_COLORS.length, '色板里有重复的颜色')

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


console.log('用例 16：亮色 / 暗色两版')
{
	// 亮度（相对亮度的简化版，够用来分辨"深色/浅色"）
	const lum = (hex) => {
		const value = Number.parseInt(hex.slice(1), 16)
		return (0.2126 * ((value >> 16) & 255) + 0.7152 * ((value >> 8) & 255) + 0.0722 * (value & 255)) / 255
	}
	const roles = ['normalColor', 'currentColor', 'compactColor', 'emptyColor']

	for (const mode of ['light', 'dark']) {
		for (const role of roles) {
			const hex = pure.PALETTE[mode][role]
			check(pure.isHex(hex), `${mode}.${role} 不是合法色值：${hex}`)
		}
	}
	// ⚠️ 两版必须真的不一样。直接把暗色版抄一份当亮色版，是这类"支持亮色模式"
	//    最常见的假动作 —— 编译过、跑得动、看着依然难看。
	const same = roles.filter((role) => pure.PALETTE.light[role] === pure.PALETTE.dark[role])
	check(same.length < roles.length, `亮色版和暗色版一模一样：${same.join(' ')}`)

	// 亮色版要压得住白底，暗色版要在深底上亮得起来
	for (const role of ['currentColor', 'compactColor']) {
		check(lum(pure.PALETTE.light[role]) < 0.62, `亮色版的 ${role} 太浅，白底上会发飘`)
		check(lum(pure.PALETTE.dark[role]) > 0.38, `暗色版的 ${role} 太暗，深底上看不清`)
	}
	// ⚠️ 压缩色在亮色下**别再往深里调**：它是个"黄"，调过头就成了烧焦的棕，
	//    一眼看不出是同一个语义（John 报过一次 #bc4c00 太闷）。
	check(lum(pure.PALETTE.light.compactColor) > 0.45, `亮色版的压缩色太闷（${pure.PALETTE.light.compactColor}），看着不像黄色了`)
	console.log(`  亮暗两版都合法且确实不同；亮色压缩色 ${pure.PALETTE.light.compactColor}（亮度 ${lum(pure.PALETTE.light.compactColor).toFixed(2)}）`)
}

console.log('用例 17：改过的颜色钉死，没改过的跟着明暗走')
{
	const dark = pure.themeFrom({}, {}, true)
	const light = pure.themeFrom({}, {}, false)
	check(dark.currentColor !== light.currentColor, '换明暗时当前路径色没变')
	check(dark.currentColor === pure.paletteOf(true).currentColor, '暗色下没取到暗色版')

	// 用户亲手改过的那一项，换明暗都不许动
	const pinned = pure.themeFrom({ currentColor: '#ff00ff' }, { currentColor: true }, false)
	check(pinned.currentColor === '#ff00ff', `改过的颜色被覆盖了：${pinned.currentColor}`)
	check(pinned.compactColor === pure.paletteOf(false).compactColor, '没改过的那项反而没跟着明暗走')

	// 存了值但没标记成"用户改的"（比如老版本留下的默认值）→ 仍然跟着明暗走
	const stale = pure.themeFrom({ currentColor: '#ff00ff' }, {}, true)
	check(stale.currentColor !== '#ff00ff', '没标 user 的存量值把当前配色盖住了')
	console.log('  换明暗立刻生效；亲手改过的那一项钉死；存量脏值兜住')
}

console.log('用例 18：普通节点在亮色下必须还是"灰圈 + 淡填充"')
{
	// 这就是 John 报的那条：填充写死成深色，暗色下正好隐形（看着像空心圈），
	// 亮色下就成了白底上一个深色实心点，描边反而看不见了。
	// 修法是让填充跟着宿主的主题变量走，所以这里钉的是"它必须是个变量"。
	const skin = pure.inkOf('normal', false, false, pure.themeFrom({}, {}, false))
	check(String(skin.fill).startsWith('var(--'), `普通节点的填充是写死的 ${skin.fill} —— 换到亮色模式就成深色实心点了`)
	check(pure.isHex(skin.ink), `描边色应该是真实色值，实际 ${skin.ink}`)
	check(skin.ink !== skin.fill, '描边和填充同色 —— 那就不是"圈"了')
	console.log(`  填充 = ${skin.fill}（跟宿主主题走），描边 = ${skin.ink}`)
}

console.log('用例 19：收藏 = 黄色五角星，只有走到它那一轮才填实')
{
	const points = pure.starPoly()
	check(points.length === 10, `五角星该有 10 个顶点，实际 ${points.length}`)
	check(points.every(([x, y]) => x >= -0.001 && x <= 1.001 && y >= -0.001 && y <= 1.001), '顶点跑出单位框了，画出来会被裁掉一个角')
	// 外角顶格、内角收进去；两者一样大的话画出来是个正十边形，不是星
	const radius = (i) => Math.hypot(points[i][0] - 0.5, points[i][1] - 0.5)
	check(Math.abs(radius(0) - 0.5) < 0.001, `外角没顶格：${radius(0)}`)
	check(radius(1) < radius(0) * 0.5, `内角收得不够（${radius(1).toFixed(3)} / ${radius(0).toFixed(3)}），看着会是个十边形不是星`)
	// ⚠️ 面积要和圆配齐（和三角同一条规矩）。直接同边长的话，五个角把面积摊开，
	//    星星看着比旁边的圆小一圈 —— 而它恰恰是最该被一眼看见的那个点。
	check(pure.STAR.grow > 1.5 && pure.STAR.grow < 1.85, `星星的 grow 是 ${pure.STAR.grow}，按面积配齐应该在 1.67 上下`)
	check(pure.STAR.poly !== undefined && pure.STAR.poly.length === 10, '星星没带上顶点，会退化成一个方块')

	// ⚠️ 收藏色现在**只有一个**。亮色下那版由 fitContrast 算出来，不再手写第二个色值。
	check(typeof pure.STAR_COLOR === 'string' && pure.isHex(pure.STAR_COLOR), `星星色该是一个合法色值，实际 ${JSON.stringify(pure.STAR_COLOR)}`)
	const chan = Number.parseInt(pure.STAR_COLOR.slice(1), 16)
	check(((chan >> 16) & 255) > (chan & 255) && ((chan >> 8) & 255) > (chan & 255), `${pure.STAR_COLOR} 不像黄色`)

	// ===== 一个色值，两种底色都得能看 =====
	// John 报的：暗色下那个黄挺好，浅色下"特别黑"。老写法是手写两版，
	// 亮色那版压到 #b8860b（亮度 0.27）才够对比度 —— 够是够了，但它已经不像黄了。
	{
		const gold = pure.STAR_COLOR
		// ① 分工：**星身填亮色，描边扛对比度**。所以基色**本来就不该**自己够对比度 ——
		//    它只负责"看着是黄的"。把这个前提钉住，免得哪天有人"顺手"把基色压深。
		check(pure.relLuminance(gold) > 0.6, `基色亮度 ${pure.relLuminance(gold).toFixed(2)} 太低了 —— 它只管填充，该亮`)
		check(pure.contrastRatio(gold, pure.BACKDROP.dark) >= 7, '基色在深底上该一眼就看见')
		const hue = pure.hexToHsl(gold).h
		check(hue > 35 && hue < 55, `色相 ${hue.toFixed(0)}° 不在暖金那一段（35~55）—— 再往上就是发酸的柠檬黄`)

		// ② 描边两条下限都要满足，两种底色各由其中一条说了算
		for (const dark of [true, false]) {
			const skin = pure.starSkin(false, dark)
			const page = dark ? pure.BACKDROP.dark : pure.BACKDROP.light
			check(skin.fill === gold, `${dark ? '暗' : '亮'}色下星身该是基色本身`)
			check(pure.contrastRatio(skin.ink, page) >= pure.CONTRAST_MIN - 0.05,
				`${dark ? '暗' : '亮'}色下描边对底色才 ${pure.contrastRatio(skin.ink, page).toFixed(2)}:1`)
			check(pure.contrastRatio(skin.ink, skin.fill) >= pure.STAR_EDGE - 0.05,
				`${dark ? '暗' : '亮'}色下描边对星身才 ${pure.contrastRatio(skin.ink, skin.fill).toFixed(2)}:1 —— 边描不出来`)
			// 外发光用星身那个亮色，不用压深过的描边色（深色光晕看着像脏了一圈）
			check(skin.accent === gold, `${dark ? '暗' : '亮'}色下外发光该用亮色`)
		}

		// ③ 深底那条**必须由"对星身"说了算**：基色对深底本来就 13:1，
		//    只看"对底色 3:1"的话描边 = 星身，那颗星就是一块没有轮廓的黄斑。
		const onDark = pure.starSkin(false, true)
		check(onDark.ink !== gold, '深底上描边和星身同色了 —— 星星成了没轮廓的色斑')
		check(pure.relLuminance(onDark.ink) < pure.relLuminance(gold), '描边该比星身深')

		// ④ 只动明度：色相和饱和度一个都不许变，不然那就不是"同一个颜色"了
		const lit = pure.starSkin(false, false).ink
		const was = pure.hexToHsl(gold)
		const now = pure.hexToHsl(lit)
		check(Math.abs(was.h - now.h) < 2, `色相被动了：${was.h.toFixed(1)}° → ${now.h.toFixed(1)}°`)
		check(Math.abs(was.s - now.s) < 0.06, `饱和度被动了：${was.s.toFixed(2)} → ${now.s.toFixed(2)}`)
		check(now.l < was.l, '白底上描边该往深里调')

		// ⑤ 压到**刚好够**就停，不许压过头（越压越不像黄）
		const ratio = pure.contrastRatio(lit, pure.BACKDROP.light)
		check(ratio <= pure.CONTRAST_MIN + 0.15, `亮色下压过头了（${ratio.toFixed(2)}:1）`)

		// ⑥ HSL round-trip 不许跑偏，不然上面每一条都建在沙子上
		for (const hex of ['#ffd43b', '#000000', '#ffffff', '#58a6ff', '#7f7f7f']) {
			check(pure.hslToHex(pure.hexToHsl(hex)) === hex, `${hex} 转一圈回来变成了 ${pure.hslToHex(pure.hexToHsl(hex))}`)
		}
		check(pure.fitContrast('红', '#fff', 3) === '红' && pure.relLuminance('红') === 0, '认不得的色值该原样退回')

		// ⑦ 换成任何一个颜色都得站得住 —— 这才是"配色方案"而不是"调对了一个数"。
		//    用户能在设置里改默认色、也能给单个点挑色，所以每一个都要过这两条下限。
		for (const seed of ['#ffd43b', ...pure.FAV_COLORS.slice(1), '#1a1a1a', '#f0f0f0', '#ffffff', '#000000']) {
			for (const dark of [true, false]) {
				const skin = pure.starSkin(false, dark, undefined, seed)
				const page = dark ? pure.BACKDROP.dark : pure.BACKDROP.light
				check(skin.fill === seed.toLowerCase(), `${seed} 的星身被改动了：${skin.fill}`)
				check(pure.contrastRatio(skin.ink, page) >= pure.CONTRAST_MIN - 0.05,
					`${seed} 在${dark ? '暗' : '亮'}色下，描边对底色只有 ${pure.contrastRatio(skin.ink, page).toFixed(2)}:1`)
				check(pure.contrastRatio(skin.ink, skin.fill) >= pure.STAR_EDGE - 0.05,
					`${seed} 在${dark ? '暗' : '亮'}色下，描边对星身只有 ${pure.contrastRatio(skin.ink, skin.fill).toFixed(2)}:1`)
			}
		}
		// ⚠️ 描边优先往**深**里走（浅描边读起来像光晕）。只有深到底也够不着时才让步 ——
		//    近黑色配深底就是那一档：它比底色还深，再深下去只会和底色糊在一起。
		check(pure.relLuminance(pure.starInkOf('#ffd43b', false)) < pure.relLuminance('#ffd43b'), '正常情况下描边该比星身深')
		check(pure.relLuminance(pure.starInkOf('#1a1a1a', true)) > pure.relLuminance('#1a1a1a'), '近黑色配深底时该让步往亮里走')

		console.log(`  一个色 ${gold}（亮度 ${pure.relLuminance(gold).toFixed(2)}、色相 ${hue.toFixed(0)}°）：` +
			`描边 深底 ${onDark.ink} / 白底 ${lit}（${ratio.toFixed(2)}:1）`)
	}

	// ⚠️ "平时空心、走到那一轮才填实"这条**取消了**（原来是 idle.fill 只有 0.12 alpha）。
	//    空心意味着只剩一圈描边，而描边为了对比度必须压深 —— 白底上看到的就是一圈黑线。
	//    现在一律填实，"正看着这一轮"改由外发光表示（dotStyle 里那条 drop-shadow）。
	const idle = pure.starSkin(false, true)
	const here = pure.starSkin(true, true)
	check(idle.fill === here.fill && idle.fill === pure.STAR_COLOR, '收藏的星身该恒为基色，不随"是不是当前点"变')
	check(idle.ink === here.ink, '描边色不该随"是不是当前点"变')
	check(idle.fill !== idle.ink, '星身和描边同色了 —— 星星没有轮廓')
	// 那么当前点靠什么区分？靠 dotStyle 里那条只在 focused 时挂的外发光。
	// 参数顺序：(kind, active, hover, size, focused, theme, alpha, star)
	const lit2 = pure.dotStyle('normal', false, false, 11, true, pure.THEME, 1, here)
	const dim2 = pure.dotStyle('normal', false, false, 11, false, pure.THEME, 1, idle)
	check(lit2.filter !== 'none' && dim2.filter === 'none',
		'当前点的外发光没了 —— 星身不再区分明暗档之后，区分"正看着这一轮"全靠它')
	console.log(`  10 个顶点、grow ${pure.STAR.grow}；星身 ${idle.fill}、描边 ${idle.ink}，当前点靠外发光`)
}

console.log('用例 20：收藏过的点不跟着"路径外"那一档淡下去')
{
	const theme = pure.themeFrom({}, {}, true)
	const star = pure.starSkin(false, true)
	const plain = pure.dotStyle('normal', false, false, 11, false, theme)
	const fancy = pure.dotStyle('normal', false, false, 11, false, theme, undefined, star)
	// 收藏的意思就是"待会儿我要回来找它"，而它多半不在当前路径上。
	// 淡到 0.4 等于白收藏 —— 这一条钉着它。
	check(plain.opacity === 0.4, `普通点在路径外应该是 0.4，实际 ${plain.opacity}`)
	check(fancy.opacity > plain.opacity, `收藏过的点在路径外还是 ${fancy.opacity}，和没收藏一样淡`)
	// 多边形靠里面的 <svg> 成形，外面那个方框必须关掉，否则星星外面套一圈方边
	check(fancy.borderWidth === '0px', `星星外面套了 ${fancy.borderWidth} 的方框`)
	check(fancy.background === 'none', `星星的方框还垫着底色 ${fancy.background}`)
	check(String(fancy.borderColor).includes(star.ink.slice(1)) || fancy.borderColor === star.ink, '星星没用自己的黄')
	// key 集合不许因为多传一个参数就变（React 会把"上一帧有这一帧没有"的属性置空）
	check(JSON.stringify(Object.keys(plain).sort()) === JSON.stringify(Object.keys(fancy).sort()), '带不带 star，dotStyle 的 key 集合必须一样')
	// 线要按星星**实际画多大**让开，不然一收藏，连线就戳进下面那两个角里
	const near = pure.reachFor('normal', true, 11, theme, 1, false)
	const far = pure.reachFor('normal', true, 11, theme, 1, true)
	check(far > near, `星星的让开量 ${far} 没比圆 ${near} 大 —— 连线会戳进角里`)
	console.log(`  路径外 ${plain.opacity} → ${fancy.opacity}；方框关掉；连线让开 ${near} → ${far.toFixed(1)}`)
}

console.log('用例 21：收藏清单存得住、删得掉，且不越改越脏')
{
	const empty = new Set()
	const one = pure.nextFavorites(empty, 'a:1', true)
	check(one.has('a:1') && empty.size === 0, 'nextFavorites 改了传进来的那个集合 —— 纯函数不该有副作用')
	check(pure.nextFavorites(one, 'a:1', false).size === 0, '取消收藏没删掉')
	check(pure.nextFavorites(one, 'a:1', true).size === 1, '同一个点收藏两次变成两条')
	check(pure.nextFavorites(one, '', true).size === 1, '空 key 也被收进去了')

	// 存进去再读出来（test-kit 的 localStorage 是真存得住的）
	pure.writeFavorite('s1:3', true)
	pure.writeFavorite('root', true)
	check(pure.readFavorites().has('s1:3') && pure.readFavorites().has('root'), '存进去读不出来')
	pure.writeFavorite('s1:3', false)
	check(!pure.readFavorites().has('s1:3'), '取消收藏之后还在清单里')
	check(pure.readFavorites().has('root'), '取消一个把别的也带走了')
	console.log('  集合算术无副作用；存盘读盘对得上；取消不误伤别人')
}

console.log('用例 22：中文输入法拼字那一下的回车，不算"确认改名"')
{
	// ⚠️ John 报的那条：双击改名后用微软拼音打字，打两个字母卡片就自己关了。
	//    选词确认按的是空格或回车，而那一下会先派发一个 keydown{key:'Enter'}，
	//    老写法看见 Enter 就收工 —— 名字还没打完就没了。
	check(pure.isComposingKey({ key: 'Enter', nativeEvent: { isComposing: true } }, false) === true, '拼字中途的回车没被识别出来')
	check(pure.isComposingKey({ key: 'Enter', nativeEvent: { isComposing: false } }, false) === false, '真按下的回车被当成拼字了 —— 那就永远存不了')
	// Safari 和几个国产输入法不给 isComposing，只给 composition 事件，所以要兜一层
	check(pure.isComposingKey({ key: 'Enter' }, true) === true, 'compositionstart 记下的状态没起作用')
	check(pure.isComposingKey({ key: 'Enter', isComposing: true }, false) === true, '挂在事件自己身上的 isComposing 没认')
	check(pure.isComposingKey(undefined, false) === false, '没有事件时不该当成拼字')

	// 改没改过：`null` = 没动过文本框，和"改成空串"是两回事
	check(pure.isDirty(null, '旧名字') === false, '没动过就被当成改过了 —— 卡片会一直锁着关不掉')
	check(pure.isDirty('旧名字', '旧名字') === false, '原样敲一遍也算改过')
	check(pure.isDirty(' 旧名字 ', '旧名字') === false, '首尾空格被当成一次修改')
	check(pure.isDirty('', '旧名字') === true, '清空名字（回到默认）是一次真实的修改，不能当没改')
	check(pure.isDirty('新名字', '旧名字') === true, '真改了却没认出来')
	console.log('  拼字中途的 Enter/Esc 全部让给输入法；清空算改、原样不算改')
}

console.log('用例 23：收藏的动画只在被点的那一颗上播，且收藏和取消不是同一条')
{
	check(pure.starAnimation(null, 'a:1') === 'none', '没人被点的时候也在播动画')
	check(pure.starAnimation({ key: 'a:1', on: true }, 'b:2') === 'none', '点了一颗星，别的点跟着一起抖')
	const on = pure.starAnimation({ key: 'a:1', on: true }, 'a:1')
	const off = pure.starAnimation({ key: 'a:1', on: false }, 'a:1')
	check(on.includes(pure.STAR_ANIM.on) && on.includes(String(pure.STAR_ANIM_MS)), `收藏的动画不对：${on}`)
	check(off.includes(pure.STAR_ANIM.off), `取消收藏的动画不对：${off}`)
	// 取消不是把收藏倒放：一个是"转出来"，一个是"缩回去"，倒放看着像卡了一帧
	check(pure.STAR_ANIM.on !== pure.STAR_ANIM.off, '收藏和取消用了同一条关键帧')
	console.log(`  只认被点的那个 key；收藏 ${pure.STAR_ANIM.on} / 取消 ${pure.STAR_ANIM.off}，${pure.STAR_ANIM_MS}ms`)
}

console.log('用例 24：新加的形状 —— grow 一律算出来，且不许有两个同名')
{
	// ⚠️ 这一整条是给"图形库"加料时的护栏。以前 grow 是注释里算一遍、代码里抄一个
	//    两位小数，加错的那个"看着小一圈"没有任何断言会响。
	const ids = pure.SHAPES.map((one) => one.value)
	check(new Set(ids).size === ids.length, `SHAPES 里有重名：${ids.join(',')}`)
	check(ids.length >= 10, `预设形状只有 ${ids.length} 个，这张表本来就是拿来加的`)
	// 五角星是"收藏"的专属记号，混进 SHAPES 就会出现在四个角色的选择器里，
	// 于是"一眼看出哪个是收藏"当场失效
	check(!ids.includes('star'), 'star 混进 SHAPES 了 —— 它是收藏的专属记号')

	// 每个形状都得能被 shapeSpec 解回自己，否则设置里选了也存不住（isShape 那关过不去）
	for (const one of pure.SHAPES) {
		check(pure.shapeSpec(one.value).value === one.value, `shapeSpec 认不得 ${one.value}，设置里选了会退回圆`)
	}

	// 面积配齐：每个多边形按自己的 grow 画出来，面积都该落在正圆附近
	for (const one of pure.SHAPES) {
		if (one.poly === undefined) continue
		const area = pure.polyArea(one.poly) * one.grow * one.grow
		check(Math.abs(area - Math.PI / 4) < 0.02, `${one.value} 和正圆的面积没配齐：${area.toFixed(3)} vs ${(Math.PI / 4).toFixed(3)}`)
		// ⚠️ 这一条是上面那条抓不住的：自交图形的净面积会抵成浮点残渣（1.6e-17），
		//    配齐检查照样通过（残渣 × 天文数字的 grow 正好等于 π/4），可那个点会占满屏幕。
		//    沙漏第一版就是这么写的，grow 实测 2.4 亿倍。
		check(pure.polyArea(one.poly) > 0.05, `${one.value} 的顶点自交了 —— 面积抵成 ${pure.polyArea(one.poly)}，grow 会除出天文数字`)
		check(one.grow < 3, `${one.value} 的 grow 是 ${one.grow}，这不可能是个正常形状`)
	}

	// 鞋带公式本身
	check(Math.abs(pure.polyArea([[0, 0], [1, 0], [1, 1], [0, 1]]) - 1) < 1e-9, '单位正方形的面积不是 1')
	check(Math.abs(pure.polyArea([[0, 0], [1, 0], [0.5, 1]]) - 0.5) < 1e-9, '底 1 高 1 的三角面积不是 0.5')
	// 自交四边形：两个三角朝向相反，鞋带公式把它们抵成浮点残渣。
	// `growOf` 必须把这种当退化处理，否则 grow 会除出两亿多倍。
	const crossed = [[0, 0], [1, 0], [0, 1], [1, 1]]
	check(pure.polyArea(crossed) < 1e-6, '自交四边形的净面积居然不是 0 —— 那这条护栏的前提就变了')
	check(pure.growOf(crossed) === 1, '自交四边形没被当成退化 —— grow 会除出天文数字，点会占满整块屏')
	check(pure.growOf([[0, 0], [0, 0], [0, 0]]) === 1, '面积为 0 的多边形应该退回 grow=1，而不是除出个 Infinity')

	// 正 n 边形：顶点数对、都在外接圆上、第一个点在正上方
	const hex = pure.regularPoly(6)
	check(hex.length === 6, `六边形给了 ${hex.length} 个顶点`)
	check(hex.every(([x, y]) => Math.abs(Math.hypot(x - 0.5, y - 0.5) - 0.5) < 1e-9), '顶点没落在外接圆上')
	check(Math.abs(hex[0][0] - 0.5) < 1e-9 && hex[0][1] < 0.01, '第一个顶点不在正上方')
	check(pure.regularPoly(2).length === 3, '边数小于 3 时没夹到 3，会画出一条线段')

	// 十字：12 个顶点，臂厚对得上
	const cross = pure.crossPoly(0.4)
	check(cross.length === 12, `十字给了 ${cross.length} 个顶点`)
	check(Math.abs(pure.polyArea(cross) - (2 * 0.4 - 0.4 * 0.4)) < 1e-9, '十字的面积和 2t-t² 对不上')
	check(pure.crossPoly(5).length === 12 && pure.polyArea(pure.crossPoly(5)) < 1, '臂厚超出 0..1 时没夹住')
	console.log(`  ${ids.length} 个预设、无重名、面积逐个配齐正圆；n 边形与十字的顶点算得对`)
}

console.log('用例 25：收藏能换图标，但换不掉那个黄')
{
	// 默认、空、以及认不得的一律退回五角星 —— **不是圆**。
	// `shapeSpec` 认不得时退回的是圆，收藏那条路要是直接用它，
	// 手改一个字就能让一屏收藏全变成普通圆点。
	check(pure.favShape(undefined).value === 'star', '没挑过图标时不是五角星')
	check(pure.favShape('').value === 'star', '空串没退回五角星')
	check(pure.favShape('  ').value === 'star', '全空格没退回五角星')
	check(pure.favShape('star').value === 'star', "显式写 'star' 没认出来")
	check(pure.favShape('没这个形状').value === 'star', '认不得的形状退回了圆 —— 收藏的默认是星不是圆')
	check(pure.favShape('char:').value === 'star', '空的 char: 退回了圆')
	// 挑过的就用挑的那个，三类词汇都要认
	check(pure.favShape('cross').value === 'cross', '预设形状没生效')
	check(pure.favShape('char:🔥').glyph === '🔥', 'emoji 当图标没生效')
	check(pure.favShape(`img:${'a'.repeat(32)}`).image === 'a'.repeat(32), '自己传的图当图标没生效')

	// ===== 卡片上那排选择器：形状和颜色挤在同一行 =====
	{
		// 右箭头 / 五边形 / 六边形在 11px 上和圆几乎没差别，占着格子却提供不了区分度。
		// 而这一排要和颜色挤在同一行里，格子很贵 —— 所以卡片上不列它们。
		// ⚠️ 名字**写死在这儿**，不许写成 `for (const gone of pure.FAV_DROP)` ——
		//    那样把 FAV_DROP 清空，这条用例会跟着一起变成空转，一条都不响。
		for (const gone of ['chevron', 'pentagon', 'hexagon']) {
			check(pure.FAV_DROP.includes(gone), `「${gone}」该在卡片的排除名单里`)
			check(!pure.FAV_SHAPES.includes(gone), `卡片上不该再列「${gone}」`)
			// ⚠️ 设置卡那边**不删**：那儿是给节点配形状的，格子宽松；
			//    而且从 SHAPES 里删掉的话，已经存了 hexagon 的设置读出来就不合法了。
			check(pure.SHAPES.some((one) => one.value === gone), `「${gone}」不该从 SHAPES 里删掉 —— 会让已存的设置失效`)
		}
		check(pure.FAV_SHAPES[0] === 'star', '五角星该排头 —— 它既是默认，也是"恢复默认"那一格')
		check(pure.FAV_SHAPES.length === pure.SHAPES.length - 3 + 1,
			`卡片上该列 ${pure.SHAPES.length - 2} 格（SHAPES 减三个再加五角星），实际 ${pure.FAV_SHAPES.length}`)
		check(new Set(pure.FAV_SHAPES).size === pure.FAV_SHAPES.length, '卡片那排有重复的格子')
		// 每一格都得画得出来。走 favShape 不是 shapeSpec —— 'star' 交给后者会退回圆
		for (const want of pure.FAV_SHAPES) {
			check(pure.favShape(want).value === want, `「${want}」解不出自己，那一格会画成别的形状`)
		}
		// 尺寸：一行里放得下 20 格的前提是格子够小
		check(pure.PICK <= 20 && pure.GAP <= 4, `格子 ${pure.PICK}px / 间距 ${pure.GAP}px 太大，挤不进两行`)
	}

	// 颜色**不跟着形状走**：换了图标还是那个黄，不然"哪个是收藏"当场失效
	const plain = pure.starSkin(false, true)
	const fancy = pure.starSkin(false, true, 'cross')
	check(fancy.ink === plain.ink && fancy.fill === plain.fill, '换了图标连颜色也跟着变了 —— 收藏就不再是一眼能扫出来的记号')
	check(fancy.shape.value === 'cross' && plain.shape.value === 'star', 'starSkin 没把挑的形状带出来')
	check(pure.starSkin(false, false).ink !== pure.STAR_COLOR, '亮色模式下描边没压深 —— 原色对白底只有 1.95:1，看不清')

	// 画出来的点要用挑的那个形状
	const drawn = pure.dotStyle('normal', false, false, 11, false, pure.THEME, 1, fancy)
	check(drawn.background === 'none' && drawn.borderWidth === '0px', '多边形图标该由里面的 svg 画，方框要关掉')
	// 老调用方只给 {accent,ink,fill}、不给 shape 的，得退回五角星而不是崩掉
	const legacy = pure.dotStyle('normal', false, false, 11, false, pure.THEME, 1, { accent: '#e3b341', ink: '#e3b341', fill: 'none' })
	check(legacy.borderWidth === '0px', '没带 shape 的旧写法没退回五角星')

	// 连线让位要按**挑的那个形状**算，不能一律按五角星（1.67 倍）
	const star = pure.reachFor('normal', false, 11, pure.THEME, 1, true)
	const cross = pure.reachFor('normal', false, 11, pure.THEME, 1, pure.favShape('cross'))
	check(star > cross, `五角星比十字大一圈，让位量却是 ${star} vs ${cross}`)
	check(pure.reachFor('normal', false, 11, pure.THEME, 1, false) === pure.reachFor('normal', false, 11, pure.THEME, 1), 'false 应该和不传一样（没收藏）')
	console.log(`  三类图标都认、认不得退回星；颜色钉死；让位量跟着实际形状（星 ${star.toFixed(1)} / 十字 ${cross.toFixed(1)}）`)
}

console.log('用例 26：收藏图标存得住，取消收藏不把它一起抹掉')
{
	const one = pure.nextFavIcons({}, 'a:1', 'cross')
	check(one['a:1'] === 'cross', '挑了图标没记下来')
	check(Object.keys(pure.nextFavIcons({}, 'a:1', 'cross')).length === 1, '纯函数改了传进来的那个字典')
	// 恢复默认 = **删掉这一条**，不是存一个 'star'：存进去的话，哪天默认记号换了样子，
	// 所有"没改过"的点会被这条陈年记录钉在旧样子上
	check(pure.nextFavIcons(one, 'a:1', '')['a:1'] === undefined, '恢复默认没把那一条删掉')
	check(pure.nextFavIcons(one, 'a:1', 'star')['a:1'] === undefined, "挑回 'star' 时该删掉这一条，而不是存进去")
	check(pure.nextFavIcons(one, '', 'cross')['']  === undefined, '空 key 被收进去了')

	pure.writeFavIcon('s9:2', 'char:🔥')
	pure.writeFavIcon('root', 'hexagon')
	check(pure.readFavIcons()['s9:2'] === 'char:🔥', '存进去读不出来')
	// 取消收藏**故意不动图标**：再收藏回来还是上次那个，不用重挑一遍
	pure.writeFavorite('s9:2', true)
	pure.writeFavorite('s9:2', false)
	check(pure.readFavIcons()['s9:2'] === 'char:🔥', '取消收藏把挑好的图标也抹掉了')
	pure.writeFavIcon('s9:2', '')
	check(pure.readFavIcons()['s9:2'] === undefined, '恢复默认之后还留在字典里')
	check(pure.readFavIcons().root === 'hexagon', '删一个把别的也带走了')
	console.log('  字典算术无副作用；恢复默认是删而不是存 star；取消收藏不误伤图标')
}

report()
