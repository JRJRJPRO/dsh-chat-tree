/**
 * 删除 = 归档整条支线（tree.js 的 deletePlan / deleteBlockedWhy / escapeFrom）。
 *
 * 【导读】
 * 干嘛的：卡片上那颗「删除」按下去到底归档哪几条会话、哪些节点根本不许删、删的里头有
 * 正在看的那条时先切到哪儿去 —— 全是纯函数，这里把 BACKLOG T3 那张表逐行钉死。
 *
 * 阅读顺序：
 *   第1步  造一棵树：A 主干，B 从 A:2 岔出，C 从 B:3 岔出，D 从 B 的继承段岔出（图上挂在 A:2 底下），E 从 A:4 岔出且在跑
 *   第2步  用例 1：分支头能删，删的是它的会话 + 图上挂在它底下的子孙会话
 *   第3步  用例 2：会话中间 / 末尾的一轮、树根空节点 —— 删不了，说清楚为什么
 *   第4步  用例 3：所见即所删 —— 从继承段岔出去的、被拆到别的树上的，都不跟着没
 *   第5步  用例 4：正在跑的会话在名单里 → plan.running
 *   第6步  用例 5：删的里头有正在看的那条时，先切到哪儿
 *
 * 跑法：node tests/test-delete.mjs
 *
 * @module test-delete
 */

import { check, loadClientPure, report } from './test-kit.mjs'

const pure = await loadClientPure()
const { buildGraph, visibleTree, conversationOf, deletePlan, deleteBlockedWhy, escapeFrom } = pure

// ===== 第 1 步：造一棵树 =====

let clock = 0
function branch(id, parentId, forkTurn, turns, extra) {
	clock += 1
	return Object.assign({
		id, cwd: '/x', parentId, createdAt: clock, forkTurn, title: `会话${id}`,
		turns: [
			...Array.from({ length: forkTurn === undefined ? 0 : forkTurn }, (_, i) => ({ turn: i + 1, seq: (i + 1) * 10, endSeq: (i + 1) * 10 + 5, time: i + 1, prompt: `#${i + 1}`, compact: false, inherited: true, done: true })),
			...turns.map((turn) => ({ turn, seq: turn * 10, endSeq: turn * 10 + 5, time: turn, prompt: `第${turn}问`, compact: false, inherited: false, done: true })),
		],
	}, extra || {})
}

/**
 * A: 1-2-3-4；B 从 A:2 岔出自有 3,4；C 从 B:3 岔出自有 4,5；
 * D 从 B 的第 2 轮岔出 —— 那一轮 B 是继承来的，图上 D 挂在 A:2 底下，和 B 并排；
 * E 从 A:4 岔出自有 5，正在跑。
 */
function forest(cuts, current) {
	clock = 0
	const A = branch('A', undefined, undefined, [1, 2, 3, 4])
	const B = branch('B', 'A', 2, [3, 4])
	const C = branch('C', 'B', 3, [4, 5])
	const D = branch('D', 'B', 2, [3])
	const E = branch('E', 'A', 4, [5], { running: true })
	const sessions = [A, B, C, D, E]
	const visible = new Set(sessions.map((one) => one.id))
	const picked = conversationOf(visibleTree(sessions, visible), current || 'A')
	const graph = buildGraph(picked, current || 'A', cuts)
	const nodeOf = (key) => graph.nodes.find((node) => node.key === key)
	return { graph, nodeOf, root: graph.nodes[0] }
}

const { nodeOf, root } = forest()
check(root.kind === 'empty', '第一个节点该是树根空节点')
check(nodeOf('D:3') !== undefined && nodeOf('D:3').parent === nodeOf('A:2'), '前提：D 从 B 的继承段岔出，图上该挂在 A:2 底下')
check(nodeOf('C:4') !== undefined && nodeOf('C:4').parent === nodeOf('B:3'), '前提：C 该挂在 B:3 底下')

// ===== 第 2 步：用例 1 =====
console.log('用例 1：分支头能删，删的是它的会话 + 图上挂在它底下的子孙会话')
{
	const plan = deletePlan(nodeOf('B:3'))
	check(plan.blocked === undefined, `B:3 是分支头，该能删，实际 ${JSON.stringify(plan)}`)
	check(plan.sessions.join(',') === 'B,C', `删 B:3 该归档 B 和它底下的 C，实际 ${plan.sessions}`)
	check(plan.turns === 4, `B(3,4) + C(4,5) 合起来 4 轮，实际 ${plan.turns}`)
	check(plan.running === false, 'B、C 都没在跑')

	const all = deletePlan(nodeOf('A:1'))
	check(all.sessions[0] === 'A' && all.sessions.length === 5 && ['B', 'C', 'D', 'E'].every((id) => all.sessions.includes(id)), `删 A:1 该归档整棵树五条会话、A 排头，实际 ${all.sessions}`)
	check(all.turns === 10, `整棵树 4+2+2+1+1 = 10 轮，实际 ${all.turns}`)

	const leaf = deletePlan(nodeOf('D:3'))
	check(leaf.blocked === undefined && leaf.sessions.join(',') === 'D' && leaf.turns === 1, `D:3 是 D 的头一轮，删它只归档 D（1 轮），实际 ${JSON.stringify(leaf)}`)
	check(deleteBlockedWhy(nodeOf('B:3')) === '', '能删的节点 deleteBlockedWhy 给空串')
}

