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
 * 里那份补丁）。补丁只管**以后**：已经共用的那些，下次起进程照样从共享文件的最新叶子续。
 * 这个模块管**过去**：给每条"共用且没武装 pending"的会话武装上
 * `pending = { resumeAt: 它自己最后一个锚点 }`。打上补丁后它下次起进程就会从自己的
 * 最后一轮分叉出一个只属于自己的 Claude 会话；原文件留着当档案，谁也不再往里写。
 *
 * ⚠️ **只能在 dsh 停着的时候跑。** 理由见 rewind.js 开头那段 EPERM 的账：会话在跑，
 *    dsh-claude 每 150ms 原子覆盖一次旁车，这边开着句柄它就 EPERM、整轮判失败。
 *    冷会话没人写旁车，随便读写。CLI 包装（split-shared-claude.mjs）会先看有没有
 *    dsh 进程在，有就拒绝。
 *
 * 规划（planSplit）是纯函数，落盘（applySplit）只做一件事：按规划写 pending。
 * 别的字段一个都不碰 —— 这不是重写旁车，是给它补一个它自己本来就会写的字段。
 */
import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { SIDECAR_SCHEMA_VERSION, atomicWrite, readJsonFile } from './paths.js'

/**
 * 一份旁车里"还能不能从自己最后一轮续"的判断。
 * @param document - sidecar 文档
 * @returns 最后一个锚点，或 undefined
 */
function lastAnchorOf(document) {
	const anchors = document && document.rewind && Array.isArray(document.rewind.anchors) ? document.rewind.anchors : []
	const last = anchors[anchors.length - 1]
	return last && typeof last.uuid === 'string' && Number.isSafeInteger(last.turn) ? last : undefined
}

/**
 * 规划：哪几条会话要武装、武装成什么。
 *
 * 只挑同时满足四条的：① 认得的 schema；② 有 binding；③ 那个 claudeSessionId 被
 * **不止一条** DSH 会话绑着；④ 还没武装 pending。四条缺一都不动 ——
 * 尤其 ④：已经武装的那条（可能是 graft 刚种的）有自己的 resumeAt，覆盖它等于把
 * 岔路点挪到别处去。
 *
 * 会话有 binding 却一个锚点都没有（拿到指针但一轮都没跑过）→ 武装不了，报出来。
 * 这种会话下次起进程仍会从共享文件的最新叶子续；用户得知道。
 *
 * @param entries - `[{sessionId, document}]`，全部旁车
 * @returns `{arm: [{sessionId, claudeSessionId, resumeAt, turn}], stuck: [{sessionId, claudeSessionId, why}], groups}`
 */
export function planSplit(entries) {
	const byClaude = new Map()
	for (const { sessionId, document } of entries) {
		if (!document || document.schemaVersion !== SIDECAR_SCHEMA_VERSION) continue
		const id = document.binding && document.binding.claudeSessionId
		if (typeof id !== 'string' || id.length === 0) continue
		if (!byClaude.has(id)) byClaude.set(id, [])
		byClaude.get(id).push({ sessionId, document })
	}
	const arm = []
	const stuck = []
	const groups = []
	for (const [claudeSessionId, members] of byClaude) {
		if (members.length < 2) continue
		groups.push({ claudeSessionId, sessions: members.map((item) => item.sessionId) })
		for (const { sessionId, document } of members) {
			const pending = document.rewind && document.rewind.pending
			if (pending !== undefined && pending !== null) continue // ④ 已武装的不碰
			const last = lastAnchorOf(document)
			if (last === undefined) {
				stuck.push({ sessionId, claudeSessionId, why: 'no-anchor' })
				continue
			}
			arm.push({ sessionId, claudeSessionId, resumeAt: last.uuid, turn: last.turn })
		}
	}
	return { arm, stuck, groups }
}

/**
 * 读一个目录下的全部旁车。文件名是会话 id 的 base64url，反解回来当 sessionId。
 * 读坏的一律跳过（planSplit 也认不得它）。
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
 * 落盘：按规划给每条会话补上 `rewind.pending`。
 *
 * 写之前再读一遍原文，确认它**仍然**没武装 —— 规划和落盘之间哪怕只隔一瞬，
 * 也不许覆盖别人刚种的 pending。其它字段原样保留。
 * @param entries - `readSidecarDir` 的结果
 * @param plan - `planSplit` 的结果
 * @returns `{written: [sessionId], skipped: [{sessionId, why}]}`
 */
export function applySplit(entries, plan) {
	const fileOf = new Map(entries.map((item) => [item.sessionId, item.file]))
	const written = []
	const skipped = []
	for (const step of plan.arm) {
		const file = fileOf.get(step.sessionId)
		const fresh = file === undefined ? undefined : readJsonFile(file)
		if (fresh === undefined || fresh.schemaVersion !== SIDECAR_SCHEMA_VERSION) {
			skipped.push({ sessionId: step.sessionId, why: 'unreadable' })
			continue
		}
		const rewind = fresh.rewind || { ranges: [], anchors: [], snapshots: [] }
		if (rewind.pending !== undefined && rewind.pending !== null) {
			skipped.push({ sessionId: step.sessionId, why: 'already-armed' })
			continue
		}
		const next = {
			...fresh,
			rewind: {
				ranges: Array.isArray(rewind.ranges) ? rewind.ranges : [],
				anchors: Array.isArray(rewind.anchors) ? rewind.anchors : [],
				snapshots: Array.isArray(rewind.snapshots) ? rewind.snapshots : [],
				pending: { resumeAt: step.resumeAt },
			},
		}
		atomicWrite(file, `${JSON.stringify(next)}\n`, { dirMode: 0o700 })
		written.push(step.sessionId)
	}
	return { written, skipped }
}
