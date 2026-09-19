/**
 * dsh-tree host 半。两件事：
 *   1. 折出每个分支的轮次大纲，走 `GET /plugins/dsh-tree/outlines` 喂给前端。
 *      （宿主对 seeded 会话不给投影，而 fork 出来的会话正是"分支"，只能自己折。）
 *   2. 听 `agent/created`，每条新分支一出生就接管，修掉原生 fork 的两个缺陷。
 *
 * 背景和踩坑记录见 DESIGN.md §3 §4。
 * @module dsh-tree
 */

import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { homedir } from 'node:os'
import { randomUUID } from 'node:crypto'
import Schema from 'schemastery'

/** cordis 插件名。 */
export const name = 'tree'

/** 必须的宿主服务；少一个都会让 fiber 永远 pending，所以只要这三个。 */
export const inject = ['webServer', 'sessionPersistence', 'agents']

/** 提问预览截断长度。宿主 turnOutline 也是这个量级，保持一致。 */
const PREVIEW_MAX = 64

/** 设置命名空间。client.js 里的 SETTINGS_NS 必须和它一字不差。 */
export const SETTINGS_NS = 'dsh-tree'

/**
 * 只有一个字段：省略半径。0 = 不省略，否则 5..30。
 * 前端滑杆只给这几档，但设置文件是人可以手改的，所以边界还是写在 schema 里。
 */
export const SETTINGS_SCHEMA = Schema.object({
	visibleRadius: Schema.natural().max(30).default(10).description('离当前这一轮多少步以内的节点才画出来；0 = 不省略'),
})

// ===== 第 1 步：fold —— 从事件折出一个分支的大纲 =====

/**
 * 取一条消息的首段纯文本。
 * @param data - user/message 或 assistant/message 的 data
 * @returns 文本，没有就空串
 */
