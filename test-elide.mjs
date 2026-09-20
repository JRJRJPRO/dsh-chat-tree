/**
 * dsh-tree —— 省略规则的合成用例。
 *
 * 【导读】
 * 干嘛的：把「只画离当前这一轮 N 步以内的节点」这条规则钉死。
 * 距离是树上的无向步数：父节点 1 步，父节点的另一个孩子 2 步。
 *
 * 阅读顺序：
 *   第1步  取 client 的真函数
 *   第2步  造树的小工具
 *   第3步  用例：线性窗口 / 兄弟算 2 步 / 不省略 / 省略号位置 / 行号压实 / 真日志回归
 *
 * 跑法：node test-elide.mjs
 *
 * @module test-elide
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

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
 * 捏一条分支（和 test-highlight.mjs 同形）。
 * @param id - 会话 id
 * @param parentId - 父会话 id
 * @param forkTurn - 从父分支第几轮岔出来
 * @param turns - 自有轮次号
 */
function branch(id, parentId, forkTurn, turns) {
	clock += 1
	return {
		id, cwd: '/x', parentId, createdAt: clock, forkTurn,
		turns: turns.map((turn) => ({ turn, seq: turn * 10, time: turn, prompt: `#${turn}`, compact: false, inherited: false })),
	}
}

/**
 * 建图。
 * @param sessions - 分支表
 * @param currentId - 当前会话
 */
function graphOf(sessions, currentId) {
	const visible = new Set(sessions.map((item) => item.id))
	return pure.buildGraph(pure.conversationOf(pure.visibleTree(sessions, visible), currentId), currentId)
}

/**
 * 省略一遍，把留下来的节点按 key 排序列出来。
 * @param graph - buildGraph 的结果
 * @param activeTurn - 现在滑到第几轮
 * @param radius - 半径
 */
function run(graph, activeTurn, radius) {
	const anchor = pure.anchorNode(graph.nodes, activeTurn)
	const view = pure.elide(graph.nodes, anchor, radius)
	return {
		view, anchor,
		keys: [...view.shown].filter((node) => node.entry !== undefined).map((node) => node.key).sort(),
	}
}

// ===== 第 3 步：用例 =====

console.log('用例 1：线性 1..20，站在第 10 轮，半径 3 → 只剩 7..13')
{
	const sessions = [branch('A', undefined, undefined, Array.from({ length: 20 }, (_, i) => i + 1))]
	const graph = graphOf(sessions, 'A')
	const got = run(graph, 10, 3)
	const want = [7, 8, 9, 10, 11, 12, 13].map((t) => `A:${t}`).sort()
	check(JSON.stringify(got.keys) === JSON.stringify(want), `期望 ${JSON.stringify(want)}，实际 ${JSON.stringify(got.keys)}`)
	check(got.anchor.entry.turn === 10, `基准点该是第 10 轮，实际 ${got.anchor.entry && got.anchor.entry.turn}`)
	check(got.view.bandTop.size === 1 && got.view.bandBottom.size === 1, '上下都该有省略号')
	console.log(`  留下 ${got.keys.length} 个：${got.keys.join(' ')}`)
}

console.log('用例 2：父节点的另一个孩子算 2 步')
{
	// A 有 1..6；B 从 A 的第 3 轮岔出，自有 4'..6'
	const sessions = [
		branch('A', undefined, undefined, [1, 2, 3, 4, 5, 6]),
		branch('B', 'A', 3, [4, 5, 6]),
	]
	const graph = graphOf(sessions, 'A')
	// 站在 A 的第 4 轮：它的父亲是 A:3，A:3 的另一个孩子是 B:4 → 距离 2
	const near = run(graph, 4, 2)
	check(near.keys.includes('B:4'), `半径 2 应该看得到兄弟 B:4，实际 ${JSON.stringify(near.keys)}`)
	check(!near.keys.includes('B:5'), `B:5 距离 3，半径 2 不该出现`)
	const tight = run(graph, 4, 1)
	check(!tight.keys.includes('B:4'), `半径 1 不该看到兄弟，实际 ${JSON.stringify(tight.keys)}`)
	console.log(`  半径2 → ${near.keys.join(' ')}`)
	console.log(`  半径1 → ${tight.keys.join(' ')}`)
}

