/**
 * dsh-tree —— 拿**真实会话**跑合并 / 分离的端到端用例。
 *
 * 【导读】
 * 干嘛的：`test-merge.mjs` 用手捏的小树钉逻辑，这里换成盘上真实的会话
 * （真实的 fork 血缘、真实的继承段、真实的轮次号），把用户真会做的那几套动作
 * 完整走一遍，每一步都验树的形状自洽。
 *
 * 数据流：盘上的 session.v3.jsonl.zstd
 *        → host 的 foldOutline（真代码）
 *        → 拼成 /outlines 的响应体
 *        → host 的 reshape 落盘到**临时** shape.json（真代码）
 *        → client 的 visibleTree / conversationOf / buildGraph（真代码）
 *        → 验不变式
 *
 * ⚠️ 全程**不碰 dsh-claude 的旁车**（`busy` 恒为真）。读旁车会打断正在跑的那一轮，
 *    见 DESIGN.md §3「读旁车会打死正在跑的那一轮」。形状测试不需要撤回信息。
 *
 * 阅读顺序：
 *   第1步  读盘（多 frame zstd）
 *   第2步  取两半的真函数 + 临时 DSH_HOME
 *   第3步  不变式：一棵树画出来必须自洽
 *   第4步  场景 1：真实分叉树 —— 分离再接回去，必须逐节点复原
 *   第5步  场景 2：两条毫无关系的真实对话合并（John 点名的那个）
 *   第6步  场景 3：连着合三条 + 在合进来的那棵里分离，两套存储不许打架
 *
 * 跑法：DSH_HOME=<真实 home> node test-shape.mjs
 *
 * @module test-shape
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'

const REAL_HOME = process.env.DSH_HOME || 'E:/Programs/deepseek-harness/home'

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

// ===== 第 1 步：读盘 =====

/**
 * 解一个 session 文件（v3 是多 frame 拼接的 zstd，只解第一个会漏）。
 * @param file - 绝对路径
 * @returns 事件数组
 */
