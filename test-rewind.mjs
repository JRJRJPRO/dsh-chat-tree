/**
 * dsh-tree —— 撤回（rewind）的用例。
 *
 * 【导读】
 * 干嘛的：John 报的 bug —— 「1-2-3-4，4 发到一半我撤回了，又发了 5，
 * 树上却画成 1-2-3-4-5；可 4 已经不存在了」。
 *
 * 背景（NATIVE-BASELINE.md §4）：dsh-claude 的撤回**不删日志**，只在自己的旁车里
 * 记一组 hidden `ranges`（界面行 seq），前端拿 CSS 把那些行藏起来。所以只折 dsh
 * 日志的话，撤回过的轮次一个不少地还在。
 *
 * 规矩两条：
 *   · 撤回时**答完了**（turn/end 的 reason 是 completed）→ 节点留着，但成一条废弃支线；
 *     后面新发的那轮接回撤回**之前**的那个节点 → 1-2-3-4 和 1-2-3-5 两条。
 *   · 撤回时**没答完**（aborted / interrupted / error / 干脆没有 turn/end）→ 节点不画，
 *     只剩 1-2-3-5。
 *
 * 数据流：旁车 ranges ─┐
 *         dsh 日志 → foldOutline（done / promptSeq）→ markRewound → buildGraph
 *
 * 阅读顺序：
 *   第1步  取两半的真函数
 *   第2步  造数据的小工具
 *   第3步  用例 1-3：host 半（done / promptSeq / 盖戳）
 *   第4步  用例 4-6：client 半（成图）
 *   第5步  用例 7-8：拿盘上真实的撤回过的会话兜一遍 + 旁车读写
 *   第6步  用例 9-10：**读旁车不许打断正在跑的那一轮**（最要命的一条）+ 整条管线
 *   第7步  用例 12-14：宿主原生的就地撤回（surface replace）+ 岔路点按分支自己的眼光算
 *
 * 跑法：node test-rewind.mjs
 *
 * @module test-rewind
 */

import { check, loadClientPure, report } from './test-kit.mjs'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import { foldOutline, __test } from './index.js'

const HOME = process.env.DSH_HOME || 'E:/Programs/deepseek-harness/home'


// ===== 第 1 步：取两半的真函数 =====

const pure = await loadClientPure()

const { markRewound, turnHidden, rewindStateOf, statusProbe, SIDECAR_QUIET_MS, collect, shadowedSeqs, effectiveForkTurn } = __test
const Z = pure.Z

// ===== 第 2 步：造数据的小工具 =====

/**
 * 捏一轮的事件。真实日志里一轮长这样：turn/start → 真人消息 → 宿主注入的
 * runtime-context 快照（source.kind 不是 'user'）→ … → turn/end。
 * @param turn - 轮次号
 * @param from - 这一轮的起始 seq
 * @param reason - turn/end 的 reason；给 null 表示这轮还没结束（没有 turn/end）
 * @returns 事件数组
 */
function turnEvents(turn, from, reason) {
	const events = [
		{ seq: from, type: 'turn/start', time: turn, data: { turn } },
		{ seq: from + 1, type: 'user/message', data: { content: [{ type: 'text', text: `问题 ${turn}` }], source: { kind: 'user' } } },
		{ seq: from + 2, type: 'user/message', data: { content: [{ type: 'text', text: 'runtime context' }], source: { kind: 'system' } } },
	]
	if (reason !== null) events.push({ seq: from + 3, type: 'turn/end', data: { turn, reason } })
	return events
}

/**
 * 捏一条只有自有轮次的会话（不涉及继承，撤回和 fork 是两件事）。
 * @param id - 会话 id
 * @param specs - 每轮 `{turn, done, rewound}`
 * @returns 一条 /outlines 里的会话记录
 */
function session(id, specs) {
	return {
		id,
		cwd: '/x',
		parentId: undefined,
		createdAt: 1,
		forkTurn: undefined,
		turns: specs.map((spec) => ({
			turn: spec.turn,
			seq: spec.turn * 10,
			promptSeq: spec.turn * 10 + 1,
			endSeq: spec.turn * 10 + 3,
			time: spec.turn,
			prompt: `#${spec.turn}`,
			compact: false,
			inherited: false,
			done: spec.done !== false,
			...(spec.rewound === true ? { rewound: true } : {}),
		})),
	}
}

/**
 * 站在 `currentId` 的视角建一次图。
 * @param sessions - 全部分支
 * @param currentId - 当前会话
 * @returns {graph, byKey}
 */
function build(sessions, currentId) {
	const visible = new Set(sessions.map((item) => item.id))
	const picked = pure.conversationOf(pure.visibleTree(sessions, visible), currentId)
	const graph = pure.buildGraph(picked, currentId)
	return { graph, byKey: new Map(graph.nodes.map((node) => [node.key, node])) }
}

/**
 * 一个节点的父亲 key（根节点是 'root'）。
 * @param node - 节点
 * @returns key 或 '(无)'
 */
function parentKey(node) {
	return node === undefined ? '(无)' : node.parent === undefined ? '(无父)' : node.parent.key
}

// ===== 第 3 步：host 半 =====

