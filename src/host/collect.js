/**
 * 组装 `/outlines` 的响应体。
 */
import { isClaudeSession } from './graft.js'
import { lineage } from './lineage.js'
import { cache, effectiveForkTurn, outlineOf } from './outline.js'
import { hiddenCache, markRewound, rewindStateOf, statusProbe } from './rewind.js'

/**
 * 这条分支在外部引擎那边有没有上下文。
 *
 * 判据全靠文件在不在，**不读任何内容**：自己没有旁车，而血缘上有人有 —— 那就是
 * "本该继承却没继承到"。至于当初为什么没接上（父会话在跑 / 找不到锚点 / 那时候还没装
 * 这个插件），事后分不出来，也不需要分：对用户来说结论都是同一句"这条分支没上下文"。
 *
 * ⚠️ 已知的不准：一旦你在这条分支里发过消息，dsh-claude 会给它建一份自己的旁车，
 *    这个判据随即失效（不再报警），可那条分支的**前几轮**仍然是失忆的。
 *    所以这个标记的作用是"用它之前提醒你"，不是"永久病历"。
 * @param sessionId - 会话 id
 * @param isSeeded - 是不是 fork 出来的
 * @returns 是不是缺上下文
 */
function contextMissing(sessionId, isSeeded) {
	if (!isSeeded || isClaudeSession(sessionId)) return false
	const seen = new Set([sessionId])
	let at = lineage.get(sessionId)
	while (at !== undefined && !seen.has(at)) {
		seen.add(at)
		if (isClaudeSession(at)) return true // 祖先托管给了外部引擎，我们却是空的
		at = lineage.get(at)
	}
	return false
}

/**
 * 组装整个响应体。
 * @param ctx - 插件 context
 * @param cwd - 只要这个工作目录下的会话；空表示全要
 * @returns {sessions:[...]}
 */
export async function collect(ctx, cwd) {
	const snapshots = await ctx.sessionPersistence.list()
	// ⚠️ 这个集合装的是**所有**会话，不是筛过 cwd 的那批。
	//    它唯一的用处是末尾清理缓存 —— 要是只装本 cwd 的，那清理就成了
	//    "每拉一次树，就把别的工作目录的大纲缓存全删掉"，切个目录回来又得整份重读。
	const known = new Set()
	const sessions = []
	const status = statusProbe(ctx)
	// 读旁车 fail-closed（认不出来就不读），拦合并 fail-open（认不出来就放行）
	const busy = (id) => status(id) !== 'idle'

	for (const snapshot of snapshots) {
		const header = snapshot.header
		lineage.set(header.id, header.parentSession) // 血缘表顺手刷新，graft 要顺着它往上找锚点
		known.add(header.id)
		if (cwd && header.cwd !== cwd) continue
		const outline = await outlineOf(ctx, snapshot)
		// 撤回有两个真相来源：surface replace 在日志里，outline 折的时候已经盖了戳；
		// dsh-claude 的撤回只在旁车里，这儿再盖一次（rewind.js）。
		const rewind = rewindStateOf(busy, header.id)
		const turns = markRewound(outline.turns, rewind.ranges)
		sessions.push({
			id: header.id,
			cwd: header.cwd,
			parentId: header.parentSession,
			isSeeded: !!header.isSeeded,
			createdAt: header.createdAt,
			title: outline.title,
			// 岔路点按**这条分支自己的眼光**算：它撤掉了继承来的轮，岔路点就往前挪
			forkTurn: effectiveForkTurn(turns),
			model: outline.model,
			turns,
			// 这一轮没敢读旁车（它正在跑）。前端据此给个提示，并等它跑完再来拉一次。
			...(rewind.pending ? { rewindPending: true } : {}),
			// 正在跑的对话不给合并 —— 合并本身只写 shape.json 不危险，但那棵树的形状
			// 现在算不准（撤回记录读不了），刚合进来就画错更难解释。
			...(status(header.id) === 'running' ? { running: true } : {}),
			// 对话正文托管给了外部引擎（claude 这类）。前端据此判断"从这儿开分支要不要
			// 先继承上下文"—— 普通 provider 不需要，日志里就是全文。
			...(isClaudeSession(header.id) ? { claude: true } : {}),
			// 该继承上下文却没继承到。前端在这条分支头上挂个牌子明说，别让人以为它记得前情。
			...(contextMissing(header.id, header.isSeeded === true) ? { contextMissing: true } : {}),
		})
	}

	// 顺手清理已删除会话的残留，别让这几个 Map 无限长。
	// 按同一份名单（`known` = 这次列表里出现过的全部会话）来。
	for (const id of [...cache.keys()]) if (!known.has(id)) cache.delete(id)
	for (const id of [...hiddenCache.keys()]) if (!known.has(id)) hiddenCache.delete(id)
	// `lineage` 故意不清：它是每条会话一对字符串，几乎不占地方，
	// 而错删一条的代价不对称 —— 新分支是 `agent/created` 里先登记血缘、
	// 之后才出现在 `list()` 里的，正好撞上这一轮清理就会被当成"已删除"抹掉。

	sessions.sort((left, right) => (left.createdAt || 0) - (right.createdAt || 0))
	return { sessions }
}
