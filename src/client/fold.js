/**
 * 左侧会话列表怎么折：一棵树只占一行，分支收在它底下。
 *
 * 【导读】
 * 宿主的侧栏把每条会话（fork 出来的分支也算）各画一行，树一多左边就是十几条
 * 标题几乎一样的记录。这里算的是"哪几行该归到哪一行底下"：
 *   ① foldHeads —— 每条会话归哪棵树（树的编号 = 树头那条会话的 id）
 *   ② foldRows  —— 给侧栏里**实际画出来的那几行**排座位：树头留在原位，分支紧跟其后
 *   ③ nextOpen  —— 哪几棵树是摊开的（存 localStorage，纯函数只算下一份清单）
 *
 * 全是**纯函数**，不碰 DOM。真正往宿主的行上贴记号的在 sidebar.js。
 *
 * 【树的边界怎么定】和导轨那边一致，但只到**会话粒度**：
 *   · 血缘：顺着 parentId 爬到根；
 *   · 拆（detached）：剪点所在的那条会话自己当树头，它底下的血缘跟着它走；
 *   · 认领（adopted）：登记过"我归剪点那棵"的会话，归到剪点那条会话的树；
 *   · 合并（groupOf）：根被登记进别人的组，就归到那个组（组号本身就是一条会话 id）。
 * 剪在一条会话**中间**的情况（前半截在旧树、后半截在新树），侧栏上一行就是一行，
 * 按"后半截"算 —— 这条会话整行挪到新树底下。
 */
import { indexOf } from './tree.js'

/** 摊开清单存在 localStorage 的键。 */
export const OPEN_KEY = 'dsh-chat-tree.sidebar-open'

/**
 * 节点 key（`<会话>:<轮次>`）里的会话 id。纯会话 id（老格式的 detached）原样返回。
 * @param key - 节点 key 或会话 id
 * @returns 会话 id；不是字符串就 undefined
 */
function sessionOfKey(key) {
	if (typeof key !== 'string' || key === '') return undefined
	const at = key.lastIndexOf(':')
	return at === -1 ? key : key.slice(0, at)
}

/**
 * 每条会话归哪棵树。
 *
 * 小例子：A ← B ← C，再把 C 的剪点剪断，D 是在 C 那棵树的前缀上开出来的、认领给了 C：
 *   A → A，B → A，C → C（自己是剪点），D → C（认领）。
 * 再把另一棵树 E 合进 A：E → A。
 *
 * 子代理（origin = 'subagent'）不折：宿主对它们有自己的一套展示，别抢。
 * @param sessions - 会话列表，每条至少有 `id`，可有 `parentId` / `origin`
 * @param shape - `shape.json`：`{groupOf, detached, adopted}`，缺哪项都行
 * @returns id → 树头的会话 id
 */
export function foldHeads(sessions, shape) {
	const byId = indexOf(sessions)
	const groupOf = shape && shape.groupOf && typeof shape.groupOf === 'object' ? shape.groupOf : {}
	const adopted = shape && shape.adopted && typeof shape.adopted === 'object' ? shape.adopted : {}
	const cut = new Set()
	for (const key of (shape && Array.isArray(shape.detached) ? shape.detached : [])) {
		const owner = sessionOfKey(key)
		if (owner !== undefined) cut.add(owner)
	}
	const memo = new Map()
	const headOf = (id, seen) => {
		const hit = memo.get(id)
		if (hit !== undefined) return hit
		const item = byId.get(id)
		if (item === undefined) return id
		// 手改坏的 shape.json / 环状血缘不许把这里挂死：转回来就地停
		const guard = seen || new Set()
		if (guard.has(id)) return id
		guard.add(id)
		let out
		const claimed = sessionOfKey(adopted[id])
		const group = groupOf[id]
		if (cut.has(id)) out = id
		else if (claimed !== undefined && claimed !== id && byId.has(claimed)) out = headOf(claimed, guard)
		else if (typeof item.parentId === 'string' && item.parentId !== id && byId.has(item.parentId)) out = headOf(item.parentId, guard)
		else if (typeof group === 'string' && group !== id && byId.has(group)) out = headOf(group, guard)
		else out = id
		memo.set(id, out)
		return out
	}
	const heads = new Map()
	for (const item of sessions || []) {
		if (!item || typeof item.id !== 'string') continue
		heads.set(item.id, item.origin === 'subagent' ? item.id : headOf(item.id))
	}
	return heads
}

