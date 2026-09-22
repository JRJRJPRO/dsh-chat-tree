/**
 * dsh-chat-tree —— 「接管新分支」回归测试。
 *
 * 【导读】
 * 干嘛的：把**真实踩过坑的那几个会话**倒带到"分支刚被造出来"的那一刻，
 * 让 host 半的 `adoptBranch` 真的跑一遍，看它有没有把坑填上。
 *
 * 为什么这样测：这两个 bug 都只在"分支诞生的一瞬间"表现出来，
 * 事后看日志只能看到结果。把盘上真实日志切回那一刻重放，是不开浏览器
 * 能做到的最接近真事的测法。
 *
 * 数据流一句话：
 *   读真实会话日志 → 切到 `session/end-seed{inherited}` 之前（= 继承前缀）
 *   → 按这段前缀折出"当时队列里有什么" → 造一个假 agent
 *   → 调 adoptBranch → 断言队列被清空 / sidecar 被写对。
 *
 * 阅读顺序：
 *   第1步  准备：读盘、临时 DSH_HOME
 *   第2步  倒带：把一个分支还原成"刚出生"的样子
 *   第3步  断言 A —— 清掉继承来的待办（所有 provider）
 *   第4步  断言 B —— 接上外部引擎的记忆（只有 dsh-claude 这类）
 *   第5步  断言 C —— 不该动的时候一个字节都不动
 *
 * 跑法：
 *   DSH_HOME_REAL='E:/Programs/deepseek-harness/home' node tests/test-branch.mjs
 *
 * @module test-branch
 */

import { check, report } from './test-kit.mjs'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'

// 注意顺序：先记下真实 home，后面才把 DSH_HOME 改指到临时目录。
// 默认值和别的脚本保持一致。原来默认 `~/.dsh`，在这台机器上找不到 →
// **整份脚本静默跳过**，而它恰好是唯一一个真跑 graft 的测试。
const REAL_HOME = process.env.DSH_HOME_REAL || process.env.DSH_HOME || 'E:/Programs/deepseek-harness/home'
const SESSIONS = path.join(REAL_HOME, 'sessions')
const SIDECARS = path.join(REAL_HOME, 'plugins', 'dsh-claude', 'sessions')


/**
 * 解一个 session 文件。v3 是**多 frame 拼接**的 zstd，Node 的 zstdDecompressSync
 * 只解第一个就停且不报错，所以自己扫 frame 头逐个解。
 * @param file - 绝对路径
 * @returns 事件数组
 */
function readSession(file) {
	const buffer = fs.readFileSync(file)
	const parts = []
	for (let i = 0; i + 4 <= buffer.length; i += 1) {
		if (buffer.readUInt32LE(i) !== 0xfd2fb528) continue
		try {
			parts.push(zlib.zstdDecompressSync(buffer.subarray(i)))
		} catch {
			/* 不是真的 frame 头 */
		}
	}
	return Buffer.concat(parts)
		.toString('utf8')
		.split('\n')
		.filter(Boolean)
		.map((line) => {
			try {
				return JSON.parse(line)
			} catch {
				return null
			}
		})
		.filter(Boolean)
}

/** sidecar 文件名就是会话 id 原样 base64url。 */
const sidecarName = (sessionId) => `${Buffer.from(sessionId).toString('base64url')}.json`

/** 一条消息的纯文本，用来在断言里认人。 */
const say = (message) => (message.content || []).map((part) => part.text || `<${part.type}>`).join('')

// ===== 第 1 步：准备 =====

if (!fs.existsSync(SESSIONS)) {
	console.log(`跳过：找不到 ${SESSIONS}（设 DSH_HOME_REAL 指向真实 home 再跑）`)
	process.exit(0)
}

/** id（含 `session-` 前缀）→ 事件数组 */
const logs = new Map()
for (const bucket of fs.readdirSync(SESSIONS)) {
	const bucketDir = path.join(SESSIONS, bucket)
	if (!fs.statSync(bucketDir).isDirectory()) continue
	for (const dir of fs.readdirSync(bucketDir)) {
		const file = path.join(bucketDir, dir, 'session.v3.jsonl.zstd')
		if (!fs.existsSync(file)) continue
		const events = readSession(file)
		if (events.length > 0) logs.set(dir, events)
	}
}

