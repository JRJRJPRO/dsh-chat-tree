/**
 * 把一个分支的事件折成轮次大纲。**全部的日志格式知识都在这个文件里。**
 *
 * 宿主对 seeded 会话不给投影，而 fork 出来的会话正是"分支"，只能自己折。
 *
 * 【一轮"还在不在对话里"有两个真相来源，这里只管其中一个】
 *   · **surface**（宿主原生）：每条产生消息的事件都带 `surfaceOp`，就地撤回就是一次
 *     `{op:'replace'}` 把一段 surface 节点遮掉（dsh-rewind-plugin / dsh-retrace 都走这条）。
 *     它在日志里，所以在这儿折，随大纲一起按 revision 缓存。
 *   · **dsh-claude 的旁车 `ranges`**：它的对话在 Claude 那边，撤回不写日志，只记旁车。
 *     不在这儿折 —— 见 rewind.js（读旁车有打断正在跑的那一轮的风险，规矩全在那边）。
 *   两条最后在 collect.js 里汇成同一个 `rewound` 戳，成图那边不分来源。
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
 * 折宿主的 surface，得到被 replace 遮掉的 seq 集合。
 *
 * 宿主的规则（dsh-session/surface）：带 `surfaceOp:'append'` 的事件接在 surface 尾部；
 * `{op:'replace', startSeq, endSeq}` 把 surface 里从 startSeq 到 endSeq（含）那一段节点
 * 换成这一条自己。模型看到的历史就是折完之后的节点序列 —— 被遮掉的节点，模型不记得。
 *
 * ⚠️ 这是宿主 `foldSurface` 的**宽容版**，不 import 它：官方那份对任何不一致都 throw
 *    （seq 不连续、replace 指到不存在的节点……），而我们折的是从盘上读回来的整份日志，
 *    一条坏事件不该让整棵树消失。这里遇到认不得的 replace 就当它没发生。
 *    宿主每次刷新系统提示也是一次 replace（换 surface 第 0 个节点），遮掉的是
 *    system/message，不会命中任何一轮的提问行 —— 所以不用特意排除。
 *
 * 小例子（seq → 事件）：
 *   5 user(append)  6 assistant(append)  9 user(append)  10 assistant(append)
 *   12 user(plugin 标记, replace 9..10)
 *   折：[5,6] → [5,6,9,10] → replace 找到 9、10 在位置 2..3 → 遮掉 {9,10}，surface 变 [5,6,12]
 * @param events - 该会话的全部事件
 * @returns 被遮掉的 seq 集合
 */
export function shadowedSeqs(events) {
	const nodes = []
	const shadowed = new Set()
	for (const event of events) {
		const op = event && event.surfaceOp
		if (op === undefined || op === null || typeof event.seq !== 'number') continue
		if (op === 'append') {
			nodes.push(event.seq)
			continue
		}
		if (typeof op !== 'object' || op.op !== 'replace') continue
		const startIdx = nodes.indexOf(op.startSeq)
		const endIdx = nodes.indexOf(op.endSeq)
		if (startIdx === -1 || endIdx === -1 || startIdx > endIdx) continue // 认不得就当没发生
		for (const seq of nodes.slice(startIdx, endIdx + 1)) shadowed.add(seq)
		nodes.splice(startIdx, endIdx - startIdx + 1, event.seq)
	}
	return shadowed
}

/**
 * 岔路点在父分支的第几轮 —— **按这条分支自己的眼光算**。
 *
 * 原来的算法是"继承前缀里最后一轮"。可分支可以撤回它继承来的轮：从父分支第 3 轮岔出来，
 * 然后把 3 撤掉、重发一句 —— 这时它的对话是 1-2-4，岔路点是 2，不是 3。
 * 还按 3 算的话，新发的 4 就挂在一个在这条分支里已经不存在的节点底下：
 * John 报的"1-2-3-4，可 3 已经被删了"就是这么画出来的。盘上带撤回记录的分支，
 * 两条都是撤到了继承段里。
 *
 * 全撤光了就 undefined：成图那边找不到挂载点会退到父分支自己的挂载点，
 * 也就是"从头再来"。
 * @param turns - 已经盖过撤回戳的轮次（含继承的）
 * @returns 最后一个在本分支里还活着的继承轮，或 undefined
 */
export function effectiveForkTurn(turns) {
	let at
	for (const entry of turns || []) {
		if (entry.inherited === true && entry.rewound !== true) at = entry.turn
	}
	return at
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
	//
	// ⚠️ 这里的 forkTurn 是**继承前缀的最后一轮**，是"日志说的"岔路点。
	//    真正拿去成图的岔路点要等旁车 ranges 也盖完戳之后再算（effectiveForkTurn），
	//    在 collect.js。这一个留着给 outlineOf 判"半成品"用。
	let forkTurn
	for (const entry of turns) {
		entry.inherited = seedSeq !== undefined && entry.seq < seedSeq
		if (entry.inherited) forkTurn = entry.turn
	}

	// 就地撤回（宿主原生的 surface replace）：提问行被遮掉的那一轮就不在对话里了。
	// 只认提问行：回答被单独换掉（重新生成）的轮，问题还在，不算撤回。
	const shadowed = shadowedSeqs(events)
	if (shadowed.size > 0) {
		for (const entry of turns) if (entry.promptSeq !== undefined && shadowed.has(entry.promptSeq)) entry.rewound = true
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
		if (halfBaked) ctx.logger?.warn?.(`dsh-chat-tree: ${id} 的日志还没写完（找不到岔路点），这次不缓存`)
		else cache.set(id, { revision: snapshot.revision, outline })
		return outline
	} catch (error) {
		// 失败降级成空大纲：这个分支在树上只是没有轮次，不影响其它分支。
		ctx.logger?.warn?.(`dsh-chat-tree: outline for ${id} failed: ${String(error)}`)
		return { turns: [], title: undefined, model: undefined, forkTurn: undefined }
	} finally {
		if (handle !== undefined) await handle.close().catch(() => {})
	}
}