console.log('用例 1：done 只认 completed')
{
	const cases = [
		{ label: '答完', reason: { kind: 'completed' }, want: true },
		{ label: '用户中止', reason: { kind: 'aborted', reason: { kind: 'user' } }, want: false },
		{ label: '被打断', reason: { kind: 'interrupted' }, want: false },
		{ label: '报错', reason: { kind: 'error', error: { message: 'x' } }, want: false },
		{ label: '还没结束', reason: null, want: false },
	]
	for (const one of cases) {
		const [entry] = foldOutline(turnEvents(1, 4, one.reason)).turns
		check(entry.done === one.want, `${one.label} 的 done 该是 ${one.want}，实际 ${entry.done}`)
	}
	// ⚠️ 这条是整件事的地基：盘上 34 条 aborted **都带着 turn/end**，
	//    要是把 done 退化成"有没有 turn/end"，中止掉的半截轮次会被当成答完了留在树上。
	const aborted = foldOutline(turnEvents(1, 4, { kind: 'aborted', reason: { kind: 'user' } })).turns[0]
	check(aborted.endSeq !== undefined && aborted.done === false, '中止的轮次也有 turn/end —— done 不能靠 endSeq 判')
	console.log(`  completed → done；aborted / interrupted / error / 没结束 → 不 done（中止的 endSeq=${aborted.endSeq}）`)
}

console.log('用例 2：promptSeq 记的是真人那一行')
{
	const [entry] = foldOutline(turnEvents(7, 100, { kind: 'completed' })).turns
	check(entry.seq === 100, `turn/start 的 seq 该是 100，实际 ${entry.seq}`)
	check(entry.promptSeq === 101, `promptSeq 该是真人消息那条（101），实际 ${entry.promptSeq}`)
	// 撤回点就是用户点的那一行，区间从它开始 —— 拿 turn/start 的 seq 去比永远落在区间外
	check(turnHidden(entry, [{ start: 101, end: 130 }]) === true, '真人行落在区间里却没判成撤回')
	check(turnHidden({ seq: 100, endSeq: 103 }, [{ start: 101, end: 130 }]) === true, '折不出提示词时该退而用 endSeq')
	check(turnHidden(entry, [{ start: 102, end: 130 }]) === false, '区间在这一轮之后，不该算撤回')
	check(turnHidden(entry, []) === false, '没有区间时不该算撤回')
	check(turnHidden({}, [{ start: 0, end: 999 }]) === false, '两个 seq 都没有时不该瞎猜')
	console.log('  seq=100(turn/start) / promptSeq=101(真人行)，区间 [101,130] 命中')
}

console.log('用例 3：盖戳不碰原对象')
{
	const turns = foldOutline([...turnEvents(1, 4, { kind: 'completed' }), ...turnEvents(2, 10, { kind: 'completed' })]).turns
	const marked = markRewound(turns, [{ start: 5, end: 9 }])
	check(marked[0].rewound === true, '第 1 轮在区间里，该盖上撤回戳')
	check(marked[1].rewound !== true, '第 2 轮不在区间里，不该被牵连')
	// ⚠️ turns 是大纲缓存里那一份。就地改的话撤回状态会被腌进缓存，
	//    之后 ranges 清空（新分支 graft 就会清）也刷不掉。
	check(turns[0].rewound === undefined, '盖戳把缓存里那份原对象改掉了')
	check(markRewound(turns, []) === turns, '没有区间时该原样返回，不白拷一遍')
	console.log('  戳盖在副本上，缓存里那份原封不动')
}

// ===== 第 4 步：client 半 =====

console.log('用例 4：4 答完了才撤回 → 1-2-3-4 和 1-2-3-5 两条')
{
	const sessions = [session('S', [
		{ turn: 1 }, { turn: 2 }, { turn: 3 },
		{ turn: 4, done: true, rewound: true },
		{ turn: 5 },
	])]
	const { graph, byKey } = build(sessions, 'S')
	check(byKey.has('S:4'), '答完的那一轮被撤回后不该消失')
	check(parentKey(byKey.get('S:4')) === 'S:3', `4 该挂在 3 下面，实际挂在 ${parentKey(byKey.get('S:4'))}`)
	check(parentKey(byKey.get('S:5')) === 'S:3', `5 该接回 3（不是接在 4 后面），实际 ${parentKey(byKey.get('S:5'))}`)
	check(byKey.get('S:4').depth === byKey.get('S:5').depth, '4 和 5 是同一个岔路的两个孩子，该同高度')
	// 主列留给还活着的那条，废弃支线让到旁边去
	check(byKey.get('S:5').column === byKey.get('S:3').column, '5 该留在主列上')
	check(byKey.get('S:4').column !== byKey.get('S:3').column, '撤回掉的 4 占住了主列，把还活着的 5 挤走了')
	// 撤回掉的那一轮不在对话里，不能跟着亮成"当前路径"
	check(byKey.get('S:4').active === false, '撤回掉的 4 不该算在当前路径上')
	check(byKey.get('S:5').active === true, '5 在当前路径上却没亮')
	check(byKey.get('S:4').rewound === true, '节点上该留着 rewound 标记（卡片要挂"撤回"牌子）')
	// claude 那边连锚点都一起删了（planRewind），从这儿 fork 只能得到一条失忆分支
	check(pure.branchAction(byKey.get('S:4')) === 'none', '撤回掉的节点不该给 ＋ 按钮')
	check(pure.branchAction(byKey.get('S:5')) === 'open', '还活着的叶子该照常给"接着问"')
	console.log(`  3 的孩子：${byKey.get('S:3').children.map((kid) => kid.key).join(' / ')}，深度 ${graph.maxDepth}`)
}

