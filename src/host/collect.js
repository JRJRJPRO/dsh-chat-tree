/**
 * 组装 `/outlines` 的响应体。
 */
import { lineage } from './lineage.js'
import { cache, outlineOf } from './outline.js'
import { markRewound, rewindStateOf, statusProbe } from './rewind.js'

/**
 * 组装整个响应体。
 * @param ctx - 插件 context
 * @param cwd - 只要这个工作目录下的会话；空表示全要
 * @returns {sessions:[...]}
 */
export async function collect(ctx, cwd) {
	const snapshots = await ctx.sessionPersistence.list()
	const alive = new Set()
	const sessions = []
	const status = statusProbe(ctx)
	// 读旁车 fail-closed（认不出来就不读），拦合并 fail-open（认不出来就放行）
	const busy = (id) => status(id) !== 'idle'

	for (const snapshot of snapshots) {
		const header = snapshot.header
		lineage.set(header.id, header.parentSession) // 血缘表顺手刷新，graft 要顺着它往上找锚点
		if (cwd && header.cwd !== cwd) continue
		alive.add(header.id)
		const outline = await outlineOf(ctx, snapshot)
		// 撤回过的轮次在日志里原样留着，得靠旁车才认得出来（rewind.js）
		const rewind = rewindStateOf(busy, header.id)
		sessions.push({
			id: header.id,
			cwd: header.cwd,
			parentId: header.parentSession,
			isSeeded: !!header.isSeeded,
			createdAt: header.createdAt,
			title: outline.title,
			forkTurn: outline.forkTurn,
			model: outline.model,
			turns: markRewound(outline.turns, rewind.ranges),
			// 这一轮没敢读旁车（它正在跑）。前端据此给个提示，并等它跑完再来拉一次。
			...(rewind.pending ? { rewindPending: true } : {}),
			// 正在跑的对话不给合并 —— 合并本身只写 shape.json 不危险，但那棵树的形状
			// 现在算不准（撤回记录读不了），刚合进来就画错更难解释。
			...(status(header.id) === 'running' ? { running: true } : {}),
		})
	}

	// 顺手清理已删除会话的缓存项，别让 Map 无限长。
	for (const id of [...cache.keys()]) if (!alive.has(id)) cache.delete(id)

	sessions.sort((left, right) => (left.createdAt || 0) - (right.createdAt || 0))
	return { sessions }
}
