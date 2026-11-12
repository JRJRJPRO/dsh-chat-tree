/**
 * 分支血缘的补记 —— 宿主漏写 `parentSession` 时，由我们自己记住"这条分支从哪来"。
 *
 * 【为什么需要】桌面版 0.2.2-rc.1 的 `session.fork` 给子会话写 header 时只塞了
 *   `cwd / isSeeded / agentPreset`，**没有 `parentSession`**（dsh 源码 rc2 那一行还在，
 *   安装版 app.asar 里搜 `parentSession: source.header.id` 是 0 处）。后果不是"少个字段"：
 *   分支自己的轮次全被标成 inherited（树上不画），本该由父会话的节点接上；父链一断，
 *   这棵树就只剩一个空根，侧栏折叠（顺 parentId 上爬）也折不进去。
 *
 * 【两条来源，先便宜后兜底】
 *   ① 我们自己开的岔路：浏览器半 fork 成功后先 POST `/parent` 再切过去，这里落盘。
 *      一次写盘，之后 O(1) 命中。
 *   ② 没记录过的分支（宿主原生按钮开的、装这个修复之前建的）：拿它自己的**继承前缀**
 *      去同 cwd 的会话里逐轮比对 —— 轮次号 + turn/start 的 seq + 提问预览。fork 是
 *      逐字节抄前缀，这三样一起对上基本只有父亲。猜中一次就落盘，之后不再猜。
 *      比对用的是 collect 已经读进内存的大纲，**不额外读盘**。
 *
 * 【为什么不去日志里翻别的会话 id】继承前缀里确实会出现别的 id，但那是 `job/*` 的
 *   owner、subagent 目录之类，跟父亲没关系（实测这条分支里只有一条，还是错的）。
 *   按那个接，树会比现在接得更歪。
 *
 * 落盘 `$DSH_HOME/plugins/dsh-chat-tree/parents.json`，和 shape / labels 放一块。
 * 读坏了 / 版本不对一律当空 —— 丢了只是这些分支回到"单独一棵树"，不该把导轨带崩。
 */
import { statSync } from 'node:fs'
import { atomicWrite, pluginFile, readJsonFile } from './paths.js'

/**
 * 落盘位置。
 * @returns 绝对路径
 */
export function parentsPath() {
	return pluginFile('parents.json')
}

/** 空白文档。 */
export const EMPTY_PARENTS = { version: 1, parents: {} }

/** 最近一次读到的内容。文件没变（mtime 一样）就不重读、不重解析。 */
let cached

/**
 * 把盘上的东西收成干净的一份：只留非空字符串，自己和自己的环直接丢。
 * @param document - 解析出来的东西
 * @returns 干净的文档
 */
function normalize(document) {
	if (document === null || typeof document !== 'object' || document.version !== 1) return EMPTY_PARENTS
	if (document.parents === null || typeof document.parents !== 'object' || Array.isArray(document.parents)) return EMPTY_PARENTS
	const parents = {}
	for (const [child, parent] of Object.entries(document.parents)) {
		if (typeof child !== 'string' || child.length === 0) continue
		if (typeof parent !== 'string' || parent.length === 0 || parent === child) continue
		parents[child] = parent
	}
	return { version: 1, parents }
}

/**
 * 读血缘补记。读不到 / 读坏了 / 版本对不上一律退回空白。
 * @returns 血缘文档
 */
export function readParents() {
	const file = parentsPath()
	let stat
	try {
		stat = statSync(file)
	} catch {
		cached = undefined
		return EMPTY_PARENTS
	}
	if (cached !== undefined && cached.file === file && cached.mtimeMs === stat.mtimeMs) return cached.doc
	const doc = normalize(readJsonFile(file))
	cached = { file, mtimeMs: stat.mtimeMs, doc }
	return doc
}

/**
 * 写血缘补记（原子写），并把读缓存作废。
 * @param next - 完整文档
 * @returns 写进去的文档
 */
function writeParents(next) {
	atomicWrite(parentsPath(), `${JSON.stringify(next)}\n`)
	cached = undefined
	return next
}

/**
 * 记一笔"这条分支是从哪条会话开出来的"。
 *
 * 只记一层父子关系，不解析链：爸爸自己有没有爸爸，等 resolveParents 顺着走。
 * 同样的 child 再记一次就是覆盖 —— 同一条分支不可能有两个父亲。
 * @param patch - `{session, parent}`
 * @returns 写完的文档
 */
export function rememberParent(patch) {
	const child = patch === undefined || patch === null ? undefined : patch.session
	const parent = patch === undefined || patch === null ? undefined : patch.parent
	if (typeof child !== 'string' || child.length === 0) throw new Error('记血缘需要 session')
	if (typeof parent !== 'string' || parent.length === 0) throw new Error('记血缘需要 parent')
	if (parent === child) throw new Error('分支的父亲不能是它自己')
	const current = readParents()
	const parents = Object.assign({}, current.parents, { [child]: parent })
	return writeParents({ version: 1, parents })
}

