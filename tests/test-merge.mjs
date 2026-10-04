/**
 * dsh-chat-tree —— 合并 / 接回来的用例。
 *
 * 【导读】
 * 干嘛的：分离（⇥）一直是单向的，拆出去就回不来；两条独立的对话也只能在创建那一刻
 * 登记进同一棵树，事后没办法并。这两件事补上之后要钉住的边界。
 *
 * 两种"合并"，走的是两套存储，别搞混：
 *   · **接回去**（`detached`）—— 撤销一次分离。剪缝看得见，接回哪儿是确定的。
 *   · **合并**（`groupOf`）—— 两棵互不相干的树并成一棵。
 *     不需要指定"接到哪个节点"：两棵树的节点互不相同，合完就是两条链并排挂在同一个
 *     空根下，**只要知道是哪两棵树，结果就唯一确定**。
 *
 * 阅读顺序：
 *   第1步  取两半的真函数 + 一个临时 DSH_HOME（reshape 要落盘）
 *   第2步  用例 1：接回去 = 撤销分离，且剪点标记对得上按钮
 *   第3步  用例 2：合并可传递 —— A 合进 B、再把 B 合进 C，A 不许掉队
 *   第4步  用例 3：挑单子（列树不列节点、已合进来的能拆回去）
 *   第5步  用例 4：在跑就不让合并，并把原因写在单子里
 *   第6步  用例 5：拆出去的树，前缀上开的分支要认领（issue #4）
 *
 * 跑法：node tests/test-merge.mjs
 *
 * @module test-merge
 */

import { check, loadClientPure, report } from './test-kit.mjs'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'


// ===== 第 1 步：取两半的真函数 =====

// reshape 直接读写 $DSH_HOME/plugins/dsh-chat-tree/shape.json，先把家挪到临时目录
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-chat-tree-merge-'))
process.env.DSH_HOME = home

const { reshape } = await import('../index.js')

const pure = await loadClientPure()

let clock = 0

/**
 * 捏一条分支。
 * @param id - 会话 id
 * @param parentId - 父会话 id
 * @param forkTurn - 从父分支第几轮岔出来
 * @param turns - 自有轮次号
 * @param title - 对话标题
 * @returns 一条 /outlines 里的会话记录
 */
function branch(id, parentId, forkTurn, turns, title) {
	clock += 1
	return {
		id,
		cwd: '/x',
		parentId,
		createdAt: clock,
		forkTurn,
		title,
		turns: [
			...Array.from({ length: forkTurn === undefined ? 0 : forkTurn }, (_, i) => ({ turn: i + 1, seq: (i + 1) * 10, time: i + 1, prompt: `#${i + 1}`, inherited: true })),
			...turns.map((turn) => ({ turn, seq: turn * 10, time: turn, prompt: `#${turn}`, inherited: false })),
		],
	}
}

/**
 * 站在 `currentId` 的视角，这棵树里有哪些会话。
 * @param sessions - 全部分支
 * @param currentId - 当前会话
 * @param groupOf - 登记表
 * @returns 会话 id，已排序
 */
function treeAt(sessions, currentId, groupOf) {
	return pure
		.conversationOf(pure.visibleTree(sessions, new Set(sessions.map((item) => item.id))), currentId, groupOf)
		.map((item) => item.id)
		.sort()
		.join('+')
}

// ===== 第 2 步：接回去 =====

console.log('用例 1：接回去 = 撤销一次分离')
{
	// 1-2-{3-5, 4-6}：在 6 上按分离，剪点是 4（见 cutPointOf），新树 = 1-2-4-6
	const sessions = [branch('M', undefined, undefined, [1, 2, 3, 4, 5, 6], '主对话')]

	const whole = pure.buildGraph(sessions, 'M', new Set())
	const byKey = new Map(whole.nodes.map((node) => [node.key, node]))
	check(whole.nodes.every((node) => node.cut !== true), '什么都没剪的时候不该有剪缝标记')

	// 线性树上剪点只能是最顶上那个能剪的节点；直接指定一个剪点来验形状
	const cut = pure.buildGraph(sessions, 'M', new Set(['M:4']))
	const cutKeys = cut.nodes.filter((node) => node.cut === true).map((node) => node.key)
	check(JSON.stringify(cutKeys) === '["M:4"]', `剪缝该正好标在 M:4 上，实际 ${JSON.stringify(cutKeys)}`)
	// ⚠️ 标记必须落在**剪点**上，不是它父亲、也不是整棵子树 —— 按钮是照着这个标记画的，
	//    标歪了就会出现"按钮在别的节点上"或者"一串节点都冒出接回按钮"
	const marked = cut.nodes.filter((node) => node.cut === true)
	check(marked.length === 1, `接回按钮只该出现一个，实际 ${marked.length} 个`)
	check(byKey.get('M:4') !== undefined, '用例前提坏了：M:4 本来就该在图上')

	// 落盘那一半：分离 → 接回去，shape.json 要回到原样
	const after = reshape({ session: 'M:4', detach: true })
	check(after.detached.includes('M:4'), '分离没记进去')
	const back = reshape({ session: 'M:4', detach: false })
	check(!back.detached.includes('M:4'), '接回去没把分离记录销掉')
	console.log(`  剪缝标在 ${cutKeys.join('')}；分离→接回后 detached=${JSON.stringify(back.detached)}`)
}

