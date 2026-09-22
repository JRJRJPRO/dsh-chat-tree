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

// ===== 父会话正忙时的补做 =====
//
// graft 要读父会话的旁车，而**读旁车会打断父会话正在跑的那一轮**（rewind.js 开头那段
// EPERM 的账）。所以撞上 `parent-busy` 只能先收手 —— 这条不许放宽。
//
// 但「收手」不该等于「永久放弃」：那一轮总会跑完，而这条新分支只要在**它自己第一次
// 发消息之前**补上上下文就不算晚。以前的写法是打一条 warn 就结束，于是在父会话跑着的
// 时候开的岔路，永远是个失忆分支 —— 而那恰好是最常见的开岔路时机（看着它跑偏，
// 立刻从上一轮岔出去）。
//
// 补做是安全的，因为 `graft` 自己有 `child-already-bound` 那道闸：新分支一旦自己
// 跑起来，dsh-claude 会给它建旁车，补做那一下会自动让位，不会覆盖任何东西。

/** 还在等父会话空下来的定时器。插件停用时要全部清掉，否则 test-lifecycle 会抓到残留。 */
const pendingGrafts = new Set()

/** 重试间隔。父会话跑完一轮的量级是分钟，2 秒一探已经足够灵敏。 */
export const GRAFT_RETRY_MS = 2000

/** 最多重试多少次（2s × 150 = 5 分钟）。超了就真的放弃，不然一条僵尸定时器挂到天荒地老。 */
export const GRAFT_RETRY_MAX = 150

/**
 * 插件停用时取消所有等待中的补做。
 * @returns 取消掉的个数
 */
export function cancelPendingGrafts() {
	const count = pendingGrafts.size
	for (const timer of pendingGrafts) clearTimeout(timer)
	pendingGrafts.clear()
	return count
}

/**
 * 排一次「等父会话空下来再 graft」。
 * @param ctx - 插件 context
 * @param childId - 新分支
 * @param parentId - 父分支
 * @param turn - 岔路点轮次
 * @param opts - `{intervalMs, maxTries}`，给测试用的
 * @returns 取消这次等待的函数
 */
export function scheduleGraftRetry(ctx, childId, parentId, turn, opts) {
	const intervalMs = opts?.intervalMs ?? GRAFT_RETRY_MS
	const status = statusProbe(ctx)
	let left = opts?.maxTries ?? GRAFT_RETRY_MAX
	let timer

	const stop = () => {
		if (timer !== undefined) clearTimeout(timer)
		pendingGrafts.delete(timer)
	}

	const tick = () => {
		pendingGrafts.delete(timer)
		left -= 1
		let result
		try {
			result = graft(childId, parentId, turn, (id) => status(id) !== 'idle')
		} catch (error) {
			ctx.logger?.warn?.(`dsh-chat-tree: ${childId} 补接上下文失败：${String(error)}`)
			return
		}
		if (result.grafted) {
			ctx.logger?.info?.(`dsh-chat-tree: ${childId} 等到父会话空闲，已补接上下文 ${JSON.stringify(result)}`)
			return
		}
		// 不是"还在忙"就没必要再等了 —— 比如新分支自己已经跑起来并建了旁车
		// （child-already-bound），那时候补做只会添乱。
		if (result.reason !== 'parent-busy') {
			ctx.logger?.info?.(`dsh-chat-tree: ${childId} 不再等待补接（${result.reason}）`)
			return
		}
		if (left <= 0) {
			ctx.logger?.warn?.(`dsh-chat-tree: ${childId} 等了太久父会话还在跑，放弃补接上下文`)
			return
		}
		arm()
	}

	const arm = () => {
		timer = setTimeout(tick, intervalMs)
		timer.unref?.() // 别拦着 node 退出
		pendingGrafts.add(timer)
	}

	arm()
	return stop
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
		if (dropped > 0) ctx.logger?.info?.(`dsh-chat-tree: ${session.id} 删掉 ${dropped} 条继承来的待办`)
	} catch (error) {
		ctx.logger?.warn?.(`dsh-chat-tree: ${session.id} 删待办失败：${String(error)}`)
	}

	// ② 需要的话把外部引擎的记忆接上（普通 provider 什么都不会发生）
	try {
		// fail-closed：认不出状态就当成在跑。赌错了只是这条分支没上下文（会明说），
		// 赌反了是打死父会话正在跑的那一轮。
		const status = statusProbe(ctx)
		const turn = forkTurnOf(session)
		const result = graft(session.id, header.parentSession, turn, (id) => status(id) !== 'idle')
		if (result.grafted) ctx.logger?.info?.(`dsh-chat-tree: ${session.id} 已接上上下文 ${JSON.stringify(result)}`)
		else if (result.reason === 'parent-busy') {
			// 现在不读，但也不放弃 —— 排队等它跑完再补（见上面那段）
			scheduleGraftRetry(ctx, session.id, header.parentSession, turn)
			ctx.logger?.info?.(`dsh-chat-tree: ${session.id} 父会话正在跑，读它会打断那一轮 —— 已排队，等它空下来再接`)
		} else if (result.reason !== 'native-context-is-enough') ctx.logger?.info?.(`dsh-chat-tree: ${session.id} 未接上下文（${result.reason}）`)
	} catch (error) {
		ctx.logger?.warn?.(`dsh-chat-tree: ${session.id} 接上下文失败：${String(error)}`)
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
