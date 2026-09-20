/**
 * 撤回（rewind）：把已经不在对话里的那几轮从树上摘掉。
 *
 * dsh-claude 的「撤回」**不删日志、也不开新会话**：它只在自己的旁车里记一组
 * hidden `ranges`（界面行的 seq 区间），前端拿 CSS 把那些行藏起来，claude 那边
 * 用 `resumeSessionAt` 从更早的锚点重开。详见 NATIVE-BASELINE.md §4。
 *
 * 于是日志里那几轮**原封不动地还在**。我们只折日志的话，撤回过的 4 会继续画在
 * 树上，而且后来发的 5 会接在 4 底下，画成 1-2-3-4-5 —— 可 4 已经不在对话里了。
 *
 * 两种情形要分开（John 报的原话）：
 *   · 4 答完了才撤回 → 4 是一条**真的走过又被放弃的支线**，留着，但 5 接到 3 上，
 *     画成 1-2-3-4 和 1-2-3-5 两条。
 *   · 4 答到一半被中止再撤回 → 这一轮压根没留下什么，节点直接不画，只剩 1-2-3-5。
 * 「留着还是不画」由 `entry.done` 定（见 outline.js），成形放在浏览器半的 buildGraph。
 */
import { readFileSync, statSync } from 'node:fs'
import { SIDECAR_SCHEMA_VERSION, sidecarPath } from './paths.js'

// ===== ⚠️⚠️ 读旁车会打断正在跑的那一轮 —— 这一段的规矩不许放宽 =====
//
// Windows 上，**只要有任何别的句柄开着目标文件，`rename` 覆盖它就是 EPERM**。
// 而 dsh-claude 每 150ms（TEXT_FLUSH_MS）就要把对话正文原子落盘一次：
// 写 `.tmp` → `rename` 盖掉旁车。那个 rename 抛出来的异常会从它的消息泵里冒出去，
// 被当成「Claude Code 掉线」——**整轮当场判失败，而且它故意不重发**
// （那一轮已经动过文件、提过 git，重放会重复副作用）。
//
// 这不是推测，是 2026-09-20 真炸过一次：
//   {"kind":"error","error":{"message":"Claude Code exited after activity; ..."}}
//   detail: EPERM: operation not permitted, rename '<旁车>.<pid>.<uuid>.tmp' -> '<旁车>'
// 第一版的我在每次 /outlines 里都 readFileSync 一遍 6.3MB 的旁车，句柄要开约 10ms，
// 对面每 150ms 一次 rename —— **每读一次就有约 7% 的概率打死正在跑的那一轮**。
// 复现只要三行：开着读句柄，另一边 renameSync 覆盖，当场 EPERM。
//
// 所以规矩是：**这条会话有轮次在跑，就一个字节都不许读。**
//   · 判据用 `ctx.agents.get(id).status`（权威）——冷会话没有 agent，没人写它，随便读。
//   · 再加一道 mtime 静默期，挡住 turn/end 之后那次迟到的 flush。
//   · 读不到就沿用上一次读到的，并把 `rewindPending` 报给前端：撤回不会在一轮**跑着的时候**
//     发生（按钮在历史消息行上），所以缓存在这一轮里必然还是对的；前端等它跑完再来拉一次。
//
// ⚠️ 别改成「缩短读的时间就行」（只读文件尾、只读前 64 字节……）：窗口小了不等于没有，
//    而代价是整轮对话当场失败。也别改成 mtime 静默期单独判 —— 一轮里跑长命令时
//    旁车可以安静好几分钟，然后突然写。**必须以"有没有 agent 在跑"为准。**

/** 没有撤回时共用这一个空数组，省得每个会话都新建一个。 */
export const NO_RANGES = []

/** 读不到也没缓存时的答复。 */
export const NO_REWIND = { ranges: NO_RANGES, pending: false }

/**
 * 旁车静默多久才敢碰。`turn/end` 之后还可能有一次迟到的 flush（TEXT_FLUSH_MS = 150ms），
 * 给它十倍的余量。
 */
export const SIDECAR_QUIET_MS = 1500

/**
 * 撤回区间的缓存：sessionId → `{stamp, ranges}`，stamp 是旁车文件的 mtime+size。
 *
 * 不跟着 `cache`（大纲缓存）走：大纲按会话 revision 失效，而**撤回不写 dsh 日志**，
 * revision 一点不动，挂在那上面就永远刷不出来。
 */
export const hiddenCache = new Map()

/**
 * 造一个「这条会话现在什么状态」的判据。
 *
 * ⚠️ 三态，**别压成布尔**。两个调用方对"认不出来"的处理正好相反：
 *   · 读旁车：`unknown` 当成在跑（不读）—— 赌错了是打死整轮对话。
 *   · 拦合并：`unknown` 当成空闲（放行）—— 赌错了只是让人合并了一条正在跑的对话，
 *     而合并只写 shape.json，不碰对话本身。压成布尔必然有一头是错的。
 * @param ctx - 插件 context
 * @returns `(sessionId) => 'running' | 'idle' | 'unknown'`
 */
export function statusProbe(ctx) {
	return (sessionId) => {
		try {
			const registry = ctx && ctx.agents
			if (registry === undefined || typeof registry.get !== 'function') return 'unknown'
			const agent = registry.get(sessionId)
			// 冷会话根本没有 agent —— 没人在写它的旁车
			if (agent === undefined) return 'idle'
			return agent.status === 'running' ? 'running' : 'idle'
		} catch {
			return 'unknown'
		}
	}
}

/**
 * 这个会话被撤回掉的行区间。
 * @param busy - `(sessionId) => boolean`，这条会话是不是有轮次在跑
 * @param sessionId - dsh 会话 id
 * @returns `{ranges, pending}`；`pending` 表示这次没敢读，用的是上一次的结果
 */
export function rewindStateOf(busy, sessionId) {
	const file = sidecarPath(sessionId)
	let stamp
	let quiet = false
	try {
		const stat = statSync(file)
		stamp = `${stat.mtimeMs}:${stat.size}`
		quiet = Date.now() - stat.mtimeMs >= SIDECAR_QUIET_MS
	} catch {
		hiddenCache.delete(sessionId)
		return NO_REWIND // 没有旁车 = 不是 claude 会话，压根没有撤回这回事
	}
	const hit = hiddenCache.get(sessionId)
	if (hit !== undefined && hit.stamp === stamp) return { ranges: hit.ranges, pending: false }
	if (busy(sessionId) || !quiet) return { ranges: hit === undefined ? NO_RANGES : hit.ranges, pending: true }
	const ranges = readHiddenRanges(file)
	hiddenCache.set(sessionId, { stamp, ranges })
	return { ranges, pending: false }
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
export function readHiddenRanges(file) {
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
export function turnHidden(entry, ranges) {
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
export function markRewound(turns, ranges) {
	if (!Array.isArray(turns) || ranges.length === 0) return turns
	return turns.map((entry) => (turnHidden(entry, ranges) ? Object.assign({}, entry, { rewound: true }) : entry))
}
