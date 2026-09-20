/**
 * dsh-tree host 半。两件事：
 *   1. 折出每个分支的轮次大纲，走 `GET /plugins/dsh-tree/outlines` 喂给前端。
 *      （宿主对 seeded 会话不给投影，而 fork 出来的会话正是"分支"，只能自己折。）
 *   2. 听 `agent/created`，每条新分支一出生就接管，修掉原生 fork 的两个缺陷。
 *
 * 背景和踩坑记录见 DESIGN.md §3 §4。
 * @module dsh-tree
 */

import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync, readdirSync, statSync, unlinkSync, utimesSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { homedir } from 'node:os'
import { randomUUID, createHash } from 'node:crypto'
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
	visibleRadius: Schema.natural().max(30).default(12).description('离当前这一轮多少步以内的节点才画出来；0 = 不省略'),
	nodeScale: Schema.natural().min(50).max(250).default(100).description('节点、连线、列间距的整体缩放百分比'),
	// 颜色存 `#rrggbb`，形状存 circle / rounded / square / diamond。
	// 这里只声明成字符串，合法值由浏览器半的 FIELDS.accept 把关 ——
	// 存进来一个认不得的值不该把树搞崩，而是退回默认。
	normalColor: Schema.string().default('#6e7681').description('不在当前路径上的节点颜色'),
	normalShape: Schema.string().default('circle').description('普通节点形状'),
	currentColor: Schema.string().default('#58a6ff').description('当前路径的节点、连线与当前轮填充色'),
	currentShape: Schema.string().default('circle').description('当前路径的节点形状'),
	compactColor: Schema.string().default('#ffa657').description('压缩节点颜色'),
	compactShape: Schema.string().default('triangle').description('压缩节点形状；也可以填 char:<字> 用任意字符当节点'),
	emptyColor: Schema.string().default('#58a6ff').description('树根那个"新对话"空节点的颜色'),
	emptyShape: Schema.string().default('circle').description('空节点形状；边框恒为虚线'),
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
				current = { turn: data.turn, seq: event.seq, time: event.time, prompt: '', compact: false, done: false }
				turns.push(current)
				break
			case 'turn/end':
				if (current !== undefined) {
					current.endSeq = event.seq
					// ⚠️ 只有 `completed` 才算"这一轮答完了"。中止（aborted）/ 出错（error）/
					//    被打断（interrupted）都是半截。**别退化成"有 turn/end 就算答完"**——
					//    盘上 34 条 aborted 也都老老实实带着 turn/end。
					//    半截和答完的差别只在撤回时才看得出来，见第 3 步。
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
		lineage.set(header.id, header.parentSession) // 血缘表顺手刷新，见第 5 步
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
			// 撤回过的轮次在日志里原样留着，得靠旁车才认得出来（第 3 步）
			turns: markRewound(outline.turns, hiddenRangesOf(header.id)),
		})
	}

	// 顺手清理已删除会话的缓存项，别让 Map 无限长。
	for (const id of [...cache.keys()]) if (!alive.has(id)) cache.delete(id)

	sessions.sort((left, right) => (left.createdAt || 0) - (right.createdAt || 0))
	return { sessions }
}

// ===== 第 3 步：撤回（rewind）——把已经不在对话里的那几轮从树上摘掉 =====
//
// dsh-claude 的「撤回」**不删日志、也不开新会话**：它只在自己的旁车里记一组
// hidden `ranges`（界面行的 seq 区间），前端拿 CSS 把那些行藏起来，claude 那边
// 用 `resumeSessionAt` 从更早的锚点重开。详见 NATIVE-BASELINE.md §4。
//
// 于是日志里那几轮**原封不动地还在**。我们只折日志的话，撤回过的 4 会继续画在
// 树上，而且后来发的 5 会接在 4 底下，画成 1-2-3-4-5 —— 可 4 已经不在对话里了。
//
// 两种情形要分开（John 报的原话）：
//   · 4 答完了才撤回 → 4 是一条**真的走过又被放弃的支线**，留着，但 5 接到 3 上，
//     画成 1-2-3-4 和 1-2-3-5 两条。
//   · 4 答到一半被中止再撤回 → 这一轮压根没留下什么，节点直接不画，只剩 1-2-3-5。
// 「留着还是不画」由 `entry.done` 定（见第 1 步），成形放在浏览器半的 buildGraph。