// 临时 home：graft 会往这里写，绝不碰真实的那份
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-chat-tree-branch-'))
process.env.DSH_HOME = home
const sidecarDir = path.join(home, 'plugins', 'dsh-claude', 'sessions')
fs.mkdirSync(sidecarDir, { recursive: true })

const host = await import(new URL('../index.js', import.meta.url))
const { adoptBranch, lineage } = host.__test
// ⚠️ `agents` 不能省。graft 是 fail-closed 的：问不出会话状态就当它在跑、拒绝读旁车。
//    少了这张表，接管会**静悄悄地什么都不干**（上面那句 statusProbe 会返回 unknown）。
//    `status: 'idle'` 就是离线测试里的常态：没有任何一轮在跑。
const ctx = {
	logger: { info() {}, warn() {} },
	agents: { get: () => ({ status: 'idle' }) },
}

// ===== 第 2 步：倒带 —— 把一个分支还原成"刚出生"的样子 =====

/**
 * 队列的标准折叠：`agent/inbox/spliced` 就是对两个待办列表做 splice。
 * 这不是我发明的规则，是日志里这类事件的字面语义
 * （`{target, start, removedCount, inserted}`）。
 * @param events - 要折叠的事件
 * @returns {'next-turn': [...], 'next-step': [...]}
 */
function foldInbox(events) {
	const state = { 'next-turn': [], 'next-step': [] }
	for (const event of events) {
		if (event.type !== 'agent/inbox/spliced') continue
		const data = event.data || {}
		const list = state[data.target]
		if (list === undefined) continue
		list.splice(data.start || 0, data.removedCount || 0, ...(data.inserted || []))
	}
	return state
}

/**
 * 把一个**真实的分支会话**倒带到"刚被 fork 出来、还没跑任何一轮"的那一刻，
 * 造出一个 host 半看得懂的假 agent。
 *
 * 继承前缀的终点就是这条分支自己的 `session/end-seed {inherited:true}`——
 * 取**最后一个**，因为分支的分支会把祖先的那条也继承下来。
 * @param id - 会话 id（含 `session-` 前缀）
 * @returns 假 agent，或 undefined（不是分支）
 */
function rewind(id) {
	const events = logs.get(id)
	if (events === undefined) return undefined
	const seeds = events.filter((event) => event.type === 'session/end-seed' && (event.data || {}).inherited === true)
	if (seeds.length === 0) return undefined
	const inheritedEventCount = seeds[seeds.length - 1].seq
	const prefix = events.filter((event) => event.seq < inheritedEventCount)

	// 父亲是谁：日志第一条就是 header 记录（`{type:'session', parentSession, isSeeded, …}`），
	// 直接用它，别去猜。
	const header = events.find((event) => event.type === 'session' && event.seq === undefined) || {}
	const parentSession = header.parentSession

	const inbox = foldInbox(prefix)
	return {
		id,
		inbox: {
			get nextTurn() {
				return inbox['next-turn']
			},
			get nextStep() {
				return inbox['next-step']
			},
			get hasPending() {
				return inbox['next-turn'].length > 0 || inbox['next-step'].length > 0
			},
			// 照着宿主 ReactLoopInbox.remove 的语义：删掉返回 true，本来就不在返回 false
			remove(messageId) {
				for (const target of ['next-turn', 'next-step']) {
					const at = inbox[target].findIndex((message) => message.id === messageId)
					if (at >= 0) {
						inbox[target].splice(at, 1)
						return true
					}
				}
				return false
			},
		},
		session: {
			id,
			inheritedEventCount,
			header: { isSeeded: true, parentSession },
			// ⚠️ 真实运行时，`session/end-seed` 就写在 seq == inheritedEventCount 上，
			//    也就是**创建那一刻这条分支已经有一条自有事件了**。
			//    上一版靠"还没有自有事件"来判断"刚出生"，正是栽在这里。
			//    所以这里如实带上它，别把测试造得比现实干净。
			snapshotEvents: () => [...prefix, { seq: inheritedEventCount, type: 'session/end-seed', data: { inherited: true } }],
			isOwnSeq: (seq) => seq >= inheritedEventCount && seq < inheritedEventCount + 1,
		},
	}
}