// ===== 第 3 步：合并要可传递 =====

console.log('用例 2：合并两次，先合进来的那条不许掉队')
{
	const sessions = [branch('A', undefined, undefined, [1], '甲'), branch('B', undefined, undefined, [1], '乙'), branch('C', undefined, undefined, [1], '丙')]

	check(treeAt(sessions, 'A', {}) === 'A', '什么都没合并时 A 该自成一棵')

	// ① A 合进 B
	const one = reshape({ session: 'A', group: 'B' })
	check(treeAt(sessions, 'A', one.groupOf) === 'A+B', `A 合进 B 后该同树，实际 ${treeAt(sessions, 'A', one.groupOf)}`)

	// ② 再把 B 合进 C —— A 必须跟着过去
	//
	// ⚠️ 这条是 `treeOf` 只查**一跳**（`groupOf[root] || root`）留下的坑：不在写入时
	//    把指着 B 的人一起改指到 C，就会变成 A→A、B→B+C —— 先合进来的 A 无声无息掉出去。
	//    实测过：`{A:'B', B:'C'}` 下 A 确实单独成树。
	const two = reshape({ session: 'B', group: 'C' })
	check(two.groupOf.A === 'C', `A 该被一起改指到 C，实际 ${JSON.stringify(two.groupOf)}`)
	check(treeAt(sessions, 'A', two.groupOf) === 'A+B+C', `三条该在一棵树里，实际 ${treeAt(sessions, 'A', two.groupOf)}`)
	check(treeAt(sessions, 'C', two.groupOf) === 'A+B+C', `从 C 看过去也该是三条，实际 ${treeAt(sessions, 'C', two.groupOf)}`)

	// ③ 存盘里的值恒为"终点"（不再是别人的 key），这样拆回去才是 O(1) 的删一条
	for (const [key, value] of Object.entries(two.groupOf)) {
		check(two.groupOf[value] === undefined, `${key}→${value} 指向了另一个 key，分组链没压平`)
	}

	// ④ 拆回去
	const out = reshape({ session: 'A', group: '' })
	check(treeAt(sessions, 'A', out.groupOf) === 'A', `拆回去后 A 该自成一棵，实际 ${treeAt(sessions, 'A', out.groupOf)}`)
	check(treeAt(sessions, 'B', out.groupOf) === 'B+C', `B 和 C 不该被牵连，实际 ${treeAt(sessions, 'B', out.groupOf)}`)

	// ⑤ 自环：谁都不许指着自己。空表下"合并到自己"就是取消；
	//    已经并在别人树里时，"合并到自己"解析成它当前那棵树，等于没动。
	const self = reshape({ session: 'Z', group: 'Z' })
	check(self.groupOf.Z === undefined, '空表下合并到自己该当成取消')
	const already = reshape({ session: 'B', group: 'B' })
	check(already.groupOf.B !== 'B', '写出了 B→B 的自环')
	check(already.groupOf.B === 'C', `B 本来就在 C 那棵树里，该原样不动，实际 ${already.groupOf.B}`)

	// ⑥ 手改坏的 shape.json 不许把写入这一步挂死 —— settleGroup 沿着链走，必须有 guard
	const shapeFile = path.join(home, 'plugins', 'dsh-chat-tree', 'shape.json')
	fs.writeFileSync(shapeFile, JSON.stringify({ version: 1, groupOf: { X: 'Y', Y: 'X' }, detached: [] }))
	const healed = reshape({ session: 'W', group: 'X' })
	check(typeof healed.groupOf.W === 'string', '环形的登记表把合并写挂了')
	console.log('  A→B→C 之后三条同树；拆掉 A 不牵连 B/C；自环和环形登记表都挡住了')
}