// ===== 第 3 步：用例 2 =====
console.log('用例 2：会话中间 / 末尾的一轮、树根空节点 —— 删不了，说清楚为什么')
{
	const mid = deletePlan(nodeOf('A:2'))
	check(typeof mid.blocked === 'string' && mid.blocked !== '', 'A:2 是 A 的中间一轮，删不了半截')
	check(mid.blocked.includes('撤回'), `理由要把人指到撤回那条路上去，实际「${mid.blocked}」`)
	check(mid.sessions === undefined, '删不了就不给名单')
	const tail = deletePlan(nodeOf('A:4'))
	check(typeof tail.blocked === 'string' && tail.blocked !== '', 'A:4 是 A 的末尾一轮但不是分支头，同样删不了')
	const last = deletePlan(nodeOf('B:4'))
	check(typeof last.blocked === 'string' && last.blocked !== '', 'B:4 是 B 的末尾一轮，删不了')
	const empty = deletePlan(root)
	check(typeof empty.blocked === 'string' && empty.blocked.includes('空节点'), `树根空节点删不了，理由要说它是空节点，实际「${empty.blocked}」`)
	check(deleteBlockedWhy(nodeOf('A:2')) === mid.blocked, 'deleteBlockedWhy 给的就是 plan.blocked')
	check(typeof deletePlan(undefined).blocked === 'string' && typeof deletePlan(null).blocked === 'string', '没有节点也不许炸')
}

// ===== 第 4 步：用例 3 =====
console.log('用例 3：所见即所删 —— 从继承段岔出去的、被拆到别的树上的，都不跟着没')
{
	// D 的 parentId 是 B，但图上挂在 A:2 底下：删 B 不该把 D 带走（用例 1 已经核了 B,C）
	check(!deletePlan(nodeOf('B:3')).sessions.includes('D'), 'D 按血缘是 B 的孩子，但图上和 B 并排，删 B 不该带走 D')
	// 把 C 拆到别的树上：站在 A 这棵上，C 已经不在图里，删 B 就只剩 B
	const cut = forest(new Set(['C:4']))
	check(cut.nodeOf('C:4') === undefined, '前提：C:4 被拆出去后不在这张图里')
	const plan = deletePlan(cut.nodeOf('B:3'))
	check(plan.sessions.join(',') === 'B' && plan.turns === 2, `C 拆到别的树上之后，删 B 只归档 B（2 轮），实际 ${JSON.stringify(plan)}`)
}

// ===== 第 5 步：用例 4 =====
console.log('用例 4：名单里有正在跑的会话 → plan.running，确认文案据此多说一句')
{
	const own = deletePlan(nodeOf('E:5'))
	check(own.sessions.join(',') === 'E' && own.running === true, `E 在跑，删它 running 该为 true，实际 ${JSON.stringify(own)}`)
	check(deletePlan(nodeOf('A:1')).running === true, '整棵树里有一条在跑，running 也该为 true')
	check(deletePlan(nodeOf('B:3')).running === false, 'B、C 没在跑，running 该为 false')
}

// ===== 第 6 步：用例 5 =====
console.log('用例 5：删的里头有正在看的那条时，先切到哪儿去')
{
	const b3 = nodeOf('B:3')
	check(escapeFrom(b3, deletePlan(b3), ['Z']) === 'A', '删 B 时先切到岔出来的那条（A）')
	const c4 = nodeOf('C:4')
	check(escapeFrom(c4, deletePlan(c4), ['Z']) === 'B', '删 C 时先切到 B')
	const a1 = nodeOf('A:1')
	const whole = deletePlan(a1)
	check(escapeFrom(a1, whole, ['A', 'B', 'Z']) === 'Z', '整棵树都删时父链上没有可去的，从别的会话里挑第一个不在名单里的')
	check(escapeFrom(a1, whole, ['A', 'B']) === undefined, '实在没地方去就 undefined，交给宿主')
	check(escapeFrom(a1, whole, undefined) === undefined, '没给候选也不炸')
}

report()