console.log('用例 3：半径 0 = 不省略，且行号与原来完全一致')
{
	const sessions = [
		branch('A', undefined, undefined, [1, 2, 3, 4, 5, 6, 7, 8]),
		branch('B', 'A', 3, [4, 5]),
	]
	const graph = graphOf(sessions, 'A')
	const all = run(graph, 5, 0)
	check(all.view.shown.size === graph.nodes.length, `不省略时该留下全部 ${graph.nodes.length} 个，实际 ${all.view.shown.size}`)
	check(all.view.bandTop.size === 0 && all.view.bandBottom.size === 0, '不省略时不该有省略号')
	check(all.view.hidden === 0, `hidden 该是 0，实际 ${all.view.hidden}`)
	// 关键回归：row 必须等于 depth，否则「不省略」这一档会把老画法改掉
	const bad = graph.nodes.filter((node) => all.view.rowOf.get(node.depth) !== node.depth)
	check(bad.length === 0, `不省略时 row 必须等于 depth，有 ${bad.length} 个不等`)
	console.log(`  ${graph.nodes.length} 个节点全留，row === depth`)
}

console.log('用例 4：省略号画在树被剪断的地方')
{
	const sessions = [
		branch('A', undefined, undefined, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]),
		branch('B', 'A', 8, [9, 10]),
	]
	const graph = graphOf(sessions, 'A')
	// 站在第 2 轮、半径 2 → 只剩根..A:4 一带，上面没东西了，下面被剪断
	const top = run(graph, 2, 2)
	check(top.view.bandTop.size === 0, `最上面没有被剪断的东西，不该有上省略号（实际 ${top.view.bandTop.size}）`)
	check(top.view.bandBottom.size === 1, `下面该有省略号（实际 ${top.view.bandBottom.size}）`)
	// 站在第 9 轮、半径 1 → 上面被剪断
	const bottom = run(graph, 9, 1)
	check(bottom.view.bandTop.size === 1, `上面该有省略号（实际 ${bottom.view.bandTop.size}）`)
	// 岔路被砍掉时，省略号落在那条支线自己的列上
	const atFork = run(graph, 8, 1)
	const forkColumn = graph.nodes.find((node) => node.key === 'B:9').column
	check(atFork.view.bandBottom.has(forkColumn), `被砍掉的岔路该在它自己那列留省略号（列 ${forkColumn}，实际 ${JSON.stringify([...atFork.view.bandBottom])}）`)
	console.log(`  上=${[...top.view.bandTop]} 下=${[...top.view.bandBottom]}；岔路列=${forkColumn}`)
}

console.log('用例 5：行号压实 —— 留下的行必须是 0..n-1 连续')
{
	const sessions = [branch('A', undefined, undefined, Array.from({ length: 30 }, (_, i) => i + 1))]
	const graph = graphOf(sessions, 'A')
	const got = run(graph, 20, 5)
	const rows = [...got.view.shown].map((node) => got.view.rowOf.get(node.depth)).sort((a, b) => a - b)
	const uniq = [...new Set(rows)]
	check(uniq[0] === 0, `第一行该是 0，实际 ${uniq[0]}`)
	check(uniq[uniq.length - 1] === uniq.length - 1, `行号该连续到 ${uniq.length - 1}，实际 ${uniq[uniq.length - 1]}`)
	check(uniq.length === got.view.rows, `rows 该等于去重行数 ${uniq.length}，实际 ${got.view.rows}`)
	console.log(`  ${got.view.shown.size} 个节点压实成 ${got.view.rows} 行`)
}

console.log('用例 6：滑杆档位 —— 5..30 再加一格「不省略」')
{
	const steps = pure.STEPS
	check(steps[0] === 5, `第一档该是 5，实际 ${steps[0]}`)
	check(steps[steps.length - 2] === 30, `倒数第二档该是 30，实际 ${steps[steps.length - 2]}`)
	check(steps[steps.length - 1] === pure.RADIUS.off, `最后一档该是"不省略"(${pure.RADIUS.off})，实际 ${steps[steps.length - 1]}`)
	check(steps.length === 27, `一共该有 27 档，实际 ${steps.length}`)
	console.log(`  ${steps.length} 档：${steps[0]}..${steps[steps.length - 2]} + 不省略`)
}

