/**
 * 把外部引擎（dsh-claude 这类桥接）的记忆嫁接给新分支。
 *
 * 普通 provider 走不到这里：对话原文就在 dsh 日志里，fork 抄过去就够了。
 * 例外是 dsh-claude 这类"把对话托管给外部引擎"的桥接 —— 日志里 assistant 正文是空的，
 * 真正的对话在 Claude Code 那边，dsh 只存一个指针。详见 DESIGN.md §4。
 *
 * **不依赖 dsh-claude**：不 import、不要求它装着，判据只有"那个指针文件在不在"。
 * 三道闸：版本对不上不碰 / 已有 sidecar 不覆盖 / 内容只从它自己写的合法文档里摘。
 * 最差只是新分支失忆，不会弄坏已有会话。全同步 IO —— 接管必须在 fork 返回前跑完。
 *
 * ⚠️ **还没修的同类风险**：下面 `readSidecar` 读的是**父会话**的旁车，而它没有
 *    `rewind.js` 里那道"在跑就不许读"的闸。父会话正跑着的时候从它身上开分支，
 *    有几率打断父会话那一轮（同一个 EPERM，见 rewind.js 顶上的警告）。
 *    两条路还没定：跳过 graft（新分支失忆），还是等父会话空下来（`adoptBranch`
 *    目前要求全同步，等不了）。**别在没想清楚之前顺手加个 try 就算完。**
 */
import { existsSync } from 'node:fs'
import { lineage } from './lineage.js'
import { SIDECAR_SCHEMA_VERSION, atomicWrite, readJsonFile, sidecarPath } from './paths.js'

/**
 * 读 sidecar。读不到 / 读坏了 / 版本对不上，一律当"没有"——结论都是不插手。
 * @param sessionId - dsh 会话 id
 * @returns sidecar 文档或 undefined
 */
export function readSidecar(sessionId) {
	const document = readJsonFile(sidecarPath(sessionId))
	return document && document.schemaVersion === SIDECAR_SCHEMA_VERSION ? document : undefined
}

/**
 * 沿血缘往上找"持有第 `turn` 轮锚点"的那份 sidecar。
 * 要往上找是因为 sidecar 只记它自己跑过的轮次，更早的在祖先那儿。
 * @param fromId - 起点会话 id
 * @param turn - 需要的轮次
 * @returns {document, sawSidecar}
 */
export function anchorSource(fromId, turn) {
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

	// 权限跟 dsh-claude 自己写的一致（目录 700 / 文件 600）。
	atomicWrite(target, `${JSON.stringify(document)}\n`, { dirMode: 0o700 })
	return { grafted: true, resumeAt: anchor.uuid, turn, activities: document.activities.length }
}
