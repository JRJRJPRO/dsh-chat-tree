/**
 * dsh-tree —— 合并 / 接回来的用例。
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

// reshape 直接读写 $DSH_HOME/plugins/dsh-tree/shape.json，先把家挪到临时目录
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-tree-merge-'))
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
	const shapeFile = path.join(home, 'plugins', 'dsh-tree', 'shape.json')
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

fs.rmSync(home, { recursive: true, force: true })
report()
