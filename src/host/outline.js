/**
 * 把一个分支的事件折成轮次大纲。**全部的日志格式知识都在这个文件里。**
 *
 * 宿主对 seeded 会话不给投影，而 fork 出来的会话正是"分支"，只能自己折。
 */

/** 提问预览截断长度。宿主 turnOutline 也是这个量级，保持一致。 */
export const PREVIEW_MAX = 64

/**
 * 取一条消息的首段纯文本。
 * @param data - user/message 或 assistant/message 的 data
 * @returns 文本，没有就空串
 */
export function textOf(data) {
	const content = data && (data.content || (data.message && data.message.content))
	if (!Array.isArray(content)) return ''
	for (const part of content) {
		if (part && part.type === 'text' && typeof part.text === 'string' && part.text.length > 0) return part.text
	}
	return ''
}

/**
 * 是不是真人发的那条。每轮有两条 user/message：用户打的字，和宿主注入的
 * runtime-context 快照；后者 `source.kind` 不是 'user'。
 * @param data - user/message 的 data
 * @returns 是否为真人输入
 */
export function isHumanPrompt(data) {
	return !!(data && data.source && data.source.kind === 'user')
}

/**
 * 把一个分支的事件折成大纲。这是全部的日志格式知识所在。
 * @param events - 该会话的全部事件
 * @returns {turns, title, model, forkTurn}
 */
export function foldOutline(events) {
	const turns = []
	let current
	let title
	let model
	let seedSeq // fork 继承前缀的终点

	for (const event of events) {
		const data = event.data || {}
		switch (event.type) {
			case 'turn/start':
				current = { turn: data.turn, seq: event.seq, time: event.time, prompt: '', compact: false, done: false }
				turns.push(current)
				break
			case 'turn/end':
				if (current !== undefined) {
					current.endSeq = event.seq
					// ⚠️ 只有 `completed` 才算"这一轮答完了"。中止（aborted）/ 出错（error）/
					//    被打断（interrupted）都是半截。**别退化成"有 turn/end 就算答完"**——
					//    盘上 34 条 aborted 也都老老实实带着 turn/end。
					//    半截和答完的差别只在撤回时才看得出来，见 rewind.js。
					current.done = (data.reason || {}).kind === 'completed'
				}
				break
			case 'session/end-seed':
				// resume 留下的是 `{}`，**只有 fork 留下的带 `inherited: true`**
				if (data.inherited === true) seedSeq = event.seq
				break
			case 'user/message':
				// 只认每轮第一条真人消息
				if (current !== undefined && current.prompt === '' && isHumanPrompt(data)) {
					// 撤回区间记的是**界面行**的 seq，而行就是这条真人消息。判"这一轮撤回没"
					// 要的正是它，不是 turn/start 的 seq —— turn/start 落在区间起点之前。
					current.promptSeq = event.seq
					current.prompt = textOf(data).replace(/\s+/g, ' ').trim().slice(0, PREVIEW_MAX)
					// 桥接类 provider 的压缩兼容：走 dsh-claude 时 `/compact` 不会被 dsh 的
					// 命令分发拦下，而是当普通提示词发给外部引擎，压缩全程在引擎内部
					// 完成，dsh 的日志里一条 compaction/* 都没有（盘上 64 个会话实测为 0）。
					// 只能从提示词认。原生 provider 走下面 compaction/end 那条，两者不冲突。
					if (/^\/compact\b/.test(current.prompt)) current.compact = true
				}
				break
			case 'compaction/end':
				{
					// ⚠️ 压缩失败也会发 end，只是带上 `error`（宿主校验器原话：
					//    成功的 compaction/end 必须配一条 compaction/summary）。
					//    不看 error 的话，压缩失败的那一轮也会被画成菱形 —— 明明什么都没压掉。
					if (data.error !== undefined) break
					const at = typeof data.turn === 'number' ? turns.find((item) => item.turn === data.turn) : current
					if (at !== undefined) at.compact = true
				}
				break
			case 'session/title':
				if (typeof data.title === 'string') title = data.title
				break
			case 'model/selection':
				if (typeof data.model === 'string') {
					model = data.reasoningEffort ? `${data.model}·${data.reasoningEffort}` : data.model
				}
				break
			default:
				break
		}
	}

	// 标出哪些轮是从父分支抄来的 —— 树上只画自己的那部分，
	// 否则父子两条链都把继承段画一遍，看着像"直线中间拐个弯"而不是分叉。
	let forkTurn
	for (const entry of turns) {
		entry.inherited = seedSeq !== undefined && entry.seq < seedSeq
		if (entry.inherited) forkTurn = entry.turn // 最后一个继承轮 = 岔路点在父分支的第几轮
	}

	return { turns, title, model, forkTurn }
}

// ===== 按 revision 缓存 =====

/** 大纲缓存：sessionId → {revision, outline}。revision 没变就不重读日志。 */
export const cache = new Map()

/**
 * 读一个会话的大纲（命中缓存就不读盘）。
 * @param ctx - 插件 context
 * @param snapshot - sessionPersistence.list() 的一项
 * @returns 大纲对象
 */
export async function outlineOf(ctx, snapshot) {
	const id = snapshot.header.id
	const hit = cache.get(id)
	if (hit !== undefined && hit.revision === snapshot.revision) return hit.outline

	let handle
	try {
		handle = await ctx.sessionPersistence.open(id, 'read')
		const result = await handle.read()
		const outline = foldOutline(result.events || [])
		// ⚠️ 半成品不许进缓存：分支刚建出来时 end-seed 可能还没落盘，这时继承轮会被
		// 全当成"自有"。缓存住的话要等它下次写日志才刷得掉，闲着就一直错。
		const halfBaked = snapshot.header.isSeeded === true && outline.forkTurn === undefined
		if (halfBaked) ctx.logger?.warn?.(`dsh-tree: ${id} 的日志还没写完（找不到岔路点），这次不缓存`)
		else cache.set(id, { revision: snapshot.revision, outline })
		return outline
	} catch (error) {
		// 失败降级成空大纲：这个分支在树上只是没有轮次，不影响其它分支。
		ctx.logger?.warn?.(`dsh-tree: outline for ${id} failed: ${String(error)}`)
		return { turns: [], title: undefined, model: undefined, forkTurn: undefined }
	} finally {
		if (handle !== undefined) await handle.close().catch(() => {})
	}
}