console.log('用例 7：真实日志回归 —— 任意半径下留下的节点都不多不少')
{
	const home = process.env.DSH_HOME_REAL || process.env.DSH_HOME || join(homedir(), '.dsh')
	const root = join(home, 'sessions')
	if (!existsSync(root)) {
		console.log(`  跳过：找不到 ${root}（设 DSH_HOME_REAL 指向真实 home 再跑）`)
	} else {
		// 直接拿 test.mjs 的产物太绕，这里用合成的宽树代替：3 层岔路
		const sessions = [branch('A', undefined, undefined, [1, 2, 3, 4, 5, 6])]
		sessions.push(branch('B', 'A', 2, [3, 4, 5]))
		sessions.push(branch('C', 'B', 4, [5, 6]))
		sessions.push(branch('D', 'A', 5, [6, 7]))
		const graph = graphOf(sessions, 'C')
		// 逐个半径核对：shown 必须恰好等于 BFS 距离 <= radius 的集合
		const byKey = new Map(graph.nodes.map((node) => [node, node]))
		for (let radius = 1; radius <= 12; radius += 1) {
			const anchor = pure.anchorNode(graph.nodes, undefined)
			const view = pure.elide(graph.nodes, anchor, radius)
			// 独立重算一遍 BFS，不复用被测代码
			const dist = new Map([[anchor, 0]])
			const queue = [anchor]
			while (queue.length > 0) {
				const node = queue.shift()
				for (const near of [node.parent, ...node.children]) {
					if (near === undefined || !byKey.has(near) || dist.has(near)) continue
					dist.set(near, dist.get(node) + 1)
					queue.push(near)
				}
			}
			const want = new Set([...dist.entries()].filter(([, d]) => d <= radius).map(([node]) => node))
			const same = want.size === view.shown.size && [...want].every((node) => view.shown.has(node))
			check(same, `半径 ${radius}：期望 ${want.size} 个，实际 ${view.shown.size} 个`)
		}
		console.log(`  4 条分支 ${graph.nodes.length} 个节点，半径 1..12 全部与独立 BFS 一致`)
	}
}

console.log('用例 8：设置 store —— 第一帧不可写，之后必须能恢复')
{
	// 假的 settingsScope：先给 loading/不可写，再给 ready/可写，模拟真实时序
	let snapshot = { status: 'loading', value: undefined, user: undefined, writable: false, mode: 'host' }
	const radiusOf = (store) => store.getSnapshot().values.visibleRadius
	const fans = new Set()
	const written = []
	const scope = {
		getSnapshot: () => snapshot,
		subscribe: (fn) => {
			fans.add(fn)
			return () => fans.delete(fn)
		},
		set: (field, value) => {
			written.push([field, value])
			return Promise.resolve()
		},
		unset: (field) => {
			written.push([field, 'unset'])
			return Promise.resolve()
		},
	}
	const push = (next) => {
		snapshot = next
		for (const fn of [...fans]) fn()
	}
	const ctx = {
		inject: (_deps, run) => run({ settingsScope: { bind: () => scope }, effect: (make) => make() }),
	}

	const store = pure.settingsStore(ctx)
	check(radiusOf(store) === pure.RADIUS.fallback, `第一帧该退回默认 ${pure.RADIUS.fallback}，实际 ${radiusOf(store)}`)
	check(store.getSnapshot().values.nodeScale === pure.SCALE.fallback, `缩放第一帧该是 ${pure.SCALE.fallback}`)
	check(store.getSnapshot().writable === false, '第一帧该是不可写')

	push({ status: 'ready', value: { visibleRadius: 7, nodeScale: 150 }, user: { visibleRadius: 7 }, writable: true, mode: 'host' })
	const later = store.getSnapshot()
	check(later.values.visibleRadius === 7, `后来该读到 7，实际 ${later.values.visibleRadius}`)
	check(later.values.nodeScale === 150, `缩放该读到 150，实际 ${later.values.nodeScale}`)
	check(later.writable === true, '后来该变成可写 —— 这就是滑杆点不动那个 bug')
	check(later.user.visibleRadius === true, 'user 层里有值就该标"已修改"')
	check(later.user.nodeScale === false, 'user 层里没有的字段不该标"已修改"')
	check(typeof store.set === 'function', 'set 不许在不可写那一帧被删掉')

	store.set('visibleRadius', 12)
	store.set('nodeScale', 80)
	store.reset('nodeScale')
	const want = [['visibleRadius', 12], ['nodeScale', 80], ['nodeScale', 'unset']]
	check(JSON.stringify(written) === JSON.stringify(want), `写入路径不对：${JSON.stringify(written)}`)
	console.log(`  loading→ready 全程 set 健在，写入 ${JSON.stringify(written)}`)
}