// ===== 第 4 步：挑单子 =====

console.log('用例 3：挑单子列的是树，不是节点')
{
	// 甲：P 和它的分支 Q（同一棵树）；乙：R；丙：S
	const sessions = [
		branch('P', undefined, undefined, [1, 2], '甲'),
		branch('Q', 'P', 2, [3], '甲的分支'),
		branch('R', undefined, undefined, [1], '乙'),
		branch('S', undefined, undefined, [1, 2, 3], '丙'),
	]
	const visible = pure.visibleTree(sessions, new Set(sessions.map((item) => item.id)))

	const list = pure.mergeTargets(visible, 'P', {})
	check(list.length === 2, `该列出乙和丙两棵树，实际 ${list.length} 项：${JSON.stringify(list.map((one) => one.title))}`)
	// ⚠️ 一棵树只出现一次。按会话列的话，分支多的对话会在单子里刷屏，
	//    而且点哪一条都是同一个结果 —— 用户没法理解为什么有两行"甲的分支"
	check(list.every((one) => one.tree !== 'P' && one.tree !== 'Q'), '自己这棵树不该出现在"可以合并"里')
	check(list.some((one) => one.title === '乙') && list.some((one) => one.title === '丙'), `标题对不上：${JSON.stringify(list.map((one) => one.title))}`)
	check(list.find((one) => one.title === '丙').turns === 3, '轮数统计不对')
	check(list.every((one) => one.joined !== true), '什么都没合并时不该有"已合进来"的项')

	// 从有分支的那棵树看过去，单子不变（合并是整棵树对整棵树的）
	const fromQ = pure.mergeTargets(visible, 'Q', {})
	check(JSON.stringify(fromQ.map((one) => one.tree)) === JSON.stringify(list.map((one) => one.tree)), '站在分支上看到的单子该和站在主干上一样')

	// 合进来之后：乙从"可以合并"变成"已合进来"，能原路拆回去
	const merged = pure.mergeTargets(visible, 'P', { R: 'P' })
	const joined = merged.filter((one) => one.joined === true)
	check(joined.length === 1 && joined[0].title === '乙', `乙该变成"已合进来"，实际 ${JSON.stringify(merged.map((one) => [one.title, one.joined === true]))}`)
	check(merged.filter((one) => one.joined !== true).length === 1, '丙还该留在"可以合并"里')
	check(joined[0].root === 'R', '拆回去要发回被合并那棵树的树根会话')
	// 合进来的对话，它的分支/轮次已经在树里了，不该再出现在"可以合并"里
	check(!merged.some((one) => one.joined !== true && one.tree === 'R'), '乙同时出现在两边了')
	console.log(`  可以合并：${list.map((one) => `${one.title}(${one.turns}轮)`).join(' / ')}；合进来之后变成 ⊖`)
}

// ===== 第 5 步：在跑就不让合并 =====

console.log('用例 4：有一头还在跑就不让合并，并说明原因')
{
	const sessions = [
		branch('P', undefined, undefined, [1, 2], '甲'),
		branch('Q', 'P', 2, [3], '甲的分支'),
		branch('R', undefined, undefined, [1], '乙'),
		branch('S', undefined, undefined, [1], '丙'),
	]
	const visible = (list) => pure.visibleTree(list, new Set(list.map((item) => item.id)))
	const find = (list, title) => list.find((one) => one.title === title)

	// 谁都没跑 → 都能合
	const calm = pure.mergeTargets(visible(sessions), 'P', {})
	check(calm.every((one) => one.blocked === ''), `谁都没跑却拦着：${JSON.stringify(calm.map((one) => one.blocked))}`)

	// 乙在跑 → 只拦乙，丙照常
	const theirs = sessions.map((item) => (item.id === 'R' ? Object.assign({}, item, { running: true }) : item))
	const one = pure.mergeTargets(visible(theirs), 'P', {})
	check(find(one, '乙').blocked === '这条对话还在运行，跑完再合', `乙该被拦下，实际 ${JSON.stringify(find(one, '乙').blocked)}`)
	check(find(one, '丙').blocked === '', '丙没在跑，不该被牵连')

	// ⚠️ 在跑的是**对方那棵树里的分支**（不是树根）也要拦住：整棵树是一起并过来的，
	//    只看树根的话，跑着的那条分支照样会被顺手带进来。
	const kid = [
		branch('T', undefined, undefined, [1], '丁'),
		Object.assign(branch('U', 'T', 1, [2], '丁的分支'), { running: true }),
	]
	const deep = pure.mergeTargets(visible([...sessions, ...kid]), 'P', {})
	check(find(deep, '丁').blocked !== '', '对方树里有分支在跑，却还让合')

	// 自己这边在跑 → 整张单子都拦住，原因不一样
	const mine = sessions.map((item) => (item.id === 'Q' ? Object.assign({}, item, { running: true }) : item))
	const self = pure.mergeTargets(visible(mine), 'P', {})
	check(self.every((one) => one.blocked === '当前对话还在运行，跑完再合'), `当前树在跑该整张拦下，实际 ${JSON.stringify(self.map((one) => one.blocked))}`)

	// 两边都在跑
	check(pure.blockedWhy(true, true) === '两边都还在运行，跑完再合', '两边都在跑时该说清楚是两边')
	check(pure.blockedWhy(false, false) === '', '都空闲却给了原因')

	// 拦下的那条**要留在单子里**：直接不显示的话，用户只会觉得"我那条对话怎么不见了"
	check(one.length === calm.length, `拦下的条目被从单子里删掉了：${one.length} vs ${calm.length}`)
	console.log(`  乙在跑 → "${find(one, '乙').blocked}"；自己在跑 → 整张单子拦下；被拦的仍留在单子里`)
}