console.log('用例 5：4 答到一半被中止再撤回 → 树上不该有 4')
{
	const sessions = [session('S', [
		{ turn: 1 }, { turn: 2 }, { turn: 3 },
		{ turn: 4, done: false, rewound: true },
		{ turn: 5 },
	])]
	const { graph, byKey } = build(sessions, 'S')
	check(!byKey.has('S:4'), '没答完就被撤回的那一轮不该画出来')
	check(parentKey(byKey.get('S:5')) === 'S:3', `5 该直接接在 3 后面，实际 ${parentKey(byKey.get('S:5'))}`)
	check(byKey.get('S:5').column === byKey.get('S:3').column, '只剩一条线了，5 不该拐弯')
	check(graph.maxDepth === 4, `1-2-3-5 只有 4 层（含根），实际 ${graph.maxDepth}`)
	for (const node of graph.nodes) {
		if (node.parent !== undefined) check(node.depth === node.parent.depth + 1, `depth 不连续：${node.key}`)
	}
	// 没撤回的中止轮照旧留着：那半截回答还在对话里，是真历史
	const kept = build([session('T', [{ turn: 1 }, { turn: 2, done: false }, { turn: 3 }])], 'T')
	check(kept.byKey.has('T:2'), '只是中止、没撤回的轮次不该被顺手删掉')
	check(parentKey(kept.byKey.get('T:3')) === 'T:2', '没撤回的中止轮还该串在链上')
	console.log(`  留下 ${graph.nodes.filter((node) => node.entry !== undefined).map((node) => node.entry.turn).join('-')}`)
}

console.log('用例 6：连撤两轮')
{
	const sessions = [session('S', [
		{ turn: 1 },
		{ turn: 2, done: true, rewound: true },
		{ turn: 3, done: false, rewound: true },
		{ turn: 4, done: true, rewound: true },
		{ turn: 5 },
	])]
	const { byKey } = build(sessions, 'S')
	check(!byKey.has('S:3'), '3 没答完，不该画')
	check(parentKey(byKey.get('S:2')) === 'S:1', '撤回段的第一轮该挂在撤回之前那个节点下')
	check(parentKey(byKey.get('S:4')) === 'S:2', `撤回段内部还是串成一条（4 接 2），实际 ${parentKey(byKey.get('S:4'))}`)
	check(parentKey(byKey.get('S:5')) === 'S:1', `5 该一路接回 1，实际 ${parentKey(byKey.get('S:5'))}`)
	check(byKey.get('S:5').column === byKey.get('S:1').column, '5 该留在主列上')
	console.log('  1 →{ 2 → 4（废弃）, 5（活着）}')
}

// ===== 第 5 步：拿盘上真实的会话兜一遍 =====

console.log('用例 7：真实日志 + 真实旁车')
{
	/**
	 * 解一个 session 文件（v3 是多 frame 拼接的 zstd，只解第一个会漏）。
	 * @param file - 绝对路径
	 * @returns 事件数组
	 */
	const readSession = (file) => {
		const buffer = fs.readFileSync(file)
		const parts = []
		let at = 0
		while (at < buffer.length) {
			if (buffer.length - at < 4 || buffer.readUInt32LE(at) !== 0xfd2fb528) break
			let cursor = at + 4
			const descriptor = buffer.readUInt8(cursor)
			cursor += 1
			const single = (descriptor & 32) !== 0
			const dictionary = (descriptor & 3) === 3 ? 4 : descriptor & 3
			const sized = descriptor >>> 6 === 0 ? (single ? 1 : 0) : 1 << (descriptor >>> 6)
			cursor += (single ? 0 : 1) + dictionary + sized
			for (;;) {
				const header = buffer.readUIntLE(cursor, 3)
				cursor += 3
				cursor += (header >>> 1) & 3 ? ((header >>> 1) & 3) === 1 ? 1 : header >>> 3 : header >>> 3
				if ((header & 1) !== 0) break
			}
			if ((descriptor & 4) !== 0) cursor += 4
			parts.push(zlib.zstdDecompressSync(buffer.subarray(at, cursor)))
			at = cursor
		}
		return Buffer.concat(parts)
			.toString('utf8')
			.split('\n')
			.filter((line) => line.trim() !== '')
			.map((line) => {
				try {
					return JSON.parse(line)
				} catch {
					return null
				}
			})
			.filter(Boolean)
	}

	const root = path.join(HOME, 'sessions')
	let looked = 0
	let found = 0
	// ⚠️ 正在跑的会话一个字节都不许读（用例 9 讲了为什么）。测试在 dsh 外面，
	//    拿不到 ctx.agents，所以拿"日志近十分钟动过"当"可能在跑"。
	const LIVE_MS = 10 * 60 * 1000
	if (fs.existsSync(root)) {
		for (const bucket of fs.readdirSync(root)) {
			for (const dir of fs.readdirSync(path.join(root, bucket))) {
				const file = path.join(root, bucket, dir, 'session.v3.jsonl.zstd')
				if (!fs.existsSync(file)) continue
				const hot = Date.now() - fs.statSync(file).mtimeMs < LIVE_MS
				const events = readSession(file)
				const id = (events[0] || {}).id
				if (id === undefined) continue
				const ranges = rewindStateOf(() => hot, id).ranges
				looked += 1
				if (ranges.length === 0) continue
				found += 1
				const turns = markRewound(foldOutline(events).turns, ranges)
				const hidden = turns.filter((entry) => entry.rewound === true)
				check(hidden.length > 0, `${id.slice(8, 16)} 有撤回区间却一轮都没命中 —— 对不上说明 seq 的口径错了`)
				// 撤回区间从用户点的那一行伸到"当时日志的末尾"，所以命中的必然是连着的一段尾巴，
				// 而不是中间挖几个洞。对不上就是把不该撤的轮次也算进去了。
				const turnsIn = hidden.map((entry) => entry.turn)
				const span = Math.max(...turnsIn) - Math.min(...turnsIn) + 1
				check(span === turnsIn.length, `${id.slice(8, 16)} 命中的轮次不连续：${turnsIn.join(',')}`)
				console.log(`  ${id.slice(8, 16)}  区间 ${JSON.stringify(ranges)}  撤回轮次 ${turnsIn.join(',')}（答完的 ${hidden.filter((entry) => entry.done).length} 条）`)
			}
		}
	}
	check(looked > 0, `${root} 下一个会话都没读到，这个用例等于没跑`)
	if (looked > 0 && found === 0) console.log('  （这台机器上没有撤回过的会话，只跑了"不误伤"那一半）')
}