/** 没有撤回时共用这一个空数组，省得每个会话都新建一个。 */
const NO_RANGES = []

/**
 * 撤回区间的缓存：sessionId → `{stamp, ranges}`，stamp 是旁车文件的 mtime+size。
 *
 * 不跟着 `cache`（大纲缓存）走：大纲按会话 revision 失效，而**撤回不写 dsh 日志**，
 * revision 一点不动，挂在那上面就永远刷不出来。
 */
const hiddenCache = new Map()

/**
 * 这个会话被撤回掉的行区间。
 * @param sessionId - dsh 会话 id
 * @returns `[{start, end}]`（界面行 seq，闭区间）；没有旁车 / 没撤回过就是空数组
 */
function hiddenRangesOf(sessionId) {
	const file = sidecarPath(sessionId)
	let stamp
	try {
		const stat = statSync(file)
		stamp = `${stat.mtimeMs}:${stat.size}`
	} catch {
		return NO_RANGES
	}
	const hit = hiddenCache.get(sessionId)
	if (hit !== undefined && hit.stamp === stamp) return hit.ranges
	const ranges = readHiddenRanges(file)
	hiddenCache.set(sessionId, { stamp, ranges })
	return ranges
}

/**
 * 从旁车里摘出撤回区间。
 *
 * ⚠️ 旁车里的 `activities` 是整份对话原文，本机实测最大 6.7MB，JSON.parse 一次 42ms。
 *    所以先在原文里找 `"ranges":[{` 这个串：非空的 ranges 必然长这样，
 *    **这一步只会少干活、不会漏判**（正文里凑巧有这串就多解析一次，结论一样）。
 *    别把它改成解析 `"ranges":` 后面那段 —— 那就成了在 6MB 对话正文里赌字符串位置。
 * @param file - 旁车路径
 * @returns 区间数组
 */
function readHiddenRanges(file) {
	let text
	try {
		text = readFileSync(file, 'utf8')
	} catch {
		return NO_RANGES
	}
	if (!text.includes('"ranges":[{')) return NO_RANGES
	try {
		const document = JSON.parse(text)
		if (!document || document.schemaVersion !== SIDECAR_SCHEMA_VERSION) return NO_RANGES
		const list = ((document.rewind || {}).ranges) || []
		const ranges = []
		for (const item of Array.isArray(list) ? list : []) {
			if (item && Number.isFinite(item.start) && Number.isFinite(item.end)) ranges.push({ start: item.start, end: item.end })
		}
		return ranges.length === 0 ? NO_RANGES : ranges
	} catch {
		return NO_RANGES
	}
}

/**
 * 这一轮是不是被撤回了。
 *
 * 拿**真人那条消息**的 seq 去比（撤回点就是用户点的那一行）；折不出提示词的轮次
 * 退而用 turn/end 的 seq —— 它也落在区间里。`seq`（turn/start）不行，它在区间起点之前。
 * @param entry - 一轮的大纲
 * @param ranges - 撤回区间
 * @returns 是否被撤回
 */
function turnHidden(entry, ranges) {
	const at = entry.promptSeq !== undefined ? entry.promptSeq : entry.endSeq
	if (at === undefined) return false
	return ranges.some((range) => at >= range.start && at <= range.end)
}

/**
 * 给大纲里的轮次盖上「撤回」戳。
 *
 * ⚠️ 必须返回**新对象**：传进来的 turns 是 `cache` 里那份，就地改的话，
 *    撤回状态会被腌进缓存，之后再也刷不掉（新分支 graft 时 ranges 会清空）。
 * @param turns - foldOutline 折出来的轮次
 * @param ranges - 撤回区间
 * @returns 轮次数组；没撤回过就原样返回，不白白拷一遍
 */
function markRewound(turns, ranges) {
	if (!Array.isArray(turns) || ranges.length === 0) return turns
	return turns.map((entry) => (turnHidden(entry, ranges) ? Object.assign({}, entry, { rewound: true }) : entry))
}

// ===== 第 4 步：接管新分支 =====
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

// ===== 第 5 步：graft —— 把外部引擎的记忆接上 =====
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
 * 树形关系的落盘位置。
 *
 * dsh 自己只记 fork 血缘（parentSession），而"哪几条独立对话算同一棵树"
 * 和"哪条支线被手动拆出去了"是我们自己的概念，它不在任何日志里，只能自己存。
 * 放在 home 而不是 localStorage：换浏览器、进手机都还在。
 * @returns 绝对路径
 */