// ===== 第 6 步：用例 5 —— 在拆出去那棵树的前缀上开分支，要认领 =====

console.log('\n用例 5：拆出去的树，前缀上开的分支不许掉回旧树（youli42 报的 issue #4）')
{
	// 主干 M 自有 1,2,6；P 从 M 的第 1 轮岔出，自有 3。图：root → M:1 → {M:2 → M:6, P:3}
	// 在 M:2 上分离：新树 = 1-2-6（前缀 1 照抄），旧树 = 1-3。
	const M = branch('M', undefined, undefined, [1, 2, 6], '主干')
	const P = branch('P', 'M', 1, [3], '旁支')
	// 站在新树上、在前缀节点 M:1 上按 ＋：dsh 从 M 的第 1 轮 fork 出 N，N 自有第 7 轮。
	// N 的父亲是 M、岔路点在前缀段 —— 按血缘算它是 M:1 的又一个孩子，落在**旧树**。
	const N = branch('N', 'M', 1, [7], '新树上开的分支')
	const sessions = [M, P, N]
	const visible = new Set(sessions.map((item) => item.id))
	const graphOf = (currentId, shape) =>
		pure.buildGraph(pure.conversationOf(pure.visibleTree(sessions, visible), currentId, shape.groupOf), currentId, pure.cutSet(shape.detached, sessions), shape.adopted)
	const keysOf = (graph) => graph.nodes.filter((node) => node.entry !== undefined).map((node) => node.key).sort()

	// 先把老症状钉死：没有认领记录时 N 确实掉回旧树 —— 否则这条用例抓不到 bug
	const cut = reshape({ session: 'M:2', detach: true })
	const lost = graphOf('N', cut)
	check(JSON.stringify(keysOf(lost)) === '["M:1","N:7","P:3"]', `没认领时 N 该掉在旧树里（这就是 bug 本身），实际 ${JSON.stringify(keysOf(lost))}`)
	check(lost.owner === pure.rootKeyOf('M'), `没认领时站的该是旧树（owner = M 那棵的树根 key），实际 ${lost.owner}`)

	// 认领：N 归 M:2 那棵。这就是 Rail 在 fork 成功后打的那条补丁（shapeOps.adopt）
	const patch = pure.shapeOps.adopt('N', 'M:2')
	check(JSON.stringify(patch) === '{"session":"N","adopt":"M:2"}', `adopt 补丁拼错了：${JSON.stringify(patch)}`)
	const claimed = reshape(patch)
	check(claimed.adopted && claimed.adopted.N === 'M:2', `认领记录没落盘：${JSON.stringify(claimed.adopted)}`)
	check(JSON.stringify(claimed.detached) === '["M:2"]', '认领不该动 detached')

	// 站在 N 上看到的是新树：前缀 1 + 2-6 + 自己的 7，且 7 挂在 1 底下
	const found = graphOf('N', claimed)
	check(JSON.stringify(keysOf(found)) === '["M:1","M:2","M:6","N:7"]', `认领后 N 该在新树里，实际 ${JSON.stringify(keysOf(found))}`)
	check(found.owner === 'M:2', `站的该是 M:2 那棵，实际 ${found.owner}`)
	const seven = found.nodes.find((node) => node.key === 'N:7')
	check(seven !== undefined && seven.parent.key === 'M:1', 'N:7 该挂在前缀节点 M:1 底下（fork 的岔路点没变）')
	check(seven !== undefined && seven.tree === 'M:2', `N:7 该归 M:2 那棵，实际 ${seven && seven.tree}`)
	// 前缀节点自己仍归旧树 —— Rail 靠 `node.tree !== graph.owner` 认出"这是前缀，开分支要认领"
	const one = found.nodes.find((node) => node.key === 'M:1')
	check(one !== undefined && one.tree === pure.rootKeyOf('M') && pure.isRootKey(one.tree) && one.tree !== found.owner, '前缀节点 M:1 该标成归旧树（认领判据靠它）')
	// 子树里的节点归新树 —— 从它们开分支不用认领
	check(found.nodes.find((node) => node.key === 'M:6').tree === 'M:2', 'M:6 在子树里，该归 M:2 那棵')

	// 旧树那边不能再有 N 的影子
	const old = graphOf('P', claimed)
	check(JSON.stringify(keysOf(old)) === '["M:1","P:3"]', `旧树不该再有 N，实际 ${JSON.stringify(keysOf(old))}`)

	// 刚 fork 出来、一句话都还没说的 N（没有自有轮次）：站上去就该是新树，而不是等第一句话
	const mute = [M, P, branch('N', 'M', 1, [], '还没说话')]
	const muteVisible = new Set(mute.map((item) => item.id))
	const early = pure.buildGraph(pure.conversationOf(pure.visibleTree(mute, muteVisible), 'N', {}), 'N', pure.cutSet(claimed.detached, mute), claimed.adopted)
	check(early.owner === 'M:2', `刚开的分支还没说话时就该显示新树，实际站在 ${early.owner}`)

	// 接回去：剪缝没了，两边合成一棵，N 跟着回来，谁都不许消失
	const healed = reshape({ session: 'M:2', detach: false })
	check(healed.adopted && healed.adopted.N === 'M:2', '接回去不该清掉认领记录（再拆一次还要用）')
	const whole = graphOf('N', healed)
	check(JSON.stringify(keysOf(whole)) === '["M:1","M:2","M:6","N:7","P:3"]', `接回去之后该是一整棵，实际 ${JSON.stringify(keysOf(whole))}`)
	check(whole.owner === pure.rootKeyOf('M'), `接回去之后站的该是整棵（M 的树根 key），实际 ${whole.owner}`)
	// 再拆一次：N 又跟着新树走
	const again = graphOf('N', reshape({ session: 'M:2', detach: true }))
	check(JSON.stringify(keysOf(again)) === '["M:1","M:2","M:6","N:7"]', `再拆一次 N 该跟着新树，实际 ${JSON.stringify(keysOf(again))}`)

	// 撤销认领：回到按血缘算
	const disowned = reshape(pure.shapeOps.disown('N'))
	check(disowned.adopted.N === undefined, '撤销认领后记录该删掉')
	check(JSON.stringify(keysOf(graphOf('N', disowned))) === '["M:1","N:7","P:3"]', '撤销认领后 N 该回到按血缘算的那棵')

	// 坏记录不许把建图挂死：指向不存在的节点 → 按血缘；自己指自己 → 按血缘
	const junk = graphOf('N', { groupOf: {}, detached: ['M:2'], adopted: { N: '查无此人' } })
	check(JSON.stringify(keysOf(junk)) === '["M:1","N:7","P:3"]', '认领目标不存在时该退回按血缘算')
	const loop = graphOf('N', { groupOf: {}, detached: ['M:2'], adopted: { N: 'N:7' } })
	check(loop.nodes.length > 0, '自己认领自己不该崩')
	check(reshape({ session: 'N', adopt: 'N' }).adopted.N === undefined, 'host 不该收下"自己认领自己"')

	// 老 shape.json 没有 adopted 这一项：读出来该是空表，不算坏文件
	fs.writeFileSync(path.join(home, 'plugins', 'dsh-chat-tree', 'shape.json'), JSON.stringify({ version: 1, groupOf: {}, detached: ['M:2'] }))
	const legacy = reshape({ session: 'M:2', detach: true })
	check(JSON.stringify(legacy.adopted) === '{}', `老文件没有 adopted 该按空表读，实际 ${JSON.stringify(legacy.adopted)}`)

	console.log('  没认领 → N 掉回旧树（bug 复现）；认领后 → 新树 1-2-6-7、旧树 1-3；接回去 / 再拆 / 撤销认领都对')
}

fs.rmSync(home, { recursive: true, force: true })
report()