console.log('用例 8：旁车读得对、读坏了也不崩、撤回后能刷新')
{
	const was = process.env.DSH_HOME
	const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-tree-rewind-'))
	const folder = path.join(home, 'plugins', 'dsh-claude', 'sessions')
	fs.mkdirSync(folder, { recursive: true })
	const fileOf = (id) => path.join(folder, `${Buffer.from(id).toString('base64url')}.json`)
	/** 写完顺手把 mtime 拨早 —— 静默期只放行"安静了 1.5 秒"的文件，不拨的话每次都会被挡。 */
	const write = (id, text) => {
		fs.writeFileSync(fileOf(id), text)
		const old = new Date(Date.now() - SIDECAR_QUIET_MS * 4)
		fs.utimesSync(fileOf(id), old, old)
	}
	const put = (id, ranges, filler) =>
		write(id, JSON.stringify({ schemaVersion: 1, revision: 3, activities: [{ text: filler || '' }], binding: {}, rewind: { ranges, anchors: [], snapshots: [] } }))
	const idle = () => false
	const ranges = (id) => rewindStateOf(idle, id).ranges

	process.env.DSH_HOME = home
	try {
		// ⚠️ 正文里故意塞一段长得像 ranges 的话：读旁车前有个"原文里没有 `"ranges":[{` 就
		//    不 JSON.parse"的快速通道（旁车能到 6.7MB，parse 一次 42ms）。
		//    正文骗得到它只是多解析一次，**结论必须一样**。
		put('s-ok', [{ start: 8, end: 17 }], '我在对话里写了 "ranges":[{"start":1}] 这么一串')
		check(JSON.stringify(ranges('s-ok')) === '[{"start":8,"end":17}]', `正常旁车没读出区间，实际 ${JSON.stringify(ranges('s-ok'))}`)
		put('s-none', [], '我在对话里写了 "ranges":[{"start":1}] 这么一串')
		check(ranges('s-none').length === 0, '没撤回过却读出了区间')

		// 读不到 / 版本对不上 / 文件半截 —— 一律当"没撤回"。这东西坏了只是撤回状态没了，
		// 不该把整条导轨带崩（和 readSidecar 一个脾气）。
		write('s-old', JSON.stringify({ schemaVersion: 99, rewind: { ranges: [{ start: 1, end: 2 }] } }))
		check(ranges('s-old').length === 0, '版本对不上还照读')
		write('s-bad', '{"rewind":{"ranges":[{"start":1,')
		check(ranges('s-bad').length === 0, '半截文件没被挡住')
		check(ranges('s-missing').length === 0, '没有旁车时不该崩')
		check(rewindStateOf(idle, 's-missing').pending === false, '没有旁车 = 不是 claude 会话，不该报"还欠着"')

		// ⚠️ 缓存跟着旁车文件的 mtime+size 走，**不能挂在会话 revision 上**：
		//    撤回一个 dsh 事件都不写，revision 纹丝不动，挂上去就永远刷不出来。
		put('s-ok', [{ start: 40, end: 50 }], '')
		check(JSON.stringify(ranges('s-ok')) === '[{"start":40,"end":50}]', `旁车变了却还在吃缓存，实际 ${JSON.stringify(ranges('s-ok'))}`)
		console.log('  正常 / 空 / 老版本 / 半截 / 缺文件 都对；旁车一变就重读')
	} finally {
		if (was === undefined) delete process.env.DSH_HOME
		else process.env.DSH_HOME = was
		fs.rmSync(home, { recursive: true, force: true })
	}
}

// ===== 第 6 步：⚠️ 最要命的一条：正在跑的会话一个字节都不许读 =====

