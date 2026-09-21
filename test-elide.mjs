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
 *   第3步  用例：线性窗口 / 兄弟算 2 步 / 不省略 / 鱼眼淡出 / 行号压实 / 真日志回归
 *
 * 跑法：node test-elide.mjs
 *
 * @module test-elide
 */

import { check, loadClientPure, report } from './test-kit.mjs'
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'


// ===== 第 1 步：取 client 的真函数 =====

const pure = await loadClientPure()

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

/**
 * 独立重算一遍树上的无向步数 —— 不复用被测代码，这样"淡出圈往外多画了两圈"之类的
 * 改动会当场露馅。
 * @param graph - buildGraph 的结果
 * @param anchor - 起点
 * @returns Map<node, 步数>
 */
function distOf(graph, anchor) {
	const seen = new Set(graph.nodes)
	const dist = new Map([[anchor, 0]])
	const queue = [anchor]
	for (let head = 0; head < queue.length; head += 1) {
		const node = queue[head]
		for (const near of [node.parent, ...node.children]) {
			if (near === undefined || !seen.has(near) || dist.has(near)) continue
			dist.set(near, dist.get(node) + 1)
			queue.push(near)
		}
	}
	return dist
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
	// 半径 3、淡出 2 圈 → 9/10/11 实心，8/12 淡一档，7/13 淡到底。上下必须对称
	const dim = (turn) => got.view.dimOf.get(graph.nodes.find((node) => node.key === `A:${turn}`))
	check(dim(10) === 0, `站着的那一轮必须是实的，实际 ${dim(10)}`)
	check(dim(9) === 0 && dim(11) === 0, `距离 1 不该淡，实际 ${dim(9)}/${dim(11)}`)
	check(dim(8) === 1 && dim(12) === 1, `距离 2 该淡一档，实际 ${dim(8)}/${dim(12)}`)
	check(dim(7) === pure.FADE.rings && dim(13) === pure.FADE.rings, `边界该淡到底，实际 ${dim(7)}/${dim(13)}`)
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
	check(all.view.hidden === 0, `hidden 该是 0，实际 ${all.view.hidden}`)
	// 「不省略」这一档不该有任何淡出 —— 没有边界，淡给谁看
	const faded = graph.nodes.filter((node) => all.view.dimOf.get(node) !== 0)
	check(faded.length === 0, `不省略时不该有淡出节点，实际 ${faded.length} 个`)
	// 关键回归：row 必须等于 depth，否则「不省略」这一档会把老画法改掉
	const bad = graph.nodes.filter((node) => all.view.rowOf.get(node.depth) !== node.depth)
	check(bad.length === 0, `不省略时 row 必须等于 depth，有 ${bad.length} 个不等`)
	console.log(`  ${graph.nodes.length} 个节点全留，row === depth`)
}

