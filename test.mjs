/**
 * dsh-tree 离线测试 —— 拿**真实会话日志**跑通整条渲染管线并断言。
 *
 * 【导读】
 * 干嘛的：不用开浏览器、不用手点，直接验证"树画出来是什么形状"。
 * 之前每一轮 bug 都是靠 John 手动点出来的，这个脚本就是来终结那件事的。
 *
 * 数据流一句话：
 *   盘上的 session.v3.jsonl.zstd
 *   → host 的 foldOutline（真代码，不是复制品）
 *   → 拼成 /outlines 路由的响应体
 *   → client 的 visibleTree / conversationOf / layout（真代码，从 __pure 出口取）
 *   → 打印 ASCII 树 + 跑断言
 *
 * 用法：node test.mjs            跑全部断言，失败退出码非 0
 *       node test.mjs --print    额外打印每个视角下的树
 *
 * 阅读顺序：
 *   第1步  读盘：解多 frame zstd
 *   第2步  取 client 的纯函数（用假 ModuleLoader + 假 react 骗它加载）
 *   第3步  组装场景
 *   第4步  断言
 */

import fs from 'node:fs'
import zlib from 'node:zlib'
import path from 'node:path'
import { foldOutline } from './index.js'

const HOME = process.env.DSH_HOME || 'E:/Programs/deepseek-harness/home'
const PRINT = process.argv.includes('--print')

// ===== 第 1 步：读盘 =====

/**
 * 解一个 session 文件。
 *
 * v3 是**多 frame 拼接**的 zstd（每次 flush 追加一个独立 frame），
 * Node 的 zstdDecompressSync 只解第一个就停且不报错 —— 所以必须自己扫 frame 头逐个解。
 * @param file - 绝对路径
 * @returns 事件数组
 */
function readSession(file) {
	const buffer = fs.readFileSync(file)
	const parts = []
	for (let i = 0; i + 4 <= buffer.length; i += 1) {
		if (buffer.readUInt32LE(i) === 0xfd2fb528) {
			try {
				parts.push(zlib.zstdDecompressSync(buffer.subarray(i)))
			} catch {
				/* 不是真的 frame 头，跳过 */
			}
		}
	}
	return Buffer.concat(parts)
		.toString('utf8')
		.split('\n')
		.filter(Boolean)
		.map((line) => {
			try {
				return JSON.parse(line)
			} catch {
				return null
			}
		})
		.filter(Boolean)
}

/**
 * 模拟 host 的 /outlines 路由：把盘上的会话折成响应体。
 * @param cwdFilter - 只要这个工作目录；空表示全要
 * @returns {sessions, archived}
 */
function collect(cwdFilter) {
	const root = path.join(HOME, 'sessions')
	const sessions = []
	for (const bucket of fs.readdirSync(root)) {
		for (const dir of fs.readdirSync(path.join(root, bucket))) {
			const file = path.join(root, bucket, dir, 'session.v3.jsonl.zstd')
			if (!fs.existsSync(file)) continue
			const events = readSession(file)
			const header = events[0] || {}
			if (cwdFilter && header.cwd !== cwdFilter) continue
			const outline = foldOutline(events)
			sessions.push({
				id: header.id,
				cwd: header.cwd,
				parentId: header.parentSession,
				createdAt: header.createdAt,
				title: outline.title,
				forkTurn: outline.forkTurn,
				model: outline.model,
				turns: outline.turns,
			})
		}
	}
	sessions.sort((left, right) => (left.createdAt || 0) - (right.createdAt || 0))
	const workspace = JSON.parse(fs.readFileSync(path.join(HOME, 'storages', 'workspace.json'), 'utf8'))
	return { sessions, archived: new Set(workspace.global.archivedSessionIds || []) }
}

// ===== 第 2 步：取 client 的纯函数 =====

/**
 * 加载 client.js 并把它的纯函数取出来。
 *
 * client.js 是给浏览器的 `window.__ModuleLoader__.load({factory})` 格式，
 * 这里塞一个假的 loader 和假的 react/react-dom，让 factory 跑完，
 * 然后从 `exports.__pure` 拿纯函数 —— **测的是真代码，不是复制品**。
 * @returns client.js 的 __pure 出口
 */
async function loadClientPure() {
	const fakeReact = new Proxy({}, { get: () => () => undefined })
	let pure
	globalThis.window = {
		__ModuleLoader__: {
			load: (definition) => {
				const exported = definition.factory((name) => (name === 'react' ? fakeReact : { createPortal: () => null }))
				pure = exported.__pure
			},
		},
	}
	globalThis.localStorage = { getItem: () => '{}', setItem: () => {} }
	globalThis.document = { querySelector: () => null, head: { appendChild: () => {} }, createElement: () => ({ dataset: {}, remove: () => {} }) }
	await import('./client.js')
	if (pure === undefined) throw new Error('client.js 没有导出 __pure，测试无法进行')
	return pure
}