console.log('用例 9：会话在跑就不碰旁车（读它会打死那一轮）')
{
	const was = process.env.DSH_HOME
	const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-tree-busy-'))
	const folder = path.join(home, 'plugins', 'dsh-claude', 'sessions')
	fs.mkdirSync(folder, { recursive: true })
	const fileOf = (id) => path.join(folder, `${Buffer.from(id).toString('base64url')}.json`)
	const put = (id, list, age) => {
		fs.writeFileSync(fileOf(id), JSON.stringify({ schemaVersion: 1, revision: 1, activities: [], binding: {}, rewind: { ranges: list, anchors: [], snapshots: [] } }))
		const when = new Date(Date.now() - age)
		fs.utimesSync(fileOf(id), when, when)
	}
	const quiet = SIDECAR_QUIET_MS * 4

	process.env.DSH_HOME = home
	try {
		// ① 在跑 = 不读。这一条就是那次"整轮判失败"的修复本体，别放宽。
		put('s-busy', [{ start: 8, end: 17 }], quiet)
		const hot = rewindStateOf(() => true, 's-busy')
		check(hot.ranges.length === 0, '会话正在跑却把旁车读了 —— 这正是打死一整轮的那个动作')
		check(hot.pending === true, '没读成却不报 pending，前端就不会回来拉第二次')

		// ② 跑完了再问同一条，就该读到了
		const cool = rewindStateOf(() => false, 's-busy')
		check(JSON.stringify(cool.ranges) === '[{"start":8,"end":17}]', `跑完了还是没读到，实际 ${JSON.stringify(cool.ranges)}`)
		check(cool.pending === false, '读到了就不该再报 pending')

		// ③ 静默期：刚写过的文件也不碰。`turn/end` 之后还可能有一次迟到的 flush，
		//    那次 rename 撞上我们的读句柄同样是 EPERM。
		put('s-fresh', [{ start: 1, end: 2 }], 0)
		const fresh = rewindStateOf(() => false, 's-fresh')
		check(fresh.ranges.length === 0, '旁车刚写过就去读了，没等静默期')
		check(fresh.pending === true, '因为静默期没读成，也该报 pending')

		// ④ 没读成时要**沿用上一次的结果**，不能退回空。
		//    撤回只发生在两轮之间（按钮在历史消息行上），所以一轮跑着的时候缓存必然还是对的；
		//    退回空的话，每跑一轮撤回过的节点就会诈尸一次。
		put('s-keep', [{ start: 5, end: 9 }], quiet)
		check(JSON.stringify(rewindStateOf(() => false, 's-keep').ranges) === '[{"start":5,"end":9}]', '先读一次都没读到')
		put('s-keep', [{ start: 5, end: 99 }], 0) // 变了、而且是热的
		const kept = rewindStateOf(() => true, 's-keep')
		check(JSON.stringify(kept.ranges) === '[{"start":5,"end":9}]', `没读成时该沿用上一次，实际 ${JSON.stringify(kept.ranges)}`)
		check(kept.pending === true, '用的是旧值，就该报 pending')

		// ⑤ 判据是**三态**，别压成布尔：读旁车时 `unknown` 当成在跑（不读，赌错了打死整轮），
		//    拦合并时 `unknown` 当成空闲（放行，赌错了只是多合了一条）。压成布尔必有一头是错的。
		check(statusProbe({})('whatever') === 'unknown', '没有 ctx.agents 时该报 unknown')
		check(statusProbe({ agents: { get: () => { throw new Error('boom') } } })('x') === 'unknown', '判据抛异常时该报 unknown')
		check(statusProbe({ agents: { get: () => undefined } })('x') === 'idle', '冷会话没有 agent，该报 idle')
		check(statusProbe({ agents: { get: () => ({ status: 'running' }) } })('x') === 'running', 'status=running 没报出来')
		check(statusProbe({ agents: { get: () => ({ status: 'idle' }) } })('x') === 'idle', 'status=idle 没报出来')
		// 读旁车那一侧的口径：unknown 必须当成"别读"。用一条**没读过**的会话，
		// 否则会命中缓存，测不到"到底读没读"。
		put('s-unknown', [{ start: 3, end: 4 }], quiet)
		const guess = rewindStateOf((id) => statusProbe({})(id) !== 'idle', 's-unknown')
		check(guess.pending === true && guess.ranges.length === 0, '认不出状态时还是去读了旁车')

		// ⑥ 前端要据此回来拉第二次，并且在导轨上说明原因
		check(pure.isRewindPending({ sessions: [{ rewindPending: true }] }) === true, '前端没认出"还欠着"')
		check(pure.isRewindPending({ sessions: [{}] }) === false, '没欠着却说欠着')
		check(pure.isRewindPending(undefined) === false, '还没拿到答复时不该崩')
		check(Z.rewindMs > 0, '没有重拉间隔的话，撤回完那一轮的形状永远不会更正')
		// 撤回不写 dsh 日志，会话列表毫无动静 —— 前端**不自己回来拉就永远等不到**
		check(pure.rewindRetryDelay({ sessions: [{ rewindPending: true }] }) === Z.rewindMs, '还欠着却不打算回来拉第二次')
		check(pure.rewindRetryDelay({ sessions: [{}] }) === 0, '不欠着还一直重拉，白白打扰 host')
		check(pure.rewindRetryDelay(undefined) === 0, '还没拿到答复就开始重拉')
		console.log('  在跑 / 刚写过 → 不读、沿用旧值、报 pending；认不出来一律当在跑')
	} finally {
		if (was === undefined) delete process.env.DSH_HOME
		else process.env.DSH_HOME = was
		fs.rmSync(home, { recursive: true, force: true })
	}
}