/**
 * 给侧栏里画出来的那几行排座位。
 *
 * 输入是一个容器里**按 DOM 顺序**的全部孩子：会话行给 id，别的（工作区标题行、
 * "还有 n 条"按钮）给 undefined —— 它们也要占座，否则一挪座位它们就跑到别处去了。
 *
 * 规矩：
 *   · 一棵树在这个容器里只有一行 → 什么都不折（`plain`），没有箭头没有缩进；
 *   · 有两行以上 → 树头那行留在**这棵树最靠前那行**的位置上（列表按最近更新排，
 *     刚发过消息的分支在哪，整棵树就在哪，不会被沉底的老树根拖下去），
 *     其余各行紧跟其后、保持原有先后；
 *   · 树头优先用 foldHeads 算出来的那条；它不在这个容器里（被宿主的"还有 n 条"
 *     藏掉了）就让最靠前那行代班 —— 摊开与否照样按树的编号（`tree`）记。
 *
 * 座位号 `order` 直接喂给 CSS 的 `order`：容器里的**每个**孩子都拿到一个，
 * 没被挪动的孩子拿 `index * stride`，挪动的挤在树头后面。
 *
 * 小例子：ids = [标题(undefined), b, a, x, c]，a 是 b、c 的树头：
 *   标题 → 0；b（树最靠前，位置 1）；树头 a 坐 1×6，b 坐 1×6+1，c 坐 1×6+2；x 坐 3×6。
 *   视觉顺序：标题, a, b, c, x。
 * @param ids - 容器孩子按 DOM 顺序的会话 id（非会话行是 undefined）
 * @param heads - `foldHeads` 的结果；缺就当每行各成一树
 * @returns 和 ids 一一对应：`{id, index, order, role: 'other'|'plain'|'head'|'branch', tree, count}`
 */
export function foldRows(ids, heads) {
	const list = Array.isArray(ids) ? ids : []
	const stride = list.length + 1
	const trees = new Map()
	list.forEach((id, index) => {
		if (typeof id !== 'string') return
		const tree = (heads && heads.get(id)) || id
		const seat = trees.get(tree)
		if (seat === undefined) trees.set(tree, { anchor: index, members: [index] })
		else seat.members.push(index)
	})
	const out = list.map((id, index) => ({
		id: typeof id === 'string' ? id : undefined,
		index,
		order: index * stride,
		role: typeof id === 'string' ? 'plain' : 'other',
		tree: undefined,
		count: 0,
	}))
	for (const [tree, seat] of trees) {
		if (seat.members.length < 2) continue
		const own = seat.members.find((index) => list[index] === tree)
		const headIndex = own === undefined ? seat.anchor : own
		Object.assign(out[headIndex], { role: 'head', tree, order: seat.anchor * stride, count: seat.members.length - 1 })
		let slot = 1
		for (const index of seat.members) {
			if (index === headIndex) continue
			Object.assign(out[index], { role: 'branch', tree, order: seat.anchor * stride + slot })
			slot += 1
		}
	}
	return out
}

/**
 * 摊开 / 收起一棵树之后的清单。**纯函数**，不碰 localStorage。
 * @param list - 现在摊开着的树
 * @param tree - 树的编号
 * @param open - 要摊开还是收起
 * @returns 新清单（顺序保持，不重复）
 */
export function nextOpen(list, tree, open) {
	const now = (Array.isArray(list) ? list : []).filter((one) => typeof one === 'string' && one !== tree)
	return open ? now.concat([tree]) : now
}

/**
 * 读摊开清单。存坏了就当空的。
 * @returns 树编号数组
 */
export function readOpenTrees() {
	try {
		const raw = JSON.parse(localStorage.getItem(OPEN_KEY) || '[]')
		return Array.isArray(raw) ? raw.filter((one) => typeof one === 'string') : []
	} catch {
		return []
	}
}

/**
 * 存摊开清单。存不下就算了 —— 只是下次打开页面全部收起而已。
 * @param list - 树编号数组
 */
export function writeOpenTrees(list) {
	try {
		localStorage.setItem(OPEN_KEY, JSON.stringify(list))
	} catch {
		/* 存不下就算了 */
	}
}