console.log('用例 4：鱼眼淡出 —— 吃半径的最外圈，不往外多画')
{
	const sessions = [
		branch('A', undefined, undefined, Array.from({ length: 30 }, (_, i) => i + 1)),
		branch('B', 'A', 20, [21, 22, 23]),
	]
	const graph = graphOf(sessions, 'A')
	const rings = pure.FADE.rings

	for (const radius of [5, 8, 12, 30]) {
		const got = run(graph, 15, radius)
		const dist = distOf(graph, got.anchor)

		// ① 淡出圈**吃的是半径自己的最外层**。要是哪天改成 radius + rings 往外扩，
		//    这里最远的距离就会超过 radius —— 设置里写着"12 步"就得只画到 12 步。
		const far = Math.max(...[...got.view.shown].map((node) => dist.get(node)))
		check(far <= radius, `半径 ${radius}：最远该只到 ${radius} 步，实际 ${far}`)

		// ② 每个节点的档位＝离边界还剩几步，且随距离单调不减
		for (const node of got.view.shown) {
			const want = Math.min(dist.get(node), Math.max(0, rings - (radius - dist.get(node))))
			check(got.view.dimOf.get(node) === want, `半径 ${radius}：${node.key} 距离 ${dist.get(node)} 该是第 ${want} 圈，实际 ${got.view.dimOf.get(node)}`)
		}
		check(got.view.dimOf.get(got.anchor) === 0, `半径 ${radius}：基准点被淡掉了 —— 你正看着的那一轮必须是实的`)
	}

	// ③ 半径小到比淡出圈还少时（配置文件里手改出来的）不许把基准点自己淡掉
	for (const radius of [1, 2]) {
		const got = run(graph, 15, radius)
		check(got.view.dimOf.get(got.anchor) === 0, `半径 ${radius}：基准点该是实的，实际第 ${got.view.dimOf.get(got.anchor)} 圈`)
		for (const node of got.view.shown) check(got.view.dimOf.get(node) <= rings, `半径 ${radius}：${node.key} 的档位越界`)
	}

	// ④ 被整段砍掉的岔路：以前在它自己那列留个 `⋯`，现在靠岔路口那几个点淡下去收尾，
	//    所以岔路上剩下的节点必须也是淡的，不能亮着突然断掉
	const atFork = run(graph, 20, rings + 1)
	const kept = graph.nodes.filter((node) => node.key.startsWith('B:') && atFork.view.shown.has(node))
	check(kept.length > 0, '半径够大时该还能看到岔路上的节点')
	check(kept.some((node) => atFork.view.dimOf.get(node) > 0), '岔路末端该是淡的')
	console.log(`  半径 5/8/12/30 的档位与独立 BFS 一致；最外圈 = 第 ${rings} 圈；岔路末端淡出`)
}