function textOf(data) {
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
function isHumanPrompt(data) {
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
				current = { turn: data.turn, seq: event.seq, time: event.time, prompt: '', compact: false }
				turns.push(current)
				break
			case 'turn/end':
				if (current !== undefined) current.endSeq = event.seq
				break
			case 'session/end-seed':
				// resume 留下的是 `{}`，**只有 fork 留下的带 `inherited: true`**
				if (data.inherited === true) seedSeq = event.seq
				break
			case 'user/message':
				// 只认每轮第一条真人消息
				if (current !== undefined && current.prompt === '' && isHumanPrompt(data)) {
					current.prompt = textOf(data).replace(/\s+/g, ' ').trim().slice(0, PREVIEW_MAX)
				}
				break
			case 'compaction/end':
				{
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

// ===== 第 2 步：cache —— 按 revision 缓存 =====

/** 大纲缓存：sessionId → {revision, outline}。revision 没变就不重读日志。 */
const cache = new Map()

/**
 * 读一个会话的大纲（命中缓存就不读盘）。
 * @param ctx - 插件 context
 * @param snapshot - sessionPersistence.list() 的一项
 * @returns 大纲对象
 */
async function outlineOf(ctx, snapshot) {
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

/**
 * 组装整个响应体。
 * @param ctx - 插件 context
 * @param cwd - 只要这个工作目录下的会话；空表示全要
 * @returns {sessions:[...]}
 */
async function collect(ctx, cwd) {
	const snapshots = await ctx.sessionPersistence.list()
	const alive = new Set()
	const sessions = []

	for (const snapshot of snapshots) {
		const header = snapshot.header
		lineage.set(header.id, header.parentSession) // 血缘表顺手刷新，见第 4 步
		if (cwd && header.cwd !== cwd) continue
		alive.add(header.id)
		const outline = await outlineOf(ctx, snapshot)
		sessions.push({
			id: header.id,
			cwd: header.cwd,
			parentId: header.parentSession,
			isSeeded: !!header.isSeeded,
			createdAt: header.createdAt,
			title: outline.title,
			forkTurn: outline.forkTurn,
			model: outline.model,
			turns: outline.turns,
		})
	}

	// 顺手清理已删除会话的缓存项，别让 Map 无限长。
	for (const id of [...cache.keys()]) if (!alive.has(id)) cache.delete(id)

	sessions.sort((left, right) => (left.createdAt || 0) - (right.createdAt || 0))
	return { sessions }
}

// ===== 第 3 步：接管新分支 =====
//
// 原生 fork 有两个缺陷：会多抄一条还没跑的待办（所有 provider），
// 外部引擎的记忆不跟随（只有 dsh-claude 这类）。详见 DESIGN.md §4。
//
// ⚠️ 这件事只能挂在 host 的 `agent/created` 上。试过在浏览器里包
//    `ctx.sessions.fork`，一次都没生效；原生消息行上那个分支按钮也绕得过去。

/** 血缘表：sessionId → parentSession。接管要同步跑完，来不及异步读盘。 */
const lineage = new Map()

/**
 * 从父分支抄过来的那一段事件。
 *
 * ⚠️ 别写成"seq ≥ 继承长度就 break"：日志头那条 header 记录没有 seq，会提前掐断。
 * @param session - 分支的 session
 * @returns 继承段的事件
 */
function inheritedEvents(session) {
	return session.snapshotEvents().filter((event) => event.seq !== undefined && event.seq < session.inheritedEventCount)
}

/**
 * 岔路点在第几轮 —— 即继承前缀里最后一个跑完的轮次。
 * @param session - 新分支的 session
 * @returns 轮次号，判断不了就 undefined
 */
function forkTurnOf(session) {
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
function inheritedPendingIds(session) {
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
function adoptBranch(ctx, agent) {
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
		const result = graft(session.id, header.parentSession, forkTurnOf(session))
		if (result.grafted) ctx.logger?.info?.(`dsh-tree: ${session.id} 已接上上下文 ${JSON.stringify(result)}`)
		else if (result.reason !== 'native-context-is-enough') ctx.logger?.info?.(`dsh-tree: ${session.id} 未接上下文（${result.reason}）`)
	} catch (error) {
		ctx.logger?.warn?.(`dsh-tree: ${session.id} 接上下文失败：${String(error)}`)
	}
}

// ===== 第 4 步：graft —— 把外部引擎的记忆接上 =====
//
// 普通 provider 走不到这里：对话原文就在 dsh 日志里，fork 抄过去就够了。
// 例外是 dsh-claude 这类"把对话托管给外部引擎"的桥接——日志里 assistant 正文是空的，
// 真正的对话在 Claude Code 那边，dsh 只存一个指针。详见 DESIGN.md §4。
//
// **不依赖 dsh-claude**：不 import、不要求它装着，判据只有"那个指针文件在不在"。
// 三道闸：版本对不上不碰 / 已有 sidecar 不覆盖 / 内容只从它自己写的合法文档里摘。
// 最差只是新分支失忆，不会弄坏已有会话。全同步 IO——接管必须在 fork 返回前跑完。

/** 我们认得的 dsh-claude sidecar 版本。对不上就不碰。 */
const SIDECAR_SCHEMA_VERSION = 1

/**
 * 解析 dsh home（`$DSH_HOME` 优先，否则 `~/.dsh`）。自己算而不 import
 * `dsh-home-paths`，是因为插件装在 profile 之外，解析不到宿主的依赖树。
 * @returns dsh home 绝对路径
 */
function dshHome() {
	const configured = process.env.DSH_HOME
	return configured && configured.trim().length > 0 ? resolve(configured.trim()) : join(homedir(), '.dsh')
}

/**
 * sidecar 路径。文件名是会话 id 原样 base64url。
 * @param sessionId - dsh 会话 id
 * @returns 绝对路径
 */
function sidecarPath(sessionId) {
	return join(dshHome(), 'plugins', 'dsh-claude', 'sessions', `${Buffer.from(sessionId).toString('base64url')}.json`)
}

/**
 * 读 sidecar。读不到 / 读坏了 / 版本对不上，一律当"没有"——结论都是不插手。
 * @param sessionId - dsh 会话 id
 * @returns sidecar 文档或 undefined
 */
function readSidecar(sessionId) {
	try {
		const document = JSON.parse(readFileSync(sidecarPath(sessionId), 'utf8'))
		return document && document.schemaVersion === SIDECAR_SCHEMA_VERSION ? document : undefined
	} catch {
		return undefined
	}
}

/**
 * 沿血缘往上找"持有第 `turn` 轮锚点"的那份 sidecar。
 * 要往上找是因为 sidecar 只记它自己跑过的轮次，更早的在祖先那儿。
 * @param fromId - 起点会话 id
 * @param turn - 需要的轮次
 * @returns {document, sawSidecar}
 */
function anchorSource(fromId, turn) {
	const seen = new Set()
	let sawSidecar = false
	let id = fromId
	while (id !== undefined && !seen.has(id)) {
		seen.add(id)
		const document = readSidecar(id)
		if (document !== undefined) sawSidecar = true
		const anchors = (document && document.rewind && document.rewind.anchors) || []
		if (document && document.binding !== undefined && anchors.some((item) => item.turn === turn)) return { document, sawSidecar }
		id = lineage.get(id)
	}
	return { document: undefined, sawSidecar }
}

/**
 * 把父分支第 `turn` 轮为止的外部引擎记忆嫁接给新分支。
 *
 * reason（`grafted: false` 时）：
 *   · `native-context-is-enough` —— 这条血缘上没有 sidecar。**正常情况**，
 *     说明是普通 provider，对话原文在 dsh 日志里，原生 fork 已经够了。
 *   · `no-anchor` —— 有 sidecar 但缺这一轮的锚点。
 *   · `child-already-bound` —— 新分支已经跑过，绝不覆盖。
 *   · `bad-request` —— 参数不对。
 * @param childId - 新分支 id
 * @param parentId - 父会话 id
 * @param turn - 岔路点所在的轮次（保留 1..turn）
 * @returns 结果说明
 */
export function graft(childId, parentId, turn) {
	if (!childId || !parentId || !Number.isSafeInteger(turn) || turn < 1) return { grafted: false, reason: 'bad-request' }

	const target = sidecarPath(childId)
	if (existsSync(target)) return { grafted: false, reason: 'child-already-bound' }

	const { document: parent, sawSidecar } = anchorSource(parentId, turn)
	if (parent === undefined) return { grafted: false, reason: sawSidecar ? 'no-anchor' : 'native-context-is-enough' }

	const rewind = parent.rewind
	const anchor = rewind.anchors.find((item) => item.turn === turn)
	const keep = (list) => (Array.isArray(list) ? list.filter((item) => item.turn <= turn) : [])
	const document = {
		schemaVersion: SIDECAR_SCHEMA_VERSION,
		revision: 0,
		// activities 是 UI 里助手正文的唯一来源（日志里是空的），不抄过来前几轮会显示成空回答
		activities: keep(parent.activities),
		binding: parent.binding,
		rewind: {
			// ranges（隐藏哪些 seq）照抄会误伤新分支后续的 seq，清空；代价是撤回过的内容会重新显示
			ranges: [],
			anchors: keep(rewind.anchors),
			snapshots: keep(rewind.snapshots),
			pending: { resumeAt: anchor.uuid },
		},
	}

	// 原子落盘，权限跟 dsh-claude 自己写的一致（目录 700 / 文件 600）。
	mkdirSync(dirname(target), { recursive: true, mode: 0o700 })
	const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`
	writeFileSync(temporary, `${JSON.stringify(document)}\n`, { mode: 0o600, flag: 'wx' })
	renameSync(temporary, target)
	return { grafted: true, resumeAt: anchor.uuid, turn, activities: document.activities.length }
}

// ===== 第 5 步：装配 =====

/** 内部件出口，仅供离线测试（cordis 只读 name/inject/apply）。 */
export const __test = { adoptBranch, forkTurnOf, inheritedPendingIds, lineage }

/**
 * 从回调实参里把 agent 捞出来。宿主用的是带作用域载体的 emit，实参形状可能随版本变，
 * 与其赌一种，不如认"长得像 agent 的那个"。
 * @param args - 回调收到的全部实参
 * @returns agent 或 undefined
 */
function agentOf(args) {
	for (const value of args) {
		if (value === null || typeof value !== 'object') continue
		if (value.session !== undefined && value.inbox !== undefined) return value
		if (value.agent !== undefined && value.agent !== null && value.agent.session !== undefined) return value.agent
	}
	return undefined
}

/**
 * 回一段 JSON。
 * @param res - Node 响应
 * @param status - HTTP 状态码
 * @param value - 序列化后发出去的东西
 */
function json(res, status, value) {
	res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
	res.end(JSON.stringify(value))
}

/**
 * 装上两件东西：
 *   · `agent/created` 监听 —— 每条新分支一出生就接管（第 3 步）
 *   · `GET /plugins/dsh-tree/outlines?cwd=<工作目录>` —— 给前端画树的数据
 * @param ctx - 携带 webServer / sessionPersistence / agents 的 context
 */
export function apply(ctx) {
	ctx.effect(() => {
		// 开机报到：看不到这行就说明监听没装上
		ctx.logger?.info?.('dsh-tree: 已接管分支创建（agent/created）')
		return ctx.on('agent/created', (...args) => {
			const agent = agentOf(args)
			if (agent === undefined) {
				ctx.logger?.warn?.('dsh-tree: agent/created 的参数里没认出 agent，分支不会被接管')
				return
			}
			adoptBranch(ctx, agent)
		})
	}, 'dsh-tree: 接管新分支')

	// 设置 namespace。ctx.settings 是可选服务，所以走 ctx.inject 而不是顶层 inject
	// —— 写进顶层 inject 的话，没挂设置提供方的部署会让整个 fiber 永远 pending。
	try {
		ctx.inject(['settings'], (scoped) => {
			scoped.settings.register(SETTINGS_NS, SETTINGS_SCHEMA)
			scoped.logger?.info?.(`dsh-tree: 设置 namespace ${SETTINGS_NS} 已注册`)
		})
	} catch (error) {
		ctx.logger?.warn?.(`dsh-tree: 注册设置失败，前端会按默认半径画（${error}）`)
	}

	ctx.effect(
		() =>
			ctx.webServer.register({
				kind: 'exact',
				path: '/plugins/dsh-tree/outlines',
				handler: async (req, res) => {
					try {
						const url = new URL(req.url || '/', 'http://dsh.invalid')
						json(res, 200, await collect(ctx, url.searchParams.get('cwd') || ''))
					} catch (error) {
						json(res, 500, { error: String(error) })
					}
				},
			}),
		'dsh-tree: outlines route',
	)
}