console.log('用例 10：整条 /outlines 管线（假 ctx）')
{
	const was = process.env.DSH_HOME
	const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-tree-route-'))
	const folder = path.join(home, 'plugins', 'dsh-claude', 'sessions')
	fs.mkdirSync(folder, { recursive: true })
	const id = 'session-route-0001'
	const file = path.join(folder, `${Buffer.from(id).toString('base64url')}.json`)
	fs.writeFileSync(file, JSON.stringify({ schemaVersion: 1, revision: 1, activities: [], binding: {}, rewind: { ranges: [{ start: 15, end: 40 }], anchors: [], snapshots: [] } }))
	const old = new Date(Date.now() - SIDECAR_QUIET_MS * 4)
	fs.utimesSync(file, old, old)

	// 第 1 轮答完（seq 11 是真人那行），第 2 轮被中止 —— 撤回区间盖住第 2 轮
	const events = [
		{ seq: undefined, id, cwd: '/x' },
		...turnEvents(1, 4, { kind: 'completed' }),
		...turnEvents(2, 14, { kind: 'aborted', reason: { kind: 'user' } }),
	]
	/**
	 * 一个刚好够 collect 用的假 ctx。
	 * @param status - 这条会话的 agent 状态；undefined 表示冷会话（没有 agent）
	 * @returns 假 ctx
	 */
	const fakeCtx = (status) => ({
		agents: { get: () => (status === undefined ? undefined : { status }) },
		sessionPersistence: {
			list: async () => [{ revision: 1, header: { id, cwd: '/x', createdAt: 1 } }],
			open: async () => ({ read: async () => ({ events }), close: async () => {} }),
		},
	})

	process.env.DSH_HOME = home
	try {
		// ① 会话空闲 → 读得到撤回区间，第 2 轮盖上戳，且不报 pending
		const idle = (await collect(fakeCtx('idle'), '/x')).sessions[0]
		check(idle.rewindPending === undefined, '空闲还报 pending，前端会白白多拉一次')
		check(idle.running === undefined, '空闲还报 running，合并会被白白拦下')
		check(idle.turns[0].rewound !== true, '第 1 轮不在区间里，不该盖戳')
		check(idle.turns[1].rewound === true, `第 2 轮该盖上撤回戳，实际 ${JSON.stringify(idle.turns[1])}`)

		// ② 会话跑起来了，旁车也一直在变（真实情况下每 150ms 一次）→ 一个字节都不读。
		//    **必须把 pending 报出去**，否则前端不会回来拉第二次，
		//    撤回完紧接着发的那一轮形状永远不更正。
		const now = new Date()
		fs.utimesSync(file, now, now)
		const busy = (await collect(fakeCtx('running'), '/x')).sessions[0]
		check(busy.rewindPending === true, '会话在跑、撤回记录没读到，却没把 rewindPending 报给前端')
		// 合并那一侧要的就是这个字段：不报上去，前端拦不住"合并一条正在跑的对话"
		check(busy.running === true, '会话在跑却没把 running 报给前端')
		check(pure.mergeTargets([{ id: 'other', cwd: '/x', turns: [], running: true }, busy], busy.id, {}).length >= 0, 'mergeTargets 吃不下真实记录')
		check(pure.isRewindPending({ sessions: [busy] }) === true, '前端认不出 host 报上来的 pending —— 两边字段名对不上')
		// 沿用上一次读到的：撤回只发生在两轮之间，所以这一轮里旧值必然还是对的。
		// 退回空的话，每跑一轮撤回过的节点就诈尸一次。
		check(busy.turns[1].rewound === true, '没读成就把撤回戳丢了 —— 该沿用上一次读到的')
		// ③ 这条会话的正文托管给了外部引擎（有旁车）→ 前端据此判断"从这儿开分支要不要先继承上下文"
		check(idle.claude === true, '有旁车却没报 claude，前端就不知道该不该拦 ＋')
		check(pure.forkBlockedWhy({ entry: { turn: 1 }, children: [{}, {}], session: busy }) !== '', 'host 报了 running+claude，前端却没拦住 ＋ —— 两边字段名对不上')
		console.log('  空闲 → 读到、不报 pending；在跑 → 不读、沿用旧值、报 pending，前端认得出')
	} finally {
		if (was === undefined) delete process.env.DSH_HOME
		else process.env.DSH_HOME = was
		fs.rmSync(home, { recursive: true, force: true })
	}
}