const branches = [...logs.keys()].map(rewind).filter((agent) => agent !== undefined)
console.log(`读到 ${logs.size} 个真实会话，其中 ${branches.length} 个是分支`)
check(branches.length > 0, '盘上至少要有一个分支才测得动')

// 血缘表：host 半靠它往上找锚点。真实运行时由 collect() 刷新，这里手工喂。
for (const agent of branches) lineage.set(agent.id, agent.session.header.parentSession)
for (const id of logs.keys()) if (!lineage.has(id)) lineage.set(id, undefined)

// ===== 第 3 步：断言 A —— 清掉继承来的待办 =====

// 这是 John 这次踩的坑：他在「加上22是多少」后面开岔路问「-1呢？」，
// 结果算成了 22+44-1 —— 因为「加上44呢？」作为一条没跑的待办被继承了过去。
const dirty = branches.filter((agent) => agent.inbox.hasPending)
console.log(`\n第3步：${dirty.length} 个分支出生时带着继承来的待办`)
for (const agent of dirty) {
	const carried = [...agent.inbox.nextTurn, ...agent.inbox.nextStep].map(say)
	console.log(`   ${agent.id.slice(8, 20)} 继承了 ${JSON.stringify(carried)}`)
}
check(dirty.length > 0, '盘上至少要有一个"脏"分支，否则这条断言测了个寂寞')

for (const agent of branches) {
	const before = [...agent.inbox.nextTurn, ...agent.inbox.nextStep].map(say)
	adoptBranch(ctx, agent)
	check(
		agent.inbox.hasPending === false,
		`${agent.id.slice(8, 20)} 接管后队列必须是空的，实际还剩 ${JSON.stringify([...agent.inbox.nextTurn, ...agent.inbox.nextStep].map(say))}（原有 ${JSON.stringify(before)}）`,
	)
}
console.log(`断言 A：${branches.length} 个分支接管后队列全部为空 —— 不会再自动重跑旧问题`)

// ===== 第 4 步：断言 B —— 接上外部引擎的记忆 =====

// 只有 dsh-claude 那种"把对话托管给外部引擎"的才需要。挑一个真有锚点的父会话来测。
const claudeCase = branches.find((agent) => {
	const parentId = agent.session.header.parentSession
	if (parentId === undefined) return false
	const file = path.join(SIDECARS, sidecarName(parentId))
	if (!fs.existsSync(file)) return false
	const document = JSON.parse(fs.readFileSync(file, 'utf8'))
	const anchors = (document.rewind && document.rewind.anchors) || []
	return document.binding !== undefined && anchors.length > 0
})