console.log('用例 10：缩放 —— 100% 必须与原尺寸逐字段相等，其余等比例')
{
	const Z = pure.Z
	const same = pure.scaleZ(100)
	const bad = Object.keys(Z).filter((key) => same[key] !== Z[key])
	check(bad.length === 0, `scaleZ(100) 必须和 Z 一模一样，不同的字段：${bad.join(',')}`)

	const big = pure.scaleZ(200)
	for (const key of ['row', 'rowMin', 'dot', 'lane', 'hit', 'ell']) {
		check(big[key] === Z[key] * 2, `${key} 在 200% 下该是 ${Z[key] * 2}，实际 ${big[key]}`)
	}
	// 时间和文字卡片宽度不是几何量，不许跟着缩
	check(big.restMs === Z.restMs, 'restMs 是 hover intent 的等待时间，不该被缩放')
	check(big.card === Z.card, 'card 是文字卡片宽度，跟着放大只会挡住聊天区')
	check(pure.scaleZ(undefined).dot === Z.dot && pure.scaleZ(0).dot === Z.dot, '非法百分比该退回 100%')

	// 列间距和命中区必须一起缩放，否则放大后命中区盖不住相邻列 / 缩小后互相抢
	for (const percent of [50, 100, 150, 250]) {
		const z = pure.scaleZ(percent)
		check(Math.abs(z.hit / z.lane - Z.hit / Z.lane) < 1e-9, `${percent}% 时命中区与列距的比例变了`)
	}
	// 基准尺寸整体上调过一次：老基准要调到 120% 才顺眼，就把 120% 挪成了默认的 100%。
	// 钉住这个换算，免得哪天有人"顺手"把 Z 改回去，默认又变小。
	const was = { row: 20, rowMin: 7, dot: 9, dotMin: 6, dotPad: 5, lane: 14, hit: 18, ell: 14 }
	for (const [key, before] of Object.entries(was)) {
		check(Z[key] === Math.round(before * 1.2), `${key} 该是老基准 ${before} 的 1.2 倍取整（${Math.round(before * 1.2)}），实际 ${Z[key]}`)
	}
	console.log(`  100% 逐字段相等；200% 下 dot ${Z.dot}→${big.dot}、lane ${Z.lane}→${big.lane}、hit ${Z.hit}→${big.hit}；基准 = 老基准 ×1.2`)
}

// 用例 11（走廊跟着缩放）已删：走廊那套机制整个被 hover intent 取代了，
// bridgeBox / Z.mouth / Z.bridgeMs 都不存在了。为什么推翻见 DESIGN.md §hover intent。
// 缩放这一面仍有人守着：用例 10 钉住 hit/lane 比例恒定，restMs 不参与缩放。

console.log('用例 9：档位文案')
{
	check(pure.stepText(pure.RADIUS.off) === '不省略', `0 该显示"不省略"，实际 ${pure.stepText(pure.RADIUS.off)}`)
	check(pure.stepText(12) === '12 步', `12 该显示"12 步"，实际 ${pure.stepText(12)}`)
	check(!pure.stepText(12).includes('以内'), '档位读数里不要"以内"两个字')
	// 默认档位：12 步，且必须真的在档位表里 —— 不在的话滑杆会跳到第 0 档
	check(pure.RADIUS.fallback === 12, `默认该是 12 步，实际 ${pure.RADIUS.fallback}`)
	check(pure.STEPS.includes(pure.RADIUS.fallback), `默认档 ${pure.RADIUS.fallback} 不在档位表里，滑杆会跳掉`)
	check(pure.SCALES.includes(pure.SCALE.fallback), `默认缩放 ${pure.SCALE.fallback} 不在档位表里`)
	console.log(`  0 → ${pure.stepText(0)}；12 → ${pure.stepText(12)}；默认 ${pure.stepText(pure.RADIUS.fallback)}`)
}

console.log('')
if (failures === 0) console.log('✓ 全部断言通过')
else {
	console.log(`✗ ${failures} 条断言失败`)
	process.exitCode = 1
}