function shapePath() {
	return join(dshHome(), 'plugins', 'dsh-tree', 'shape.json')
}

/** 空白形状。`groupOf` 只给**同树的非首条**对话登记；detached 是被手动拆出去的会话。 */
const EMPTY_SHAPE = { version: 1, groupOf: {}, detached: [] }

/**
 * 读树形关系。读不到 / 坏了 / 版本对不上都退回空白 —— 这东西丢了只是分组没了，
 * 不应该把整条导轨带崩。
 * @returns 形状对象
 */
function readShape() {
	try {
		const document = JSON.parse(readFileSync(shapePath(), 'utf8'))
		if (document === null || typeof document !== 'object' || document.version !== 1) return EMPTY_SHAPE
		return {
			version: 1,
			groupOf: document.groupOf !== null && typeof document.groupOf === 'object' ? document.groupOf : {},
			detached: Array.isArray(document.detached) ? document.detached : [],
		}
	} catch {
		return EMPTY_SHAPE
	}
}

/**
 * 写树形关系。先写临时文件再 rename，避免半截文件。
 * @param next - 完整的新形状
 * @returns 写进去的形状
 */
function writeShape(next) {
	const target = shapePath()
	mkdirSync(dirname(target), { recursive: true })
	const temporary = `${target}.${randomUUID()}.tmp`
	writeFileSync(temporary, `${JSON.stringify(next)}\n`, { mode: 0o600 })
	renameSync(temporary, target)
	return next
}

/**
 * 打一条形状补丁。
 *
 * `group` ：把一条**对话**登记到 `group` 这棵树（group 为空则销掉登记）。
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
		if (typeof patch.group === 'string' && patch.group.length > 0 && patch.group !== session) groupOf[session] = patch.group
		else delete groupOf[session]
	}
	if (patch.detach !== undefined) {
		if (patch.detach === true) detached.add(session)
		else detached.delete(session)
		// 拆出去的会话自成一棵，带着旧分组只会把它又拉回原树
		if (patch.detach === true) delete groupOf[session]
	}
	return writeShape({ version: 1, groupOf, detached: [...detached] })
}

/**
 * 自定义节点图片的落盘目录。和 shape.json 放一块，换浏览器也还在。
 * @returns 绝对路径
 */
function iconDir() {
	return join(dshHome(), 'plugins', 'dsh-tree', 'icons')
}

/** 最多留几张自定义图片。一张 64×64 的 PNG 也就几 KB，留够用就行。 */
const ICON_KEEP = 32

/** 一张图最多多少字节。浏览器半已经缩成 64×64，正常两三 KB —— 超一个数量级就是不对劲。 */
const ICON_MAX = 256 * 1024

/** PNG 的魔数。只认这个。 */
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

/**
 * 校验一个图片 id。id 是内容哈希，样子固定。
 *
 * ⚠️ 这东西要直接拼成文件名。放宽一点就是任人读盘上任意文件的路径穿越，
 *    别改成"过滤掉 ..  就行"之类的黑名单写法。
 * @param id - 待查的 id
 * @returns 是不是一个合法 id
 */
function isIconId(id) {
	return typeof id === 'string' && /^[0-9a-f]{32}$/.test(id)
}

/**
 * 存一张自定义节点图片。
 *
 * ⚠️ 只收 PNG，而且只收浏览器半 canvas 出来的那种。**绝不能直接落用户原文件**：
 *    SVG 里可以写 <script>，原样挂到同源地址上再当图引就是个后门。浏览器半
 *    已经过了一遍 canvas，到这儿的必然是纯像素 —— 这里验魔数是为了防绕过前端直接 POST。
 *
 * 文件名取内容哈希：同一张图传两次是同一个文件，换个颜色再传回来也不会堆出两份。
 * @param base64 - PNG 的 base64（不带 data: 前缀）
 * @returns 图片 id
 */