if (claudeCase === undefined) {
	console.log('\n断言 B：跳过（盘上没有带锚点的 dsh-claude 分支）')
} else {
	const parentId = claudeCase.session.header.parentSession
	const parentFile = path.join(SIDECARS, sidecarName(parentId))
	fs.copyFileSync(parentFile, path.join(sidecarDir, sidecarName(parentId)))
	const parentDocument = JSON.parse(fs.readFileSync(parentFile, 'utf8'))

	// 这个分支在上面已经被接管过一次了（那时父 sidecar 还没复制进临时 home，
	// 所以什么都没写）。现在条件齐了，再跑一次。
	adoptBranch(ctx, claudeCase)

	const childFile = path.join(sidecarDir, sidecarName(claudeCase.id))
	check(fs.existsSync(childFile), `${claudeCase.id.slice(8, 20)} 应当被写出 sidecar（没写 = 接管压根没跑）`)
	if (!fs.existsSync(childFile)) {
		console.log('       后面几条依赖它，跳过')
	} else {
		const written = JSON.parse(fs.readFileSync(childFile, 'utf8'))
		const forkTurn = host.__test.forkTurnOf(claudeCase.session)
		const expected = parentDocument.rewind.anchors.find((item) => item.turn === forkTurn)
		console.log(`\n断言 B：${claudeCase.id.slice(8, 20)} 岔路在 turn${forkTurn}`)
		check(written.binding.claudeSessionId === parentDocument.binding.claudeSessionId, '必须绑到父分支同一个外部会话（这是"记得前文"的全部关键）')
		check(expected !== undefined && written.rewind.pending.resumeAt === expected.uuid, '接续点必须是那一轮自己的锚点')
		check(
			written.rewind.anchors.every((item) => item.turn <= forkTurn),
			`锚点必须裁到 ≤${forkTurn}，实际 ${written.rewind.anchors.map((item) => item.turn)}`,
		)
		check(
			written.activities.every((item) => item.turn <= forkTurn),
			'助手正文必须裁到岔路点为止，否则新分支会显示出父分支后来的回答',
		)
		check(written.schemaVersion === 1, 'schema 必须合法，否则 dsh-claude 读的时候直接抛')
		check(JSON.stringify(JSON.parse(fs.readFileSync(parentFile, 'utf8'))) === JSON.stringify(parentDocument), '父分支的 sidecar 一个字节都不能动')
		console.log('       绑定 / 接续点 / 裁剪 / 父分支未被动 —— 全部正确')

		// 再接管一次：已经有 sidecar 了，必须拒绝覆盖
		const snapshot = fs.readFileSync(childFile, 'utf8')
		adoptBranch(ctx, claudeCase)
		check(fs.readFileSync(childFile, 'utf8') === snapshot, '已经跑过的分支绝不能被二次覆盖')
		console.log('断言 B2：重复接管不会覆盖已跑过的分支')
	}
}

// ===== 第 5 步：断言 B3 —— 父会话正在跑的时候，一个字节都不读 =====
//
// 这是最要命的一条。读父会话的旁车会让 dsh-claude 的原子写 rename 撞上 EPERM，
// 它把那当成"Claude Code 掉线"，**整轮判失败而且故意不重放**。
// 所以宁可让新分支没有上下文（界面上会明说），也绝不在它跑着的时候去读。
{
	const busyCase = branches.find((agent) => {
		const parentId = agent.session.header.parentSession
		return parentId !== undefined && fs.existsSync(path.join(SIDECARS, sidecarName(parentId)))
	})
	if (busyCase === undefined) console.log('断言 B3：跳过（盘上没有 claude 分支）')
	else {
		const childFile = path.join(sidecarDir, sidecarName(busyCase.id))
		fs.rmSync(childFile, { force: true })
		const asked = []
		const busyCtx = {
			logger: { info() {}, warn() {} },
			agents: { get: (id) => (asked.push(id), { status: 'running' }) },
		}
		adoptBranch(busyCtx, rewind(busyCase.id))
		check(!fs.existsSync(childFile), '父会话在跑的时候，绝不能写出 sidecar —— 写了就说明读过它')
		check(asked.length > 0, '压根没问过"它在不在跑"，那这道闸等于不存在')

		// 反过来：同一个分支，父会话空闲时必须照常接上 —— 否则这道闸就是把功能关了
		adoptBranch(ctx, rewind(busyCase.id))
		check(fs.existsSync(childFile), '父会话空闲时必须照常接上上下文（闸不能把功能一起关掉）')

		// 认不出状态时必须当成"在跑"（fail-closed）：赌错了的代价是打死用户一轮对话
		fs.rmSync(childFile, { force: true })
		adoptBranch({ logger: { info() {}, warn() {} } }, rewind(busyCase.id))
		check(!fs.existsSync(childFile), '问不出会话状态时必须当成"在跑"，不许乐观放行')

		// 直接调 graft 而漏给 isBusy：必须当场拒绝，不许"默认谁都不在跑"。
		// 这是个**沉默的**错误路径 —— 漏给一个参数就等于把整道闸拆了，
		// 而拆了之后一切看起来都正常，直到某天打死用户一轮对话。
		const sloppy = host.graft(busyCase.id, busyCase.session.header.parentSession, 1)
		check(sloppy.grafted === false && sloppy.reason === 'bad-request', `漏给 isBusy 时必须拒绝，实际 ${JSON.stringify(sloppy)}`)
		check(!fs.existsSync(childFile), '漏给 isBusy 却还是写了文件 —— 那道闸形同虚设')

		// 把世界恢复成断言 B 留下的样子：那份 sidecar 本来就该在，
		// 下面第 6 步要数文件个数，少一份的话重启重放那一段会把它又建出来
		adoptBranch(ctx, rewind(busyCase.id))
		console.log('断言 B3：父会话在跑 / 状态认不出 → 不读不写；空闲 → 照常接上')
	}
}

