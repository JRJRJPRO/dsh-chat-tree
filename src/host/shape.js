/**
 * 树形关系（哪几条对话算同一棵树、哪条支线被拆出去了）的读写。
 *
 * dsh 自己只记 fork 血缘，这两个概念不在任何日志里，只能自己存。
 */
import { atomicWrite, readJsonFile, shapePath } from './paths.js'

/** 空白形状。`groupOf` 只给**同树的非首条**对话登记；detached 是被手动拆出去的会话。 */
export const EMPTY_SHAPE = { version: 1, groupOf: {}, detached: [] }

/**
 * 读树形关系。读不到 / 坏了 / 版本对不上都退回空白 —— 这东西丢了只是分组没了，
 * 不应该把整条导轨带崩。
 * @returns 形状对象
 */
export function readShape() {
	const document = readJsonFile(shapePath())
	if (document === null || typeof document !== 'object' || document.version !== 1) return EMPTY_SHAPE
	return {
		version: 1,
		groupOf: document.groupOf !== null && typeof document.groupOf === 'object' ? document.groupOf : {},
		detached: Array.isArray(document.detached) ? document.detached : [],
	}
}

/**
 * 写树形关系。原子写，不会留下半截文件。
 * @param next - 完整的新形状
 * @returns 写进去的形状
 */
export function writeShape(next) {
	atomicWrite(shapePath(), `${JSON.stringify(next)}\n`)
	return next
}

/**
 * 一个分组目标最终落在哪棵树上。
 *
 * 存盘里的值恒为"终点"（不再是别人的 key），这个函数只是**写入时**把传进来的目标
 * 再解析一次，顺带兜住手改过 shape.json 的情况。带 guard 防自环。
 * @param groupOf - 登记表
 * @param target - 想合并进去的树
 * @returns 终点树编号
 */
export function settleGroup(groupOf, target) {
	const seen = new Set()
	let at = target
	while (typeof groupOf[at] === 'string' && !seen.has(at)) {
		seen.add(at)
		at = groupOf[at]
	}
	return at
}

/**
 * 打一条形状补丁。
 *
 * `group` ：把一条**对话**合并进 `group` 这棵树（group 为空则拆回独立的一棵）。
 * `detach`：把一个**节点**（`<会话>:<轮次>`）从它父亲那里剪下来 / 接回去。
 *
 * 两个字段的 `session` 含义不同（会话 id vs 节点 key），但都只是个不透明的字符串，
 * host 半不解析也不校验形状 —— 怕的是以后改了 key 格式还要来改这里。
 * 两者可以同时给。
 * @param patch - `{session, group?, detach?}`
 * @returns 打完补丁的形状
 */
export function reshape(patch) {
	const session = patch?.session
	if (typeof session !== 'string' || session.length === 0) throw new Error('reshape 需要 session')
	const current = readShape()
	const groupOf = Object.assign({}, current.groupOf)
	const detached = new Set(current.detached)

	if (patch.group !== undefined) {
		const want = typeof patch.group === 'string' && patch.group.length > 0 ? settleGroup(groupOf, patch.group) : ''
		if (want.length > 0 && want !== session) {
			groupOf[session] = want
			// ⚠️ 把原本指着 session 的那些人一起改指到 want。
			//    `treeOf` 只查**一跳**（`groupOf[root] || root`），不跟着链走 —— 不补这一步的话，
			//    「A 合进 B，再把 B 合进 C」会让 A 单独掉出来（A→A、B→B+C），
			//    先合进来的那条对话悄无声息地被踢走。test-merge 用例 2 钉着。
			for (const key of Object.keys(groupOf)) if (groupOf[key] === session) groupOf[key] = want
		} else delete groupOf[session]
	}
	if (patch.detach !== undefined) {
		if (patch.detach === true) detached.add(session)
		else detached.delete(session)
		// 拆出去的会话自成一棵，带着旧分组只会把它又拉回原树
		if (patch.detach === true) delete groupOf[session]
	}
	return writeShape({ version: 1, groupOf, detached: [...detached] })
}