/**
 * 两条大纲能不能对上是"同一段前缀"。
 *
 * fork 抄的是**原始事件**，所以继承轮的 `turn`、`turn/start` 的 `seq`、以及提问预览
 * 逐字节相同。三样一起对上，误判的概率远低于只比标题或时间。
 * @param turns - 候选父亲的大纲轮次
 * @param inherited - 子分支继承来的轮次
 * @returns 是不是都对得上
 */
function prefixMatches(turns, inherited) {
	if (turns.length < inherited.length) return false
	const byTurn = new Map()
	for (const entry of turns) byTurn.set(entry.turn, entry)
	for (const want of inherited) {
		const have = byTurn.get(want.turn)
		if (have === undefined) return false
		if (have.seq !== want.seq) return false
		if ((have.prompt || '') !== (want.prompt || '')) return false
	}
	return true
}

/**
 * 按继承前缀猜父亲。
 *
 * 候选里只有"比它早出生、且继承前缀对得上"的才算；多个都对得上时取**出生最晚**的
 * 那个 —— 先有父、后有子，离它最近的那个才可能是这一次 fork 的来源。
 * @param child - 子分支（collect 给的那条会话）
 * @param sessions - 同 cwd 的会话（含它自己）
 * @returns 父亲的会话 id，猜不出就是 undefined
 */
export function inferParent(child, sessions) {
	if (child === undefined || child === null) return undefined
	const inherited = (child.turns || []).filter(
		(entry) => entry !== null && entry !== undefined && entry.inherited === true && typeof entry.turn === 'number',
	)
	if (inherited.length === 0) return undefined
	if (typeof child.createdAt !== 'number') return undefined
	let best
	for (const candidate of sessions || []) {
		if (candidate === undefined || candidate === null || candidate.id === child.id) continue
		if (typeof candidate.id !== 'string' || candidate.id.length === 0) continue
		if (typeof candidate.createdAt !== 'number' || candidate.createdAt > child.createdAt) continue
		if (!prefixMatches(candidate.turns || [], inherited)) continue
		if (best === undefined || candidate.createdAt >= best.createdAt) best = candidate
	}
	return best === undefined ? undefined : best.id
}

/**
 * 顺着父链往上走，撞回见过的 id 就是环。
 * @param id - 起点
 * @param parentOf - id → 父亲
 * @returns 是否有环
 */
function hasCycle(id, parentOf) {
	const seen = new Set([id])
	let at = parentOf.get(id)
	while (at !== undefined) {
		if (seen.has(at)) return true
		seen.add(at)
		at = parentOf.get(at)
	}
	return false
}

/**
 * 给一批会话补上父亲：**原地改 `sessions[i].parentId`**。
 *
 * 顺序：自己记过的 → 继承前缀猜 → 环检查。
 * 已经带 parentId 的一律不动（宿主哪天把字段写回来了，我们立刻退居二线）。
 * @param sessions - collect 收集到的那批（同 cwd）
 * @returns 补上的条数
 */
export function resolveParents(sessions) {
	const list = (sessions || []).filter((item) => item !== null && item !== undefined && typeof item.id === 'string')
	const known = new Set(list.map((item) => item.id))
	const doc = readParents()
	const orphans = list.filter(
		(item) => item.isSeeded === true && (typeof item.parentId !== 'string' || item.parentId.length === 0),
	)
	let fixed = 0
	// ① 自己记过的
	for (const item of orphans) {
		const parent = doc.parents[item.id]
		if (typeof parent === 'string' && parent !== item.id && known.has(parent)) {
			item.parentId = parent
			fixed += 1
		}
	}
	// ② 继承前缀猜一次，猜中就地落盘（只写这批新学到的，别每拉一次树都写盘）
	const learned = {}
	for (const item of orphans) {
		if (typeof item.parentId === 'string' && item.parentId.length > 0) continue
		const parent = inferParent(item, list)
		if (parent === undefined) continue
		item.parentId = parent
		learned[item.id] = parent
		fixed += 1
	}
	if (Object.keys(learned).length > 0) {
		try {
			writeParents({ version: 1, parents: Object.assign({}, doc.parents, learned) })
		} catch {
			// 落盘失败不影响这一次的树 —— 下次重新猜，结论一样
		}
	}
	// ③ 环：手改坏了 / 推断撞车，宁可断开也不要让遍历打转
	const parentOf = new Map()
	for (const item of list) {
		if (typeof item.parentId === 'string' && item.parentId.length > 0 && known.has(item.parentId)) parentOf.set(item.id, item.parentId)
	}
	for (const item of list) {
		if (!parentOf.has(item.id)) continue
		if (hasCycle(item.id, parentOf)) {
			item.parentId = undefined
			parentOf.delete(item.id)
			fixed -= 1
		}
	}
	return fixed
}