// ===== 第 3 步：组装场景并渲染 =====

/**
 * 站在某个会话的视角建一次图。
 * @returns {graph, sessions} 或 undefined（该会话不可见）
 */
function render(pure, all, archived, currentId) {
	const visible = new Set(all.filter((item) => !archived.has(item.id)).map((item) => item.id))
	if (!visible.has(currentId)) return undefined
	const picked = pure.conversationOf(pure.visibleTree(all, visible), currentId)
	if (picked.length === 0) return undefined
	return { graph: pure.buildGraph(picked, currentId), sessions: picked }
}

/**
 * 画成二维 ASCII 图：列 0 在最右（= 主路径），深度往下。
 * 这样一眼就能看出"同一岔路分出去的两个节点是不是同高度"。
 */
function draw(result, currentId) {
	const { graph } = result
	console.log(`--- 视角：${currentId.slice(8, 16)} ---`)
	const width = graph.maxColumn + 1
	for (let depth = 0; depth <= graph.maxDepth; depth += 1) {
		const cells = new Array(width).fill('     ')
		let note = ''
		for (const node of graph.nodes) {
			if (node.depth !== depth) continue
			const mark = node.kind === 'empty' ? '◌' : node.active ? '●' : '○'
			cells[node.column] = `${mark}${String(node.no || '').padStart(2)} `.padEnd(5)
			if (node.entry) note += `  ${node.session.id.slice(8, 14)}#${node.entry.turn} ${JSON.stringify(String(node.entry.prompt).slice(0, 14))}`
		}
		// 列 0 在最右
		console.log(String(depth).padStart(2), cells.slice().reverse().join(''), note)
	}
}

// ===== 第 4 步：断言 =====

let failures = 0

/** @param ok - 条件 @param message - 失败信息 */
function check(ok, message) {
	if (ok) return
	failures += 1
	console.log('  ✗', message)
}