function readSession(file) {
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
			cursor += ((header >>> 1) & 3) === 1 ? 1 : header >>> 3
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

// ===== 第 2 步：取真函数 =====

// reshape 要落盘，先把家挪到临时目录 —— 绝不动真的 shape.json
const lab = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-tree-shape-'))
process.env.DSH_HOME = lab

const { foldOutline, reshape, __test } = await import('./index.js')

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

/** 读真实会话，拼成 /outlines 的响应体。**恒不读旁车**（见文件头）。 */
const sessions = []
{
	const root = path.join(REAL_HOME, 'sessions')
	const never = () => true // busy 恒为真 = 一个旁车都不碰
	for (const bucket of fs.existsSync(root) ? fs.readdirSync(root) : []) {
		for (const dir of fs.readdirSync(path.join(root, bucket))) {
			const file = path.join(root, bucket, dir, 'session.v3.jsonl.zstd')
			if (!fs.existsSync(file)) continue
			const events = readSession(file)
			const header = events[0] || {}
			if (header.id === undefined) continue
			const outline = foldOutline(events)
			sessions.push({
				id: header.id,
				cwd: header.cwd,
				parentId: header.parentSession,
				createdAt: header.createdAt,
				title: outline.title,
				forkTurn: outline.forkTurn,
				turns: __test.markRewound(outline.turns, __test.rewindStateOf(never, header.id).ranges),
			})
		}
	}
	sessions.sort((left, right) => (left.createdAt || 0) - (right.createdAt || 0))
}

const visible = new Set(sessions.map((item) => item.id))

/**
 * 站在某条会话的视角，按某份 shape 建一次图。
 * @param currentId - 当前会话
 * @param shape - `{groupOf, detached}`
 * @returns `{graph, picked}`；这条会话不可见就 undefined
 */
function render(currentId, shape) {
	const tree = pure.visibleTree(sessions, visible)
	const picked = pure.conversationOf(tree, currentId, shape.groupOf)
	if (picked.length === 0) return undefined
	return { graph: pure.buildGraph(picked, currentId, pure.cutSet(shape.detached, picked)), picked }
}

/**
 * 一张图的指纹：每个节点画在哪一格、父亲是谁。用来比"复原了没"。
 * @param graph - buildGraph 的结果
 * @returns 可比较的字符串
 */
function fingerprint(graph) {
	return graph.nodes
		.map((node) => `${node.key}@${node.column},${node.depth}<${node.parent === undefined ? '-' : node.parent.key}`)
		.sort()
		.join('|')
}

// ===== 第 3 步：不变式 =====

/**
 * 一棵画出来的树必须自洽。每个场景每一步都跑一遍。
 * @param tag - 出错时打印哪个场景
 * @param graph - buildGraph 的结果
 */
function sane(tag, graph) {
	const seen = new Set()
	const cell = new Map()
	let roots = 0
	for (const node of graph.nodes) {
		if (node.parent === undefined) roots += 1
		else check(node.depth === node.parent.depth + 1, `[${tag}] depth 不连续：${node.key}`)
		if (node.entry !== undefined) {
			check(!seen.has(node.key), `[${tag}] 同一个节点画了两次：${node.key}`)
			seen.add(node.key)
			check(node.entry.inherited !== true, `[${tag}] 画出了继承轮 ${node.key}`)
		}
		const at = `${node.column},${node.depth}`
		check(!cell.has(at), `[${tag}] 两个节点叠在同一格 (${at})：${node.key} 和 ${cell.get(at)}`)
		cell.set(at, node.key)
	}
	// ⚠️ 合并之后**仍然只能有一个空根**。两个根意味着导轨上冒出两个"新对话"点，
	//    那正是合并没生效、只是把两棵树的节点混在一起画的样子。
	check(roots === 1, `[${tag}] 该只有一个根，实际 ${roots} 个`)
	for (const node of graph.nodes) {
		const columns = node.children.map((kid) => kid.column)
		check(new Set(columns).size === columns.length, `[${tag}] ${node.key} 的几个孩子挤在同一列：${columns}`)
	}
}

/** 按树归组：树编号 → 会话 id 列表。 */
const treesOf = (groupOf) => {
	const byId = new Map(sessions.map((item) => [item.id, item]))
	const out = new Map()
	for (const item of sessions) {
		const tree = pure.treeOf(byId, groupOf, item.id)
		if (tree === undefined) continue
		if (!out.has(tree)) out.set(tree, [])
		out.get(tree).push(item.id)
	}
	return out
}

console.log(`读到 ${sessions.length} 条真实会话，${treesOf({}).size} 棵树\n`)
check(sessions.length > 0, `${REAL_HOME}/sessions 下一条会话都没读到，这个脚本等于没跑`)

// ===== 第 4 步：场景 1 —— 真实分叉树上分离再接回去 =====

console.log('场景 1：真实分叉树 —— 分离 → 接回去，必须逐节点复原')
{
	// 挑一棵真有 fork 的树（会话数最多的那棵）
	const groups = [...treesOf({}).entries()].sort((left, right) => right[1].length - left[1].length)
	const [tree, members] = groups[0]
	check(members.length > 1, `最大的那棵树只有 ${members.length} 条分支，测不到真实 fork`)

	const before = render(tree, { groupOf: {}, detached: [] })
	check(before !== undefined, '真实树渲染不出来')
	sane('分离前', before.graph)
	const was = fingerprint(before.graph)

	// 找一个能分离的节点，取它的剪点
	const target = before.graph.nodes.find((node) => node.canDetach === true)
	check(target !== undefined, '这棵树上没有能分离的节点，场景 1 等于没跑')
	const at = pure.cutPointOf(target)
	check(at !== undefined, 'canDetach 为真却算不出剪点 —— 按钮在但点了没反应')

	const cut = reshape({ session: at.key, detach: true })
	const after = render(tree, cut)
	sane('分离后', after.graph)
	// 分离之后节点变少了（那棵子树搬走了），但绝不能凭空多出来
	const keysBefore = new Set(before.graph.nodes.filter((n) => n.entry).map((n) => n.key))
	const keysAfter = new Set(after.graph.nodes.filter((n) => n.entry).map((n) => n.key))
	check([...keysAfter].every((key) => keysBefore.has(key)), '分离之后冒出了原来没有的节点')

	// 站到被拆走那棵上：它必须包含剪点，而且自己也自洽
	const there = render(at.session.id, cut)
	if (there !== undefined) sane('拆出去那棵', there.graph)

	const back = reshape({ session: at.key, detach: false })
	const again = render(tree, back)
	sane('接回去之后', again.graph)
	// ⚠️ 这是这条场景的核心：接回去必须**逐节点**回到原样（列、深度、父亲全一致），
	//    而不只是"节点数对上了"。列错一格，图上就是一条凭空拐弯的线。
	check(fingerprint(again.graph) === was, '接回去之后没有完全复原（列 / 深度 / 父子关系有出入）')
	console.log(`  树 ${tree.slice(8, 16)}（${members.length} 条分支，${keysBefore.size} 个节点）剪在 ${at.key} → 接回后逐节点一致`)
}

// ===== 第 5 步：场景 2 —— 两条毫无关系的对话合并 =====

console.log('场景 2：两条从始至终没关系的真实对话，合并')
{
	// 挑两棵**不同 cwd 无所谓、但彼此无血缘**的树，各自都得有节点
	const groups = [...treesOf({}).entries()]
		.map(([tree, members]) => ({ tree, members, nodes: members.reduce((sum, id) => sum + sessions.find((s) => s.id === id).turns.filter((t) => !t.inherited).length, 0) }))
		.filter((one) => one.nodes > 0)
		.sort((left, right) => right.nodes - left.nodes)
	check(groups.length >= 2, `只有 ${groups.length} 棵有内容的树，合并场景跑不起来`)
	const [one, two] = groups

	const soloOne = render(one.tree, { groupOf: {}, detached: [] })
	const soloTwo = render(two.tree, { groupOf: {}, detached: [] })
	sane('合并前甲', soloOne.graph)
	sane('合并前乙', soloTwo.graph)
	const keysOne = new Set(soloOne.graph.nodes.filter((n) => n.entry).map((n) => n.key))
	const keysTwo = new Set(soloTwo.graph.nodes.filter((n) => n.entry).map((n) => n.key))
	check([...keysOne].every((key) => !keysTwo.has(key)), '挑出来的两棵树有共同节点，不是"毫无关系"')

	const merged = reshape({ session: two.tree, group: one.tree })
	const both = render(one.tree, merged)
	sane('合并后', both.graph)

	const keysBoth = new Set(both.graph.nodes.filter((n) => n.entry).map((n) => n.key))
	// 两边的节点必须一个不少地都在 —— 合并是并集，不是替换
	for (const key of [...keysOne, ...keysTwo]) check(keysBoth.has(key), `合并后少了节点 ${key}`)
	check(keysBoth.size === keysOne.size + keysTwo.size, `合并后节点数对不上：${keysBoth.size} ≠ ${keysOne.size} + ${keysTwo.size}`)

	// ⚠️ 合完是**两条链并排挂在同一个空根下**，不是接在某个节点后面。
	//    乙那棵的第一个节点，父亲必须还是根。
	const rootNode = both.graph.nodes.find((node) => node.parent === undefined)
	const firstOfTwo = both.graph.nodes.filter((node) => node.entry !== undefined && keysTwo.has(node.key)).sort((l, r) => l.depth - r.depth)[0]
	check(firstOfTwo !== undefined && firstOfTwo.parent === rootNode, '合进来那棵的头一个节点没挂在根上 —— 被接到别人后面去了')

	// 站在乙那边看到的应该是同一棵树
	const fromTwo = render(two.members[0], merged)
	check(fromTwo !== undefined && fingerprint(fromTwo.graph) === fingerprint(both.graph), '从被合并那一侧看过去，画出来的树不一样')

	// 拆回去 → 两边各自复原
	const split = reshape({ session: two.tree, group: '' })
	check(fingerprint(render(one.tree, split).graph) === fingerprint(soloOne.graph), '拆回去之后甲没复原')
	check(fingerprint(render(two.tree, split).graph) === fingerprint(soloTwo.graph), '拆回去之后乙没复原')
	console.log(`  甲 ${keysOne.size} 个节点 + 乙 ${keysTwo.size} 个 → 合并后 ${keysBoth.size} 个，同一个根；拆回去两边都复原`)
}

// ===== 第 6 步：场景 3 —— 连着合三条，再在合进来的那棵里分离 =====

console.log('场景 3：连着合三条 + 在合进来的那棵里分离，两套存储不许打架')
{
	const groups = [...treesOf({}).entries()]
		.map(([tree, members]) => ({ tree, members, nodes: members.reduce((sum, id) => sum + sessions.find((s) => s.id === id).turns.filter((t) => !t.inherited).length, 0) }))
		.filter((one) => one.nodes > 0)
		.sort((left, right) => right.nodes - left.nodes)
	check(groups.length >= 3, `只有 ${groups.length} 棵有内容的树，三条合并跑不起来`)
	const [one, two, three] = groups

	let shape = reshape({ session: two.tree, group: one.tree })
	shape = reshape({ session: three.tree, group: one.tree })
	const all = render(one.tree, shape)
	sane('三条合一', all.graph)

	const want = [one, two, three].reduce((sum, item) => sum + item.nodes, 0)
	const got = all.graph.nodes.filter((node) => node.entry !== undefined).length
	check(got === want, `三条合一后节点数对不上：${got} ≠ ${want}（有人掉队了）`)
	// 从任意一条看过去都该是同一棵
	for (const item of [two, three]) {
		const seen = render(item.members[0], shape)
		check(seen !== undefined && fingerprint(seen.graph) === fingerprint(all.graph), `从 ${item.tree.slice(8, 14)} 看过去不是同一棵树`)
	}

	// 在**合进来**的那棵里分离一个节点 —— groupOf 和 detached 是两套存储，不许互相打架
	const inTwo = all.graph.nodes.find((node) => node.canDetach === true && node.session !== undefined && two.members.includes(node.session.id))
	if (inTwo !== undefined) {
		const at = pure.cutPointOf(inTwo)
		shape = reshape({ session: at.key, detach: true })
		sane('合并后再分离', render(one.tree, shape).graph)
		shape = reshape({ session: at.key, detach: false })
		check(fingerprint(render(one.tree, shape).graph) === fingerprint(all.graph), '合并态下分离再接回，没复原')
		console.log(`  三条合一共 ${got} 个节点；在合进来那棵里剪 ${at.key} 再接回，复原`)
	} else {
		console.log(`  三条合一共 ${got} 个节点；（合进来那棵里没有能分离的节点，跳过后半段）`)
	}

	// 全拆回去
	shape = reshape({ session: two.tree, group: '' })
	shape = reshape({ session: three.tree, group: '' })
	check(treesOf(shape.groupOf).size === treesOf({}).size, '全拆回去之后树的条数和最初对不上')
}

fs.rmSync(lab, { recursive: true, force: true })
console.log(failures === 0 ? '\n✓ 全部断言通过' : `\n✗ ${failures} 条断言失败`)
process.exit(failures === 0 ? 0 : 1)