function putIcon(base64) {
	if (typeof base64 !== 'string' || base64.length === 0) throw new Error('没收到图片数据')
	const bytes = Buffer.from(base64, 'base64')
	if (bytes.length === 0) throw new Error('图片数据不是合法的 base64')
	if (bytes.length > ICON_MAX) throw new Error(`图片太大（${bytes.length} 字节）`)
	if (!bytes.subarray(0, PNG_MAGIC.length).equals(PNG_MAGIC)) throw new Error('只收 PNG（浏览器半会先把任意格式转成 PNG）')

	const id = createHash('sha256').update(bytes).digest('hex').slice(0, 32)
	const folder = iconDir()
	mkdirSync(folder, { recursive: true })
	const target = join(folder, `${id}.png`)
	const temporary = `${target}.${randomUUID()}.tmp`
	writeFileSync(temporary, bytes, { mode: 0o600 })
	renameSync(temporary, target)
	pruneIcons(folder)
	return id
}

/**
 * 只留最近用过的那几张。
 *
 * 按 mtime 排，而**每次被取走都会刷新 mtime**（见 readIcon）—— 所以"正在用的"那几张
 * 每次开页面都会浮到最前面，不会被这里清掉。真清错了也只是节点画不出来，重传一次就好。
 * @param folder - 目录
 */
function pruneIcons(folder) {
	try {
		const files = readdirSync(folder)
			.filter((name) => name.endsWith('.png'))
			.map((name) => ({ name, at: statSync(join(folder, name)).mtimeMs }))
			.sort((a, b) => b.at - a.at)
		for (const stale of files.slice(ICON_KEEP)) unlinkSync(join(folder, stale.name))
	} catch {
		// 清不掉不算错 —— 大不了多占几十 KB
	}
}

/**
 * 取一张自定义节点图片，顺手把 mtime 刷新一下当"最近用过"。
 * @param id - 图片 id
 * @returns PNG 字节，没有就 undefined
 */
function readIcon(id) {
	if (!isIconId(id)) return undefined
	const target = join(iconDir(), `${id}.png`)
	try {
		const bytes = readFileSync(target)
		try {
			const now = new Date()
			utimesSync(target, now, now)
		} catch {
			// 刷不动就算了，顶多早一点被 pruneIcons 清掉
		}
		return bytes
	} catch {
		return undefined
	}
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

// ===== 第 6 步：装配 =====

/** 内部件出口，仅供离线测试（cordis 只读 name/inject/apply）。 */
export const __test = { adoptBranch, forkTurnOf, inheritedPendingIds, lineage, putIcon, readIcon, isIconId, iconDir, ICON_KEEP, ICON_MAX, hiddenRangesOf, markRewound, turnHidden }

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
 *   · `agent/created` 监听 —— 每条新分支一出生就接管（第 4 步）
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
						const body = await collect(ctx, url.searchParams.get('cwd') || '')
						// 形状跟大纲一起发：少一个往返，也不会出现"大纲到了形状没到"那一帧的错分组
						json(res, 200, Object.assign(body, { shape: readShape() }))
					} catch (error) {
						json(res, 500, { error: String(error) })
					}
				},
			}),
		'dsh-tree: outlines route',
	)

	ctx.effect(
		() =>
			ctx.webServer.register({
				kind: 'exact',
				path: '/plugins/dsh-tree/shape',
				handler: async (req, res) => {
					try {
						if (req.method !== 'POST') return json(res, 200, readShape())
						const chunks = []
						for await (const chunk of req) chunks.push(chunk)
						return json(res, 200, reshape(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')))
					} catch (error) {
						return json(res, 400, { error: String(error) })
					}
				},
			}),
		'dsh-tree: shape route',
	)

	ctx.effect(
		() =>
			ctx.webServer.register({
				kind: 'exact',
				path: '/plugins/dsh-tree/icon',
				handler: async (req, res) => {
					try {
						if (req.method === 'POST') {
							const chunks = []
							for await (const chunk of req) chunks.push(chunk)
							const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
							return json(res, 200, { id: putIcon(body.data) })
						}
						const url = new URL(req.url || '/', 'http://dsh.invalid')
						const bytes = readIcon(url.searchParams.get('id') || '')
						if (bytes === undefined) return json(res, 404, { error: '没有这张图' })
						// 短缓存而不是 immutable：每次取走都会刷新 mtime，靠这个把"正在用的"
						// 那几张顶在 pruneIcons 的保留名单里（见 readIcon）
						res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'private, max-age=300' })
						return res.end(bytes)
					} catch (error) {
						return json(res, 400, { error: String((error && error.message) || error) })
					}
				},
			}),
		'dsh-tree: icon route',
	)
}