async function main() {
	let inheritedLit = 0
	const pure = await loadClientPure()
	const { sessions, archived } = collect('')
	console.log(`读到 ${sessions.length} 个会话，其中 ${sessions.filter((s) => archived.has(s.id)).length} 个已归档\n`)

	for (const session of sessions) {
		if (archived.has(session.id)) continue
		const result = render(pure, sessions, archived, session.id)
		if (result === undefined) continue
		if (PRINT) draw(result, session.id)

		const tag = session.id.slice(8, 16)
		const nodes = result.graph.nodes

		// 断言 1：同一个 (会话, 轮次) 不能出现两次（抓"继承前缀被重复画"）
		const seen = new Set()
		for (const node of nodes) {
			if (node.entry === undefined) continue
			check(!seen.has(node.key), `[${tag}] 节点重复：${node.key}`)
			seen.add(node.key)
		}

		// 断言 2：不能画出继承来的轮次（那些属于父分支）
		for (const node of nodes) {
			if (node.entry === undefined) continue
			check(node.entry.inherited !== true, `[${tag}] 画出了继承轮 ${node.key}`)
		}

		// 断言 3：depth 必须是父 + 1（y 轴就是树深度）
		for (const node of nodes) {
			if (node.parent === undefined) continue
			check(node.depth === node.parent.depth + 1, `[${tag}] depth 不连续：${node.key}`)
		}

		// 断言 4：同一会话的延续必须留在父节点那一列（于是每条分支自己是一条直线）
		for (const node of nodes) {
			if (node.parent === undefined) continue
			if (node.session.id !== node.parent.session.id) continue
			check(node.column === node.parent.column, `[${tag}] 同分支却换了列：${node.key}`)
		}

		// 断言 5：图上不能有两个节点叠在一起，兄弟之间必须分到不同的列。
		//
		// 这条原本写的是"换了会话就必须换列"，**太严了**：如果在某个点上父分支自己
		// 没有后续、只有一条分支接下去，那条分支走直线才对——John 早就说过
		// "没出现岔路的情况下不许拐弯"。真正该守的是"不重叠"和"兄弟不同列"。
		const occupied = new Map()
		for (const node of nodes) {
			const cell = `${node.column},${node.depth}`
			check(!occupied.has(cell), `[${tag}] 两个节点叠在同一格 (${cell})：${node.key} 和 ${occupied.get(cell)}`)
			occupied.set(cell, node.key)
		}
		for (const node of nodes) {
			const columns = node.children.map((kid) => kid.column)
			check(new Set(columns).size === columns.length, `[${tag}] ${node.key} 的几个孩子挤在同一列：${columns}`)
		}

		// 断言 5b：**连线不许从任何别的节点身上压过去**。
		//
		// 这是 John 报的"1-2-3，在 2 后面加 4，图上看着像经过 3 再拐到 4"。
		// client.js 里这条边画成「先横后竖」：从父节点横向挪到自己那一列，再往下走。
		// 这里按同样的走法把线经过的格子列出来，逐个确认没踩到别的节点。
		// （画成「先竖后横」的话，2→4 那条竖线的终点正好落在节点 3 上，这条会当场炸。）
		for (const node of nodes) {
			if (node.parent === undefined) continue
			const cells = []
			if (node.column === node.parent.column) {
				for (let depth = node.parent.depth + 1; depth < node.depth; depth += 1) cells.push(`${node.column},${depth}`)
			} else {
				const lo = Math.min(node.column, node.parent.column)
				const hi = Math.max(node.column, node.parent.column)
				for (let column = lo + 1; column < hi; column += 1) cells.push(`${column},${node.parent.depth}`) // 横段
				for (let depth = node.parent.depth; depth < node.depth; depth += 1) cells.push(`${node.column},${depth}`) // 竖段
			}
			for (const cell of cells) {
				check(!occupied.has(cell), `[${tag}] ${node.parent.key} → ${node.key} 的连线压过了节点 ${occupied.get(cell)}（格 ${cell}）`)
			}
		}

		// 断言 5c：＋ 按钮的动作。
		//
		// John 报的："线性的 1-2-3，我在 3 上点 ＋ 接着问，左边却多出一份只有 1-2-3 的副本。"
		// 3 后面什么都没有，复制一份毫无意义 —— 应该直接在原会话往下问。
		for (const node of nodes) {
			const action = pure.branchAction(node)
			if (node.entry === undefined) {
				// 空节点代表"对话开始之前"。底下已经有分支了，＋ 才是"再开一条新对话"；
				// 光秃秃的空节点（刚建的对话）本身就是那条空对话，再开一条只是复制粘贴。
				const want = node.children.length === 0 ? 'none' : 'fresh'
				check(action === want, `[${tag}] 空节点(${node.children.length} 个子节点)的 ＋ 应当是 ${want}，得到 ${action}`)
			} else if (node.children.length === 0) {
				check(action === 'open', `[${tag}] 叶子节点 ${node.key} 的 ＋ 不该复制会话，应当就地接着问，得到 ${action}`)
			} else {
				check(action === 'fork', `[${tag}] 有后续的节点 ${node.key} 的 ＋ 必须真的开岔路，得到 ${action}`)
			}
		}

		// 断言 5d：**点当前路径上的节点，绝不能换会话**。
		//
		// John 报的："路径是 1-2-6-7-8，我点一下 2，高亮整条换成了 1-2-3-4-5。"
		// 根因是无脑切到"这个节点所属的会话"，而节点 2 属于父会话。
		// 换了会话 = 换了当前路径 = 一大半节点变白，跟滚动没关系。
		for (const node of nodes) {
			if (node.entry === undefined) continue
			const target = pure.jumpTarget(node, session.id)
			if (node.active) check(target === session.id, `[${tag}] 点路径上的 ${node.key} 不该换会话，却要跳到 ${String(target).slice(8, 20)}`)
			else check(target === node.session.id, `[${tag}] 点路径外的 ${node.key} 必须切到它自己的会话，得到 ${String(target).slice(8, 20)}`)
		}

		// 断言 5e：**不管滑到哪一轮，路径上都必须恰好亮一个点**。
		//
		// John 报的"亮蓝色的逻辑不对"：以前还要求节点属于当前会话，
		// 可继承来的那几轮画在图上的是**父会话的节点**，于是往上滑到继承段时
		// 一个点都不亮。这里把路径上每一个轮次号都当作"滑到了这儿"试一遍。
		const onPath = nodes.filter((node) => node.entry !== undefined && node.active)
		const turnsOnPath = onPath.map((node) => node.entry.turn)
		check(new Set(turnsOnPath).size === turnsOnPath.length, `[${tag}] 路径上轮次号有重复（会同时亮两个点）：${turnsOnPath}`)
		for (const turn of turnsOnPath) {
			const lit = nodes.filter((node) => pure.isFocusedNode(node, turn))
			check(lit.length === 1, `[${tag}] 滑到第 ${turn} 轮时应当恰好亮 1 个点，实际亮了 ${lit.length} 个`)
		}
		// 路径之外的节点永远不该亮
		for (const node of nodes) {
			if (node.entry === undefined || node.active) continue
			check(!pure.isFocusedNode(node, node.entry.turn), `[${tag}] 路径外的 ${node.key} 不该被点亮`)
		}
		// 路径上那些**属于祖先会话**的节点（= 当前会话继承来的那几轮）同样要能亮。
		// 旧判据多要求 `node.session.id === current`，正是把这些漏掉了。
		for (const node of onPath) {
			if (node.session.id === session.id) continue
			inheritedLit += 1
			check(pure.isFocusedNode(node, node.entry.turn), `[${tag}] 继承来的 ${node.key} 滑到时也必须亮（旧判据就是漏了这些）`)
		}

		// 主路径必须连续：每个 active 节点的父亲也 active（根除外）
		for (const node of nodes) {
			if (!node.active || node.parent === undefined) continue
			check(node.parent.active, `[${tag}] 主路径断了：${node.key} 的父亲不在主路径上`)
		}

		// 断言 6：同一个父节点的兄弟们必须同深度（"两个 3 应该并排"）
		for (const node of nodes) {
			const kids = node.children
			for (const kid of kids) check(kid.depth === node.depth + 1, `[${tag}] 兄弟不同高：${kid.key}`)
		}

		// 断言 7：归档会话绝不出现
		for (const node of nodes) check(!archived.has(node.session.id), `[${tag}] 画出了已归档会话 ${node.session.id.slice(8, 14)}`)

		// 断言 8：全局编号唯一且连续
		const numbers = nodes.filter((n) => n.entry !== undefined).map((n) => n.no).sort((x, y) => x - y)
		numbers.forEach((value, index) => check(value === index + 1, `[${tag}] 全局编号不连续：第 ${index + 1} 个是 ${value}`))
	}

	// 断言 9：**图的形状与"当前在哪条分支"无关**。
	// John 明确说过"树一直换来换去体感不好"，所以这条是硬约束：
	// 同一棵树从任意两个视角建图，每个节点的 (column, depth) 必须完全一致。
	const groups = new Map()
	for (const session of sessions) {
		if (archived.has(session.id)) continue
		const result = render(pure, sessions, archived, session.id)
		if (result === undefined) continue
		const rootId = result.sessions.find((item) => item.parentId === undefined)
		const key = rootId ? rootId.id : session.id
		const shape = new Map()
		for (const node of result.graph.nodes) shape.set(node.key, `${node.column},${node.depth}`)
		const known = groups.get(key)
		if (known === undefined) {
			groups.set(key, { from: session.id, shape })
			continue
		}
		for (const [nodeKey, value] of shape) {
			check(
				known.shape.get(nodeKey) === value,
				`布局随当前分支变了：${nodeKey} 从 ${known.from.slice(8, 14)} 视角是 ${known.shape.get(nodeKey)}，从 ${session.id.slice(8, 14)} 视角是 ${value}`,
			)
		}
	}

	check(inheritedLit > 0, `数据里没有"路径上属于祖先会话"的节点，这条断言等于没测（实际 ${inheritedLit} 个）`)
	console.log(`路径上共 ${inheritedLit} 个继承来的节点，滑到时都会亮`)

	// 断言 10：压缩标记只认**成功**的压缩。
	//
	// 盘上目前一条原生压缩都没有（用 dsh-claude 时 /compact 发生在 Claude Code 里，
	// dsh 的日志和 sidecar 都不记），所以这条只能合成。宿主的校验器写明：成功的
	// compaction/end 必须配一条 compaction/summary，失败的那条带 `error`。
	{
		const at = (seq, type, data) => ({ seq, type, time: seq, data })
		const base = [
			at(1, 'turn/start', { turn: 1 }), at(2, 'turn/end', { turn: 1 }),
			at(3, 'turn/start', { turn: 2 }), at(4, 'turn/end', { turn: 2 }),
			at(5, 'turn/start', { turn: 3 }), at(6, 'turn/end', { turn: 3 }),
		]
		const ok = foldOutline([...base, at(7, 'compaction/end', { turn: 2 })])
		const bad = foldOutline([...base, at(7, 'compaction/end', { turn: 2, error: 'context window exceeded' })])
		const marks = (outline) => outline.turns.filter((entry) => entry.compact).map((entry) => entry.turn)

		check(JSON.stringify(marks(ok)) === '[2]', `成功的压缩该只标第 2 轮，实际 ${JSON.stringify(marks(ok))}`)
		check(marks(bad).length === 0, `压缩失败了却还是标了 ${JSON.stringify(marks(bad))} —— 明明什么都没压掉`)
		console.log('压缩标记：成功的标在 owner 轮上，失败的一个都不标')
	}
	console.log(failures === 0 ? '\n✓ 全部断言通过' : `\n✗ ${failures} 条断言失败`)
	process.exit(failures === 0 ? 0 : 1)
}

main().catch((error) => {
	console.error(error)
	process.exit(1)
})