// ===== 第 6 步：断言 C —— 不该动的时候一个字节都不动 =====

const before = new Set(fs.readdirSync(sidecarDir))

// 普通 provider：血缘上一个 sidecar 都没有 → 什么都不该发生
const plain = branches.find((agent) => {
	const parentId = agent.session.header.parentSession
	return parentId !== undefined && !fs.existsSync(path.join(SIDECARS, sidecarName(parentId)))
})
if (plain !== undefined) {
	adoptBranch(ctx, plain)
	check(!fs.existsSync(path.join(sidecarDir, sidecarName(plain.id))), '普通 provider 路径上一个文件都不许写')
}

// **重启重放**：dsh 起来时会把盘上每个会话 resume 一遍，`agent/created` 照样触发。
// 那时队列里可能正躺着用户自己排的待办 —— 删掉就是丢数据。
// 因为只按"继承段折出来的 id"删，用户后来排的那条 id 对不上，天然安全。
const restarted = rewind(branches[0].id)
restarted.inbox.nextTurn.push({ id: 'mine-own-id', content: [{ type: 'text', text: '我自己排的队' }] })
adoptBranch(ctx, restarted)
check(
	restarted.inbox.nextTurn.some((message) => message.id === 'mine-own-id'),
	'重启重放时，用户自己排的待办绝不能被删掉',
)
check(
	restarted.inbox.nextTurn.every((message) => message.id === 'mine-own-id') && restarted.inbox.nextStep.length === 0,
	'继承来的那几条还是要删干净',
)

// 不是分支（isSeeded 不为 true）→ 直接跳过，连队列都不许碰
let touched = false
adoptBranch(ctx, {
	id: 'session-plain',
	inbox: {
		nextTurn: [{ id: 'x', content: [{ type: 'text', text: '用户自己排的队' }] }],
		nextStep: [],
		hasPending: true,
		remove() {
			touched = true
			return true
		},
	},
	session: { id: 'session-plain', inheritedEventCount: 0, header: { isSeeded: false }, snapshotEvents: () => [] },
})
check(touched === false, '普通会话（不是分支）的待办绝不能被清掉')

// sidecar 版本变了 → 立刻装死
if (claudeCase !== undefined) {
	const parentId = claudeCase.session.header.parentSession
	const parentCopy = path.join(sidecarDir, sidecarName(parentId))
	const saved = fs.readFileSync(parentCopy, 'utf8')
	fs.writeFileSync(parentCopy, JSON.stringify({ ...JSON.parse(saved), schemaVersion: 2 }))
	const victim = { ...claudeCase, id: 'session-future', session: { ...claudeCase.session, id: 'session-future' } }
	lineage.set('session-future', parentId)
	adoptBranch(ctx, victim)
	check(!fs.existsSync(path.join(sidecarDir, sidecarName('session-future'))), 'sidecar 版本对不上时必须停手，不许写')
	fs.writeFileSync(parentCopy, saved)
}

check(
	[...fs.readdirSync(sidecarDir)].filter((name) => !before.has(name)).length === 0,
	`第5步不该产生任何新文件，实际多了 ${[...fs.readdirSync(sidecarDir)].filter((name) => !before.has(name))}`,
)
console.log('断言 C：不该动的情况下，一个字节都没动')

fs.rmSync(home, { recursive: true, force: true })
report()
