/**
 * 把"好几个 DSH 会话共用同一个 Claude Code 会话"的局面拆开。
 *
 * 【怎么来的】graft（graft.js）把父分支的 `binding` 原样抄给新分支，只多一个
 * `rewind.pending.resumeAt`。这在 dsh-claude 只传 `resumeSessionAt`、不传 `forkSession`
 * 的时候意味着：父子两条 DSH 会话指向**同一个** Claude 会话文件。新分支第一次起进程
 * 是从锚点续、没问题；可之后任何一方的进程被重启（空闲回收、重启 dsh），都是不带
 * `resumeSessionAt` 的 `resume` —— CLI 从那个文件的**最新叶子**续，也就是另一支的尾巴。
 * John 的原话："明明分叉了，记忆却互通"。2026-09-22 盘上数出来：8 个 Claude 会话
 * 被 36 个 DSH 会话共用，其中一个被 14 个共用。
 *
 * 【根治在哪】dsh-claude 那一行要加 `forkSession: true`（`$DSH_HOME/profiles/web/patches/`
 * 里那份补丁）。补丁只管**以后**。这个模块管**过去**：已经共用的那些。
 *
 * 【第一版为什么错了】第一版只给每条会话武装 `pending.resumeAt = 它自己最后一个锚点`，
 * 指望打上补丁后 CLI 自己去 fork。实测 CLI 的 `--resume-session-at` **只认"当前链"**——
 * 从文件最后一行沿 parentUuid 往上那一条；共用文件里交织着十条分支，不在当前链上的
 * 锚点它一概"No message found with message.uuid of …"。36 条里 24 条撞这个错，
 * 而且 pending 永远清不掉，那条会话每次开口都失败（John 报的"蛮致命的"）。
 * SDK 独立的 `forkSession(upToMessageId)` 也一样只认当前链，实测切出来的文件里根本没有那个锚点。
 *
 * 【现在的做法】自己 fork：锚点的**祖先链**（沿 parentUuid 往上到根）全在文件里，
 * 不管它在不在当前链上。把这条链按原顺序抄成一个新文件、`sessionId` 改成新 id，
 * sidecar 改绑到新 id、pending 清掉。CLI 自己 `--fork-session` 出来的文件也就是这个样子
 * （链上记录 + 改 sessionId，连 forkedFrom 都不写）。老文件留着当档案。
 *
 * ⚠️ **只能在 dsh 停着的时候跑。** 理由见 rewind.js 开头那段 EPERM 的账。
 *    CLI 包装（split-shared-claude.mjs）会先看有没有 dsh 进程在，有就拒绝。
 *
 * 规划（planSplit）是纯函数；抄链（forkTranscript）是纯函数；落盘（applySplit）只做两件事：
 * 写新记录文件、改 sidecar 的 binding 并删 pending。别的字段一个都不碰。
 */
import { readdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { SIDECAR_SCHEMA_VERSION, atomicWrite, readJsonFile } from './paths.js'

/**
 * Claude Code 存记录的根目录：`$CLAUDE_CONFIG_DIR/projects`，默认 `~/.claude/projects`。
 * @returns 绝对路径
 */
export function claudeProjectsDir() {
	const configured = process.env.CLAUDE_CONFIG_DIR
	const home = configured && configured.trim().length > 0 ? resolve(configured.trim()) : join(homedir(), '.claude')
	return join(home, 'projects')
}

/**
 * 一个工作目录对应的记录桶名：非字母数字全换成 `-`。
 * 实测 `D:\JRJ\DeepSeek-Harness\INIT` → `D--JRJ-DeepSeek-Harness-INIT`。
 * @param cwd - 会话的工作目录
 * @returns 桶名
 */
export function bucketOf(cwd) {
	return String(cwd || '').replace(/[^A-Za-z0-9]/g, '-')
}

/**
 * 读一份记录文件。坏行跳过（CLI 自己也这么干）。
 * @param file - 绝对路径
 * @returns 记录数组，读不到就 undefined
 */
export function readTranscript(file) {
	let text
	try {
		text = readFileSync(file, 'utf8')
	} catch {
		return undefined
	}
	const rows = []
	for (const line of text.split('\n')) {
		if (line.trim() === '') continue
		try {
			rows.push(JSON.parse(line))
		} catch {
			/* 坏行 */
		}
	}
	return rows
}

/**
 * 当前链：从最后一条带 uuid 的记录沿 parentUuid 往上。CLI resume / fork 只看得见这一条。
 * @param rows - 记录数组
 * @returns uuid 集合
 */
export function currentChain(rows) {
	const by = new Map()
	for (const row of rows) if (row && typeof row.uuid === 'string') by.set(row.uuid, row)
	const chain = new Set()
	let hop
	for (let i = rows.length - 1; i >= 0; i -= 1) if (rows[i] && typeof rows[i].uuid === 'string') { hop = rows[i].uuid; break }
	while (hop !== undefined && by.has(hop) && !chain.has(hop)) {
		chain.add(hop)
		hop = by.get(hop).parentUuid
	}
	return chain
}

/**
 * 锚点的祖先链，按文件原顺序。
 *
 * 从锚点沿 parentUuid 往上走到 `parentUuid == null` 的根；中途缺一环就当没有这条链
 * （返回 undefined）—— 半条链 resume 出来的是一段掐头的对话，比不修更糟。
 * @param rows - 记录数组
 * @param anchorUuid - 锚点 uuid
 * @returns 链上记录（文件顺序），或 undefined
 */
export function chainRecords(rows, anchorUuid) {
	const by = new Map()
	for (const row of rows) if (row && typeof row.uuid === 'string') by.set(row.uuid, row)
	if (!by.has(anchorUuid)) return undefined
	const keep = new Set()
	let hop = anchorUuid
	while (hop !== undefined && hop !== null) {
		if (!by.has(hop) || keep.has(hop)) return undefined // 断链或成环
		keep.add(hop)
		hop = by.get(hop).parentUuid
	}
	return rows.filter((row) => row && keep.has(row.uuid))
}

/**
 * 把一条链抄成一份新会话的记录文件正文。
 * @param rows - 源文件记录
 * @param anchorUuid - 锚点
 * @param newId - 新会话 id
 * @returns `{text, count, last}`，链不完整就 undefined
 */
export function forkTranscript(rows, anchorUuid, newId) {
	const chain = chainRecords(rows, anchorUuid)
	if (chain === undefined || chain.length === 0) return undefined
	const lines = chain.map((row) => JSON.stringify({ ...row, sessionId: newId }))
	return { text: `${lines.join('\n')}\n`, count: chain.length, last: chain[chain.length - 1].uuid }
}

/**
 * 一份旁车里"从自己最后一轮续"要用的锚点。
 * @param document - sidecar 文档
 * @returns 最后一个锚点，或 undefined
 */
function lastAnchorOf(document) {
	const anchors = document && document.rewind && Array.isArray(document.rewind.anchors) ? document.rewind.anchors : []
	const last = anchors[anchors.length - 1]
	return last && typeof last.uuid === 'string' && Number.isSafeInteger(last.turn) ? last : undefined
}

/**
 * 规划：哪几条会话要 fork、从哪个锚点 fork。
 *
 * 只挑同时满足三条的：① 认得的 schema；② 有 binding；③ 那个 claudeSessionId 被
 * **不止一条** DSH 会话绑着。共用的每一条都 fork —— 不区分"原来的那条"，
 * 共用文件里没有谁是原来的，谁最后写的谁的叶子在当前链上，那是运气不是身份。
 * 老文件留着当档案，fork 完谁也不再往里写。
 *
 * 报 stuck 的三种：没锚点（一轮都没跑过）、记录文件不存在、锚点不在文件里或链断了。
 * 这三种下次起进程仍会从共享文件的当前链续；用户得知道。
 *
 * @param entries - `[{sessionId, document}]`，全部旁车
 * @param transcriptOf - `(claudeSessionId, cwd) => rows | undefined`
 * @returns `{fork: [{sessionId, claudeSessionId, cwd, anchor, turn, newId}], stuck: [{sessionId, claudeSessionId, why}], groups}`
 */
export function planSplit(entries, transcriptOf) {
	const byClaude = new Map()
	for (const { sessionId, document } of entries) {
		if (!document || document.schemaVersion !== SIDECAR_SCHEMA_VERSION) continue
		const binding = document.binding
		const id = binding && binding.claudeSessionId
		if (typeof id !== 'string' || id.length === 0) continue
		if (!byClaude.has(id)) byClaude.set(id, [])
		byClaude.get(id).push({ sessionId, document })
	}
	const fork = []
	const stuck = []
	const groups = []
	for (const [claudeSessionId, members] of byClaude) {
		if (members.length < 2) continue
		groups.push({ claudeSessionId, sessions: members.map((item) => item.sessionId) })
		for (const { sessionId, document } of members) {
			const cwd = document.binding.cwd
			const last = lastAnchorOf(document)
			if (last === undefined) {
				stuck.push({ sessionId, claudeSessionId, why: 'no-anchor' })
				continue
			}
			const rows = transcriptOf(claudeSessionId, cwd)
			if (rows === undefined) {
				stuck.push({ sessionId, claudeSessionId, why: 'no-transcript' })
				continue
			}
			if (chainRecords(rows, last.uuid) === undefined) {
				stuck.push({ sessionId, claudeSessionId, why: 'broken-chain' })
				continue
			}
			fork.push({ sessionId, claudeSessionId, cwd, anchor: last.uuid, turn: last.turn, newId: randomUUID() })
		}
	}
	return { fork, stuck, groups }
}

/**
 * 读一个目录下的全部旁车。文件名是会话 id 的 base64url，反解回来当 sessionId。
 * @param dir - `$DSH_HOME/plugins/dsh-claude/sessions`
 * @returns `[{sessionId, file, document}]`
 */
export function readSidecarDir(dir) {
	const out = []
	let names
	try {
		names = readdirSync(dir)
	} catch {
		return out
	}
	for (const name of names) {
		if (!name.endsWith('.json')) continue
		const file = join(dir, name)
		const document = readJsonFile(file)
		if (document === undefined) continue
		let sessionId
		try {
			sessionId = Buffer.from(name.slice(0, -5), 'base64url').toString('utf8')
		} catch {
			continue
		}
		out.push({ sessionId, file, document })
	}
	return out
}

/**
 * 落盘：按规划给每条会话 fork 出自己的记录文件，并改绑旁车。
 *
 * 顺序是**先写记录文件，再改旁车**：旁车一改，下次起进程就会去找那个文件，
 * 反过来的话有一瞬间是"指着一个还不存在的文件"。
 * 改旁车前再读一遍原文，确认 binding 仍是规划时那个 —— 中间被别人改过就跳过。
 * 只动 `binding.claudeSessionId` 和 `rewind.pending`，其它字段原样保留。
 * @param entries - `readSidecarDir` 的结果
 * @param plan - `planSplit` 的结果
 * @param io - `{transcriptOf(claudeSessionId, cwd), transcriptPathOf(newId, cwd)}`
 * @returns `{written: [{sessionId, newId, count}], skipped: [{sessionId, why}]}`
 */
export function applySplit(entries, plan, io) {
	const fileOf = new Map(entries.map((item) => [item.sessionId, item.file]))
	const written = []
	const skipped = []
	for (const step of plan.fork) {
		const file = fileOf.get(step.sessionId)
		const fresh = file === undefined ? undefined : readJsonFile(file)
		if (fresh === undefined || fresh.schemaVersion !== SIDECAR_SCHEMA_VERSION) {
			skipped.push({ sessionId: step.sessionId, why: 'unreadable' })
			continue
		}
		if (!fresh.binding || fresh.binding.claudeSessionId !== step.claudeSessionId) {
			skipped.push({ sessionId: step.sessionId, why: 'binding-changed' })
			continue
		}
		const rows = io.transcriptOf(step.claudeSessionId, step.cwd)
		const forked = rows === undefined ? undefined : forkTranscript(rows, step.anchor, step.newId)
		if (forked === undefined) {
			skipped.push({ sessionId: step.sessionId, why: 'broken-chain' })
			continue
		}
		atomicWrite(io.transcriptPathOf(step.newId, step.cwd), forked.text)
		const rewind = fresh.rewind || { ranges: [], anchors: [], snapshots: [] }
		const next = {
			...fresh,
			binding: { ...fresh.binding, claudeSessionId: step.newId },
			rewind: {
				ranges: Array.isArray(rewind.ranges) ? rewind.ranges : [],
				anchors: Array.isArray(rewind.anchors) ? rewind.anchors : [],
				snapshots: Array.isArray(rewind.snapshots) ? rewind.snapshots : [],
			},
		}
		atomicWrite(file, `${JSON.stringify(next)}\n`, { dirMode: 0o700 })
		written.push({ sessionId: step.sessionId, newId: step.newId, count: forked.count })
	}
	return { written, skipped }
}

/**
 * 真实盘上的 io：记录文件在 `claudeProjectsDir()/<桶>/<id>.jsonl`。
 * @returns `{transcriptOf, transcriptPathOf}`
 */
export function diskIo() {
	const cache = new Map()
	return {
		transcriptPathOf: (id, cwd) => join(claudeProjectsDir(), bucketOf(cwd), `${id}.jsonl`),
		transcriptOf(id, cwd) {
			const file = join(claudeProjectsDir(), bucketOf(cwd), `${id}.jsonl`)
			if (!cache.has(file)) cache.set(file, readTranscript(file))
			return cache.get(file)
		},
	}
}
