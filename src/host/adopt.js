/**
 * 新分支一出生就接管，修掉原生 fork 的两个缺陷。
 *
 * 原生 fork 的毛病：会多抄一条还没跑的待办（所有 provider），
 * 外部引擎的记忆不跟随（只有 dsh-claude 这类）。详见 DESIGN.md §4。
 *
 * ⚠️ 这件事只能挂在 host 的 `agent/created` 上。试过在浏览器里包
 *    `ctx.sessions.fork`，一次都没生效；原生消息行上那个分支按钮也绕得过去。
 */
import { graft } from './graft.js'
import { statusProbe } from './rewind.js'
import { lineage } from './lineage.js'

/**
 * 从父分支抄过来的那一段事件。
 *
 * ⚠️ 别写成"seq ≥ 继承长度就 break"：日志头那条 header 记录没有 seq，会提前掐断。
 * @param session - 分支的 session
 * @returns 继承段的事件
 */
export function inheritedEvents(session) {
	return session.snapshotEvents().filter((event) => event.seq !== undefined && event.seq < session.inheritedEventCount)
}

/**
 * 岔路点在第几轮 —— 即继承前缀里最后一个跑完的轮次。
 * @param session - 新分支的 session
 * @returns 轮次号，判断不了就 undefined
 */
export function forkTurnOf(session) {
	let turn
	for (const event of inheritedEvents(session)) if (event.type === 'turn/end') turn = event.data.turn
	return turn
}

/**
 * 继承前缀里还没跑掉的那些待办的 id。把 `agent/inbox/spliced` 折一遍即得。
 *
 * ⚠️ 必须精确到 id，不能 `inbox.clear()`：dsh 重启会 resume 每个会话、同样触发
 * `agent/created`，那时队列里可能躺着用户自己排的待办。
 * @param session - 分支的 session
 * @returns 待删 id 列表
 */
export function inheritedPendingIds(session) {
	const state = { 'next-turn': [], 'next-step': [] }
	for (const event of inheritedEvents(session)) {
		if (event.type !== 'agent/inbox/spliced') continue
		const data = event.data || {}
		const list = state[data.target]
		if (list === undefined) continue
		list.splice(data.start || 0, data.removedCount || 0, ...(data.inserted || []))
	}
	return [...state['next-turn'], ...state['next-step']].map((message) => message && message.id).filter((id) => id !== undefined)
}

/**
 * 分支刚被造出来时接管它。**全程同步**，不留任何时间窗。
 * @param ctx - 插件 context
 * @param agent - 新建的 agent
 */
export function adoptBranch(ctx, agent) {
	const session = agent.session
	const header = session.header || {}
	if (header.isSeeded !== true) return // 不是分支，不管
	lineage.set(session.id, header.parentSession)

	// ① 删掉继承来的待办。
	// ⚠️ 别加"只认刚出生的分支"之类的前置判断：踩过一次，判断恒为 true，
	//    整个接管一次都没跑过（DESIGN.md §4）。按 id 删本身就是幂等的。
	try {
		let dropped = 0
		for (const id of inheritedPendingIds(session)) {
			if (agent.inbox !== undefined && agent.inbox.remove(id) === true) dropped += 1
		}
		if (dropped > 0) ctx.logger?.info?.(`dsh-tree: ${session.id} 删掉 ${dropped} 条继承来的待办`)
	} catch (error) {
		ctx.logger?.warn?.(`dsh-tree: ${session.id} 删待办失败：${String(error)}`)
	}

	// ② 需要的话把外部引擎的记忆接上（普通 provider 什么都不会发生）
	try {
		// fail-closed：认不出状态就当成在跑。赌错了只是这条分支没上下文（会明说），
		// 赌反了是打死父会话正在跑的那一轮。
		const status = statusProbe(ctx)
		const result = graft(session.id, header.parentSession, forkTurnOf(session), (id) => status(id) !== 'idle')
		if (result.grafted) ctx.logger?.info?.(`dsh-tree: ${session.id} 已接上上下文 ${JSON.stringify(result)}`)
		else if (result.reason === 'parent-busy')
			ctx.logger?.warn?.(`dsh-tree: ${session.id} 父会话正在跑，读它的记录会打断那一轮，所以这条分支没有继承上下文`)
		else if (result.reason !== 'native-context-is-enough') ctx.logger?.info?.(`dsh-tree: ${session.id} 未接上下文（${result.reason}）`)
	} catch (error) {
		ctx.logger?.warn?.(`dsh-tree: ${session.id} 接上下文失败：${String(error)}`)
	}
}

/**
 * 从回调实参里把 agent 捞出来。宿主用的是带作用域载体的 emit，实参形状可能随版本变，
 * 与其赌一种，不如认"长得像 agent 的那个"。
 * @param args - 回调收到的全部实参
 * @returns agent 或 undefined
 */
export function agentOf(args) {
	for (const value of args) {
		if (value === null || typeof value !== 'object') continue
		if (value.session !== undefined && value.inbox !== undefined) return value
		if (value.agent !== undefined && value.agent !== null && value.agent.session !== undefined) return value.agent
	}
	return undefined
}