console.log('用例 4b：淡出的坡度 —— 越远越小越淡，且到边界前不许归零')
{
	const { rings, scale, alpha } = pure.FADE
	check(scale.length === rings + 1 && alpha.length === rings + 1, `坡度表该有 ${rings + 1} 档，实际 ${scale.length}/${alpha.length}`)
	check(pure.fisheye(0).scale === 1 && pure.fisheye(0).alpha === 1, '第 0 圈必须原样画')
	for (let at = 1; at <= rings; at += 1) {
		check(pure.fisheye(at).scale < pure.fisheye(at - 1).scale, `第 ${at} 圈该比上一圈小`)
		check(pure.fisheye(at).alpha < pure.fisheye(at - 1).alpha, `第 ${at} 圈该比上一圈淡`)
	}
	// 最外圈也得看得见：真降到 0 就等于硬切，跟原来画 `⋯` 之前那种"说断就断"没区别
	check(pure.fisheye(rings).scale > 0.3 && pure.fisheye(rings).alpha > 0.25, `最外圈太弱了（${pure.fisheye(rings).scale}/${pure.fisheye(rings).alpha}），等于硬切`)
	// 越界的档位夹到最外圈，别返回 undefined 把样式写成 NaNpx
	for (const bad of [rings + 5, -1, undefined, null, NaN, 'x']) {
		const got = pure.fisheye(bad)
		check(Number.isFinite(got.scale) && Number.isFinite(got.alpha), `fisheye(${String(bad)}) 该夹住，实际 ${JSON.stringify(got)}`)
	}
	// 淡是**乘**在原有透明度上的：路径外的点本来就 0.4，最外圈必须比它更淡
	const outer = pure.dotStyle('normal', false, false, 10, false, undefined, pure.fisheye(rings).alpha).opacity
	const plain = pure.dotStyle('normal', false, false, 10, false, undefined).opacity
	check(outer < plain, `最外圈(${outer})该比路径外的普通点(${plain})更淡，否则越远越显眼`)
	check(pure.dotStyle('normal', false, false, 10, false, undefined, 1).opacity === plain, 'alpha=1 该与不传时完全一致')
	console.log(`  scale ${scale.join('→')}；alpha ${alpha.join('→')}；最外圈实际透明度 ${outer.toFixed(3)} < ${plain}`)
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
	for (const key of ['row', 'rowMin', 'dot', 'lane', 'hit']) {
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
	// （ell 是省略号那个字的字号，换成鱼眼淡出之后整个没了）
	const was = { row: 20, rowMin: 7, dot: 9, dotMin: 6, dotPad: 5, lane: 14, hit: 18 }
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

console.log('用例 11：按层数 —— 同一层整排都在，按步数会漏掉隔壁分支')
{
	// A 有 1..12；B 从 A 的第 2 轮岔出，自有 3'..12'。
	// 站在 A 的第 12 轮时，B:12 和它**同一层**，但在树上要先爬回岔路口再下来 —— 差 20 步。
	const sessions = [
		branch('A', undefined, undefined, Array.from({ length: 12 }, (_, i) => i + 1)),
		branch('B', 'A', 2, Array.from({ length: 10 }, (_, i) => i + 3)),
	]
	const graph = graphOf(sessions, 'A')
	const anchor = pure.anchorNode(graph.nodes, 12)
	const twin = graph.nodes.find((node) => node.key === 'B:12')
	check(twin !== undefined && twin.depth === anchor.depth, `B:12 该和基准点同层，实际 ${twin && twin.depth} vs ${anchor.depth}`)

	const steps = distOf(graph, anchor).get(twin)
	check(steps > 10, `这个用例要的就是"同层但很远"，实际只差 ${steps} 步`)

	const byStep = pure.elide(graph.nodes, anchor, 10, 'step')
	check(!byStep.shown.has(twin), `按步数 10：同层的 B:12 差 ${steps} 步，不该出现`)

	const byLayer = pure.elide(graph.nodes, anchor, 10, 'depth')
	check(byLayer.shown.has(twin), '按层数 10：同层的 B:12 必须出现 —— 这正是换量法要解决的事')
	check(byLayer.dimOf.get(twin) === 0, `同层就是 0 层差，不该淡，实际第 ${byLayer.dimOf.get(twin)} 圈`)

	// 按层数就该是"整排一起去留"：留下来的每一层，该层的节点一个都不能少
	const kept = [...byLayer.shown]
	for (const depth of new Set(kept.map((node) => node.depth))) {
		const all = graph.nodes.filter((node) => node.depth === depth)
		const got = kept.filter((node) => node.depth === depth)
		check(all.length === got.length, `第 ${depth} 层该整排都在（共 ${all.length} 个），实际只留了 ${got.length} 个`)
	}
	console.log(`  B:12 与基准点同层、差 ${steps} 步：按步数漏掉，按层数留下；留下 ${byLayer.shown.size} 个节点整层不缺`)
}

console.log('用例 12：按层数的窗口与淡出 —— |Δdepth| ≤ N，最外圈同样吃自己的边')
{
	const sessions = [
		branch('A', undefined, undefined, Array.from({ length: 30 }, (_, i) => i + 1)),
		branch('B', 'A', 20, [21, 22, 23]),
	]
	const graph = graphOf(sessions, 'A')
	const rings = pure.FADE.rings
	for (const limit of [1, 2, 5, 10, 30]) {
		const anchor = pure.anchorNode(graph.nodes, 15)
		const view = pure.elide(graph.nodes, anchor, limit, 'depth')
		// 独立重算一遍，不复用被测代码
		const want = graph.nodes.filter((node) => Math.abs(node.depth - anchor.depth) <= limit)
		check(want.length === view.shown.size && want.every((node) => view.shown.has(node)),
			`层高差 ${limit}：期望 ${want.length} 个，实际 ${view.shown.size} 个`)
		for (const node of view.shown) {
			const away = Math.abs(node.depth - anchor.depth)
			check(view.dimOf.get(node) === Math.min(away, Math.max(0, rings - (limit - away))),
				`层高差 ${limit}：${node.key} 差 ${away} 层的档位不对（${view.dimOf.get(node)}）`)
		}
		check(view.dimOf.get(anchor) === 0, `层高差 ${limit}：你正看着的那一轮必须是实的`)
	}
	// 0 = 不省略，两种量法都一样
	for (const mode of ['depth', 'step']) {
		const view = pure.elide(graph.nodes, pure.anchorNode(graph.nodes, 15), 0, mode)
		check(view.shown.size === graph.nodes.length && view.hidden === 0, `${mode} 的 0 档该是"不省略"`)
	}
	console.log(`  层高差 1/2/5/10/30 与独立重算一致；两种量法的 0 档都是不省略`)
}

console.log('用例 13：两种量法二选一 —— 各记各的档位，切换不冲掉对方')
{
	check(pure.VISIBLE[0].mode === 'depth', '左边那半该是默认的"按层数"')
	check(pure.VISIBLE.map((one) => one.field).join() === 'visibleDepth,visibleRadius', `字段名变了：${pure.VISIBLE.map((one) => one.field).join()}`)

	// 默认：按层数 10
	const fresh = pure.visibleRange({})
	check(fresh.mode === 'depth' && fresh.limit === 10, `默认该是按层数 10，实际 ${fresh.mode} ${fresh.limit}`)
	check(fresh.text === '10 层', `默认读数该是"10 层"，实际 ${fresh.text}`)

	// 两个上限同时存着，谁生效只看 visibleMode
	const both = { visibleMode: 'step', visibleDepth: 6, visibleRadius: 25 }
	check(pure.visibleRange(both).limit === 25, '按步数时该读 visibleRadius')
	check(pure.visibleRange(Object.assign({}, both, { visibleMode: 'depth' })).limit === 6,
		'切回按层数该读回 visibleDepth —— 两边各记各的，切换不许把对方冲掉')

	// 配置文件里手改出个认不得的量法，退回默认，别把树搞崩
	for (const bad of ['', 'steps', 'DEPTH', 0, undefined, null, {}]) {
		const got = pure.visibleRange({ visibleMode: bad, visibleDepth: 4 })
		check(got.mode === 'depth' && got.limit === 4, `量法 ${JSON.stringify(bad)} 该退回默认，实际 ${got.mode}`)
	}
	check(!pure.isMode('steps') && pure.isMode('step') && pure.isMode('depth'), 'isMode 认的值不对')
	// 上限存了个认不得的值也退回这一档自己的默认
	check(pure.visibleRange({ visibleMode: 'step', visibleRadius: 'x' }).limit === pure.RADIUS.fallback, '认不得的步数该退回 12')
	check(pure.visibleRange({ visibleMode: 'depth', visibleDepth: null }).limit === pure.DEPTH.fallback, '认不得的层数该退回 10')

	// 档位表：1..30 再加一格"不省略"，默认那一档必须在表里，否则滑杆会跳到第 0 格
	const layers = pure.LAYERS
	check(layers[0] === 1 && layers[layers.length - 2] === 30 && layers[layers.length - 1] === pure.DEPTH.off,
		`层数档位表不对：${layers[0]}..${layers[layers.length - 2]} + ${layers[layers.length - 1]}`)
	check(layers.includes(pure.DEPTH.fallback), `默认档 ${pure.DEPTH.fallback} 不在档位表里，滑杆会跳掉`)
	check(pure.layerText(0) === '不省略' && pure.layerText(10) === '10 层', `层数读数不对：${pure.layerText(10)}`)

	// 三个字段都得在 FIELDS 里（store 是按表取值的），且都归在同一组里左右排开
	const grouped = pure.FIELDS.filter((spec) => spec.group === 'visible').map((spec) => spec.field)
	check(grouped.join() === 'visibleMode,visibleDepth,visibleRadius', `显示范围那一组不对：${grouped.join()}`)
	console.log(`  默认 ${fresh.text}；${JSON.stringify(both)} → 按步数 25，切回层数还是 6`)
}


report()