console.log('用例 11：哪条分支该标成「无上下文」')
{
	const was = process.env.DSH_HOME
	const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-tree-amnesia-'))
	const folder = path.join(home, 'plugins', 'dsh-claude', 'sessions')
	fs.mkdirSync(folder, { recursive: true })
	/**
	 * 给某条会话摆一份旁车（内容不重要，判据只看文件在不在）。
	 * @param id - 会话 id
	 */
	const putSidecar = (id) => fs.writeFileSync(path.join(folder, `${Buffer.from(id).toString('base64url')}.json`), '{}')

	// 父 claude 会话 → 三个孩子：接上了的 / 没接上的 / 普通 provider 那条
	putSidecar('p-claude')
	putSidecar('c-ok') // 接上了：自己有旁车
	const headers = [
		{ id: 'p-claude', cwd: '/x', createdAt: 1 },
		{ id: 'c-ok', cwd: '/x', createdAt: 2, parentSession: 'p-claude', isSeeded: true },
		{ id: 'c-amnesiac', cwd: '/x', createdAt: 3, parentSession: 'p-claude', isSeeded: true },
		{ id: 'p-plain', cwd: '/x', createdAt: 4 },
		{ id: 'c-plain', cwd: '/x', createdAt: 5, parentSession: 'p-plain', isSeeded: true },
	]
	const ctx = {
		agents: { get: () => ({ status: 'idle' }) },
		sessionPersistence: {
			list: async () => headers.map((header) => ({ revision: 1, header })),
			open: async () => ({ read: async () => ({ events: [] }), close: async () => {} }),
		},
	}

	process.env.DSH_HOME = home
	try {
		const byId = new Map((await collect(ctx, '/x')).sessions.map((item) => [item.id, item]))
		check(byId.get('c-amnesiac').contextMissing === true, '该继承却没继承到的分支必须被标出来 —— 不标就是让人以为它记得前情')
		check(byId.get('c-ok').contextMissing === undefined, '已经接上了的分支不许误报')
		check(byId.get('c-plain').contextMissing === undefined, '普通 provider 的分支本来就没有外部记忆可继承，不许误报')
		check(byId.get('p-claude').contextMissing === undefined, '不是 fork 出来的会话根本谈不上"继承"')
		check(byId.get('p-claude').claude === true && byId.get('p-plain').claude === undefined, 'claude 标记认错了会话')
		console.log('  没接上 → 标；接上了 / 普通 provider / 非分支 → 不标')
	} finally {
		if (was === undefined) delete process.env.DSH_HOME
		else process.env.DSH_HOME = was
		fs.rmSync(home, { recursive: true, force: true })
	}
}

// ===== 第 7 步：surface replace + 有效岔路点 =====
//
// 撤回的第二个真相来源：宿主原生的 surface。dsh-rewind-plugin / dsh-retrace 的就地撤回
// 都是往日志里追加一条 `{op:'replace'}` 的标记，把一段 surface 节点遮掉。它在日志里，
// 所以在 foldOutline 里折，和旁车 ranges 那条最后汇成同一个 `rewound` 戳。

console.log('用例 12：surface replace 遮掉提问行的那一轮就是撤回了')
{
	/** 一轮带 surface 标记的事件：提问行和回答行都是 append。 */
	const surfaced = (turn, from) => [
		{ seq: from, type: 'turn/start', time: turn, data: { turn } },
		{ seq: from + 1, type: 'user/message', surfaceOp: 'append', data: { content: [{ type: 'text', text: `问题 ${turn}` }], source: { kind: 'user' } } },
		{ seq: from + 2, type: 'user/message', surfaceOp: 'append', data: { content: [{ type: 'text', text: 'runtime context' }], source: { kind: 'system' } } },
		{ seq: from + 3, type: 'assistant/message', surfaceOp: 'append', data: { content: [{ type: 'text', text: `回答 ${turn}` }] } },
		{ seq: from + 4, type: 'turn/end', data: { turn, reason: { kind: 'completed' } } },
	]
	// dsh-rewind-plugin 的标记长这样：user/message，source.kind 是 plugin，replace 盖住 3 的提问行到回答行
	const marker = (seq, startSeq, endSeq) => ({
		seq, type: 'user/message', surfaceOp: { op: 'replace', startSeq, endSeq }, sourceEventSeqs: [startSeq, endSeq],
		data: { content: [{ type: 'text', text: '(empty message)' }], source: { kind: 'plugin', plugin: 'dsh-rewind' } },
	})
	const base = [...surfaced(1, 10), ...surfaced(2, 20), ...surfaced(3, 30)]

	// ① 遮掉第 3 轮（提问行 31 到回答行 33）→ 只有 3 被撤回
	const gone = foldOutline([...base, marker(40, 31, 33)]).turns
	check(shadowedSeqs([...base, marker(40, 31, 33)]).size === 3, '该遮掉 31、32、33 三个节点')
	check(gone[2].rewound === true, '第 3 轮的提问行被遮了，该盖上撤回戳')
	check(gone[0].rewound !== true && gone[1].rewound !== true, '前两轮没被遮，不该盖戳')
	check(gone.length === 3 && gone[2].prompt === '问题 3', '标记那条 user/message 被当成了提问 —— 它的 source.kind 不是 user')

	// ② 只换掉回答（重新生成那类）：问题还在，不算撤回
	const regen = foldOutline([...base, marker(40, 33, 33)]).turns
	check(regen[2].rewound !== true, '只换回答不该算撤回 —— 问题还在对话里')

	// ③ 连撤两轮（2 的提问行到 3 的回答行）
	const two = foldOutline([...base, marker(40, 21, 33)]).turns
	check(two[1].rewound === true && two[2].rewound === true && two[0].rewound !== true, '一次 replace 盖住两轮，该两轮都盖戳')

	// ④ 认不得的 replace（指到不在 surface 里的 seq）当没发生，别让整棵树消失
	const bad = foldOutline([...base, marker(40, 999, 33)]).turns
	check(bad.every((entry) => entry.rewound !== true), '坏 replace 该被忽略，而不是乱盖戳')
	check(shadowedSeqs([...base, { seq: 41, type: 'user/message', surfaceOp: { op: 'replace' }, data: {} }]).size === 0, '缺 startSeq/endSeq 的 replace 该被忽略')

	// ⑤ 宿主刷新系统提示也是一次 replace（换 surface 第 0 个节点），不能误伤任何一轮
	const sys = [{ seq: 5, type: 'system/message', surfaceOp: 'append', data: {} }, ...base, { seq: 40, type: 'system/message', surfaceOp: { op: 'replace', startSeq: 5, endSeq: 5 }, sourceEventSeqs: [5], data: {} }]
	check(foldOutline(sys).turns.every((entry) => entry.rewound !== true), '系统提示的 replace 误伤了轮次')

	// ⑥ 旁车 ranges 和 surface 两条路汇成同一个戳：surface 盖过的，markRewound 不会抹掉
	const both = markRewound(gone, [{ start: 11, end: 14 }])
	check(both[0].rewound === true && both[2].rewound === true, '两条真相来源该叠加，而不是谁后来谁说了算')
	console.log('  遮提问行 → 撤回；只换回答 → 不算；坏 replace / 系统提示 replace → 不误伤；与旁车 ranges 叠加')
}

console.log('用例 13：岔路点按这条分支自己的眼光算')
{
	const turn = (n, inherited, rewound) => ({ turn: n, inherited, ...(rewound ? { rewound: true } : {}) })
	check(effectiveForkTurn([turn(1, true), turn(2, true), turn(3, true), turn(4, false)]) === 3, '没撤回时就是继承前缀的最后一轮')
	check(effectiveForkTurn([turn(1, true), turn(2, true), turn(3, true, true), turn(4, false)]) === 2, '撤掉继承来的 3，岔路点该退到 2')
	check(effectiveForkTurn([turn(1, true), turn(2, true, true), turn(3, true, true), turn(4, false)]) === 1, '撤掉 2、3，岔路点该退到 1')
	check(effectiveForkTurn([turn(1, true, true), turn(2, true, true), turn(3, false)]) === undefined, '继承的全撤光了该是 undefined（从头再来）')
	check(effectiveForkTurn([turn(1, false), turn(2, false)]) === undefined, '不是分支就没有岔路点')
	check(effectiveForkTurn([turn(1, true), turn(2, true), turn(3, false, true)]) === 2, '撤的是自有轮，不影响岔路点')
	check(effectiveForkTurn([]) === undefined && effectiveForkTurn(undefined) === undefined, '空输入不该炸')
	console.log('  3 撤回 → 2；2、3 撤回 → 1；全撤 → undefined；撤自有轮不影响')
}

console.log('用例 14：John 报的那张图 —— 1-2-3，分支里撤了 3 再发，4 该挂在 2 下面')
{
	// 父分支 A：1-2-3 都在。子分支 B 从 3 岔出（继承 1-2-3），然后在 B 里撤回了 3，再发 4。
	const A = session('A', [{ turn: 1 }, { turn: 2 }, { turn: 3 }])
	const bTurns = [
		{ turn: 1, inherited: true }, { turn: 2, inherited: true }, { turn: 3, inherited: true, rewound: true },
		{ turn: 4, inherited: false },
	].map((spec) => ({ turn: spec.turn, seq: spec.turn * 10, promptSeq: spec.turn * 10 + 1, endSeq: spec.turn * 10 + 3, time: spec.turn, prompt: `#${spec.turn}`, compact: false, done: true, inherited: spec.inherited, ...(spec.rewound ? { rewound: true } : {}) }))
	const B = { id: 'B', cwd: '/x', parentId: 'A', createdAt: 2, forkTurn: effectiveForkTurn(bTurns), turns: bTurns }
	check(B.forkTurn === 2, `B 的岔路点该是 2，实际 ${B.forkTurn}`)
	const { byKey } = build([A, B], 'B')
	check(parentKey(byKey.get('B:4')) === 'A:2', `B 的 4 该挂在 A:2 下面，实际挂在 ${parentKey(byKey.get('B:4'))}`)
	check(parentKey(byKey.get('A:3')) === 'A:2', 'A 自己的 3 还在对话里，该仍挂在 A:2 下面')
	check(byKey.get('A:3').rewound !== true, 'A 没撤回 3，A:3 不该被 B 的撤回连累')
	// 对照：老算法（继承前缀最后一轮 = 3）会把 4 挂到 3 下面 —— 正是那张错图
	const old = { ...B, forkTurn: 3 }
	check(parentKey(build([A, old], 'B').byKey.get('B:4')) === 'A:3', '对照组没复现出老 bug，这条用例抓不到回归')
	console.log('  1-2-3 与 1-2-4 两条；A:3 不受 B 的撤回影响；老算法确实画成 1-2-3-4')
}

report()
