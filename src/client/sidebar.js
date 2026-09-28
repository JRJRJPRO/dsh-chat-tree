/**
 * 把左侧会话列表按对话树折起来：一棵树一行，箭头一点摊开分支。
 *
 * 【为什么是往宿主 DOM 上贴记号】宿主的会话列表整块是 `sidebar.workspaces` 这一个
 * slot（kind: single，ui-workspace 已经占了），**单行没有 slot，行上也没有
 * `data-session-*`**。要么整块重画（搜索、拖拽排序、重命名、归档、工作区菜单……
 * 全得自己再写一遍），要么在宿主画好的行上动手脚。选后者，而且**只动三样**：
 *   · 容器改成 flex 列 + 每行一个 CSS `order` —— 分支行挪到树头后面，**DOM 一个字节不动**
 *     （挪 DOM 会让 React 下次 insertBefore 找不到参照物直接抛错）；
 *   · 行上贴 `data-dsht-*` 属性（React 只管它自己设过的属性，不会清掉）；
 *   · 树头行里塞一颗 `<button>` 当箭头（插在第一个位置，React 增删它自己的孩子
 *     用的是"插到某个已知兄弟前面"，多一个外人不碍事 —— dsh-claude 的撤回按钮同款路子）。
 *
 * 【行是哪条会话】从 React fiber 往上找到 SessionNodeItem 的 props（`node.id`）。
 * 这是唯一一处碰 React 内部结构的地方，宿主改了就**认不出来、整个不折**（fail open），
 * 不会画错。
 *
 * 【什么时候重贴】宿主每次重画侧栏（切会话、来消息、改名）都可能把行换掉，
 * 所以挂一个 MutationObserver，一帧最多贴一次；贴完 `takeRecords()` 把自己造成的
 * 变动吞掉，免得自己触发自己。
 *
 * 算座位的纯函数在 fold.js，这里只管贴。
 */
import { react } from './runtime.js'
import { getJson, warn } from './net.js'
import { foldHeads, foldRows, nextOpen, readOpenTrees, writeOpenTrees } from './fold.js'

/** 容器上的记号：`group`（工作区分组视图，行间距 2px）/ `flat`（"放在一个列表里"视图）。 */
export const FOLD_ATTR = 'data-dsht-fold'

/** 箭头按钮的类名。 */
export const FOLD_BUTTON = 'dsht-fold'

/** 行上会贴的全部属性。清记号时按这张表扫，别漏。 */
const ROW_ATTRS = [
	'data-dsht-role', // head / branch
	'data-dsht-open', // 树头：1 摊开 / 0 收起
	'data-dsht-count', // 树头：底下几条分支（收起时画成数字角标）
	'data-dsht-slot', // 树头：这一行有没有宿主那个 16px 的状态槽（没有的话箭头要自己腾地方）
	'data-dsht-dot', // 树头：状态槽里有没有东西（有的话箭头平时藏着，悬停才盖上去）
	'data-dsht-holds', // 树头：收起着、而当前会话就在里面
	'data-dsht-busy', // 树头：收起着、而里面有分支在跑（running）或刚跑完（completed）
	'data-dsht-hidden', // 分支：收起时藏掉
	'data-dsht-last', // 分支：最后一条（连线画成 └ 而不是 ├）
]

/** 只有树头才有的那几项，分支行上要清掉。 */
const HEAD_ATTRS = ROW_ATTRS.filter((name) => !['data-dsht-role', 'data-dsht-hidden', 'data-dsht-last'].includes(name))

/** 折角箭头。收起时朝右，摊开转 90°。 */
const CHEVRON = '<svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true"><path d="M4.5 2.5 8 6 4.5 9.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>'

/**
 * 样式表。颜色全是宿主的 `--dsw-alias-*` 变量，换主题跟着变。
 *
 * 几处要解释的：
 *   · 容器 `>*{flex:none;margin-top:0}`：宿主分组视图靠 `>*+*{margin-top:2px}` 隔行，
 *     换成 `order` 之后"前一个兄弟"是 DOM 顺序而不是视觉顺序，改用 `gap` 才对得齐；
 *   · 树头的数字角标是 `::after`，靠 `order` 挤到时间之前：宿主那几个 span 都是 order 0，
 *     把最后两个（时间、"…"菜单）推到 1，角标（0，源码顺序在最后）就落在标题之后；
 *   · 分支行的 ├ / └ 用 `::before` / `::after` 画。宿主拖拽时的落点线也用这两个伪元素，
 *     但它的选择器更具体（`.sessionRow.dropBefore:before`），拖的时候它赢，不冲突；
 *   · 树头没有状态槽（"一个列表"视图里没在跑的行）就补 padding 给箭头腾地方。
 */
const STYLE =
	`[${FOLD_ATTR}]{display:flex;flex-direction:column}` +
	`[${FOLD_ATTR}="group"]{gap:2px}` +
	`[${FOLD_ATTR}]>*{flex:none;margin-top:0!important}` +
	'[data-dsht-role]{position:relative}' +
	'[data-dsht-role="head"]:not([data-dsht-slot="1"]){padding-left:26px}' +
	'[data-dsht-role="branch"]{padding-left:26px}' +
	'[data-dsht-role="branch"]::before{content:"";position:absolute;left:15px;top:-2px;bottom:0;width:1px;background:var(--dsw-alias-border-l4);pointer-events:none}' +
	'[data-dsht-role="branch"][data-dsht-last="1"]::before{bottom:50%}' +
	'[data-dsht-role="branch"]::after{content:"";position:absolute;left:15px;top:50%;width:7px;height:1px;background:var(--dsw-alias-border-l4);pointer-events:none}' +
	'[data-dsht-hidden="1"]{display:none!important}' +
	'[data-dsht-role="head"]>span:nth-last-of-type(-n+2){order:1}' +
	'[data-dsht-role="head"][data-dsht-open="0"]::after{content:attr(data-dsht-count);order:0;flex:none;margin:0 6px 0 4px;min-width:18px;height:18px;padding:0 5px;box-sizing:border-box;border-radius:9px;font-size:11px;line-height:18px;text-align:center;font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-tertiary);background:var(--dsw-alias-interactive-bg-hover)}' +
	'[data-dsht-role="head"][data-dsht-open="0"][data-dsht-busy="running"]::after{color:#fff;background:var(--dsw-alias-state-business-primary)}' +
	'[data-dsht-role="head"][data-dsht-open="0"][data-dsht-busy="completed"]::after{color:#fff;background:var(--dsw-alias-state-success-primary,#3fb950)}' +
	'[data-dsht-role="head"][data-dsht-holds="1"]:not(:hover){background:color-mix(in srgb,var(--dsw-alias-interactive-bg-hover) 55%,transparent)}' +
	`.${FOLD_BUTTON}{position:absolute;left:6px;top:50%;width:20px;height:20px;margin-top:-10px;padding:0;border:0;border-radius:6px;background:none;color:var(--dsw-alias-label-tertiary);display:inline-flex;align-items:center;justify-content:center;cursor:pointer;z-index:1}` +
	`.${FOLD_BUTTON}:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}` +
	`.${FOLD_BUTTON} svg{display:block;transition:transform .15s ease}` +
	`[data-dsht-open="1"]>.${FOLD_BUTTON} svg{transform:rotate(90deg)}` +
	`[data-dsht-dot="1"]>.${FOLD_BUTTON}{opacity:0}` +
	`[data-dsht-dot="1"]:hover>.${FOLD_BUTTON}{opacity:1}` +
	'[data-dsht-dot="1"]:hover>span[class*="_slot"]>*{visibility:hidden}'

/**
 * 把样式表塞进页面。整页只要一份。
 * @returns 卸载函数
 */
export function installSidebarStyle() {
	try {
		if (document.querySelector('style[data-dsh-tree="sidebar-fold"]') !== null) return () => {}
		const tag = document.createElement('style')
		tag.dataset.dshTree = 'sidebar-fold'
		tag.textContent = STYLE
		document.head.appendChild(tag)
		return () => tag.remove()
	} catch {
		return () => {}
	}
}

/** 行 → 会话 id 的缓存。同一个 DOM 元素一辈子对应同一条会话（宿主按 id 当 key）。 */
const idCache = new WeakMap()

/**
 * 这一行是哪条会话。
 *
 * 从元素上的 `__reactFiber$…` 往上爬，找到 props 里带 `node.id` 和 `currentId` 的那个
 * （SessionNodeItem）。搜索结果行的 props 是 `result`，工作区标题行是 `group`，都认不出来 ——
 * 正好，那两种行本来就不该折。
 * @param el - `[role="treeitem"]` 那个元素
 * @returns 会话 id；认不出来就 undefined
 */
export function sessionIdOf(el) {
	if (idCache.has(el)) return idCache.get(el)
	let found
	try {
		const key = Object.keys(el).find((name) => name.startsWith('__reactFiber$'))
		let fiber = key === undefined ? undefined : el[key]
		for (let hop = 0; fiber && hop < 16; hop += 1, fiber = fiber.return) {
			const props = fiber.memoizedProps
			if (props && props.node && typeof props.node.id === 'string' && 'currentId' in props) {
				found = props.node.id
				break
			}
		}
	} catch {
		found = undefined
	}
	idCache.set(el, found)
	return found
}

/**
 * 设 / 删一个属性，值没变就不碰（少制造无谓的 DOM 变动）。
 * @param el - 元素
 * @param name - 属性名
 * @param value - 新值；null / undefined = 删掉
 */
function put(el, name, value) {
	if (value === null || value === undefined) {
		if (el.hasAttribute(name)) el.removeAttribute(name)
	} else if (el.getAttribute(name) !== value) el.setAttribute(name, value)
}

/** 摘掉一行上的全部记号（座位号也清）。 */
function unmarkRow(el) {
	for (const name of ROW_ATTRS) put(el, name, null)
	if (el.style && el.style.order !== '') el.style.order = ''
	const button = el.querySelector(`:scope > .${FOLD_BUTTON}`)
	if (button !== null) button.remove()
}

/** 摘掉一个容器和它所有孩子上的记号。 */
function unmarkContainer(el) {
	put(el, FOLD_ATTR, null)
	for (const child of el.children) unmarkRow(child)
}

/** 把页面上所有记号全摘掉。停用 / 关掉设置时用。 */
export function clearFold() {
	if (typeof document === 'undefined') return
	for (const el of document.querySelectorAll(`[${FOLD_ATTR}]`)) unmarkContainer(el)
	for (const el of document.querySelectorAll('[data-dsht-role]')) unmarkRow(el)
	for (const el of document.querySelectorAll(`.${FOLD_BUTTON}`)) el.remove()
}

/**
 * 给树头行装上箭头（已经有就只更新状态）。
 *
 * 点击要 `stopPropagation`：行本身的 onClick 是打开会话，React 17+ 把监听挂在根上，
 * 原生事件在这儿拦住它就收不到。
 * @param row - 树头那一行
 * @param tree - 树的编号
 * @param count - 底下几条分支
 * @param open - 现在是摊开的吗
 * @param onToggle - 点了之后叫谁
 */
function ensureButton(row, tree, count, open, onToggle) {
	let button = row.querySelector(`:scope > .${FOLD_BUTTON}`)
	if (button === null) {
		button = document.createElement('button')
		button.type = 'button'
		button.className = FOLD_BUTTON
		button.innerHTML = CHEVRON
		button.addEventListener('click', (event) => {
			event.preventDefault()
			event.stopPropagation()
			const fire = button.__dshtToggle
			if (typeof fire === 'function') fire(button.dataset.tree)
		})
		row.insertBefore(button, row.firstChild)
	}
	button.__dshtToggle = onToggle
	button.dataset.tree = tree
	const label = `${open ? '收起' : '展开'} ${count} 条分支`
	put(button, 'aria-label', label)
	put(button, 'title', label)
	put(button, 'aria-expanded', open ? 'true' : 'false')
}

/**
 * 收起的树里有没有在跑 / 刚跑完的分支。分支行藏着，这个状态得挪到树头上来。
 * @param branches - 分支的会话 id
 * @param byId - 会话列表快照的 byId
 * @returns 'running' / 'completed' / null
 */
function busyOf(branches, byId) {
	let done = false
	for (const id of branches) {
		const item = byId[id]
		if (item === undefined) continue
		if (item.running === true) return 'running'
		if (item.completed === true) done = true
	}
	return done ? 'completed' : null
}

/**
 * 贴一遍。幂等：同样的输入贴两次，DOM 不再变。
 * @param heads - `foldHeads` 的结果
 * @param open - 摊开着的树（Set）
 * @param byId - 会话列表快照的 byId
 * @param current - 当前会话 id
 * @param onToggle - 箭头点了叫谁
 * @returns 折了几棵树（自诊断 / 测试用）
 */
export function applyFold(heads, open, byId, current, onToggle) {
	if (typeof document === 'undefined') return 0
	const parents = []
	for (const row of document.querySelectorAll('[role="treeitem"]')) {
		const parent = row.parentElement
		if (parent !== null && !parents.includes(parent)) parents.push(parent)
	}
	const kept = new Set()
	let folded = 0
	for (const parent of parents) {
		const children = Array.from(parent.children)
		const ids = children.map((el) => (el.getAttribute('role') === 'treeitem' ? sessionIdOf(el) : undefined))
		const plan = foldRows(ids, heads)
		if (!plan.some((row) => row.role === 'head')) {
			unmarkContainer(parent)
			continue
		}
		kept.add(parent)
		put(parent, FOLD_ATTR, parent.getAttribute('role') === 'tree' ? 'flat' : 'group')
		const branchesOf = new Map()
		for (const row of plan) {
			if (row.role !== 'branch') continue
			const list = branchesOf.get(row.tree) || []
			list.push(row.id)
			branchesOf.set(row.tree, list)
		}
		for (const row of plan) {
			const el = children[row.index]
			const order = String(row.order)
			if (el.style && el.style.order !== order) el.style.order = order
			if (row.role === 'head') {
				const isOpen = open.has(row.tree)
				const branches = branchesOf.get(row.tree) || []
				const slot = el.querySelector(':scope > span[class*="_slot"]')
				put(el, 'data-dsht-role', 'head')
				put(el, 'data-dsht-open', isOpen ? '1' : '0')
				put(el, 'data-dsht-count', String(row.count))
				put(el, 'data-dsht-slot', slot === null ? null : '1')
				put(el, 'data-dsht-dot', slot !== null && slot.childElementCount > 0 ? '1' : null)
				put(el, 'data-dsht-holds', !isOpen && branches.includes(current) ? '1' : null)
				put(el, 'data-dsht-busy', isOpen ? null : busyOf(branches, byId))
				put(el, 'data-dsht-hidden', null)
				put(el, 'data-dsht-last', null)
				ensureButton(el, row.tree, row.count, isOpen, onToggle)
				folded += 1
			} else if (row.role === 'branch') {
				const isOpen = open.has(row.tree)
				const branches = branchesOf.get(row.tree) || []
				put(el, 'data-dsht-role', 'branch')
				put(el, 'data-dsht-hidden', isOpen ? null : '1')
				put(el, 'data-dsht-last', branches[branches.length - 1] === row.id ? '1' : null)
				for (const name of HEAD_ATTRS) put(el, name, null)
				const button = el.querySelector(`:scope > .${FOLD_BUTTON}`)
				if (button !== null) button.remove()
			} else {
				// 没折的行也要占座（order 已经设了），别的记号全清
				for (const name of ROW_ATTRS) put(el, name, null)
				const button = el.querySelector(`:scope > .${FOLD_BUTTON}`)
				if (button !== null) button.remove()
			}
		}
	}
	for (const el of document.querySelectorAll(`[${FOLD_ATTR}]`)) if (!kept.has(el)) unmarkContainer(el)
	return folded
}

/**
 * 挂在 Rail 上的钩子：算好该折成什么样，盯着侧栏贴上去。
 *
 * Rail 是常驻组件（shell.overlay），所以侧栏折叠也跟着常驻 —— 不在会话界面时
 * 左边的列表照样在，照样要折。
 * @param listState - 会话列表快照（`ctx.sessions.list`）
 * @param shape - Rail 手里的 `shape.json`（改树形的回显也在里面）；没有就自己拉
 * @param enabled - 设置里开着吗
 */
export function useSidebarFold(listState, shape, enabled) {
	const [own, setOwn] = react.useState(undefined)
	const [open, setOpen] = react.useState(readOpenTrees)
	const live = shape || own
	// 还没开任何会话时 Rail 手里没有 outlines，也就没有 shape —— 自己拉一次全局那份
	const missing = enabled && shape === undefined && own === undefined
	react.useEffect(() => {
		if (!missing) return undefined
		let alive = true
		getJson('/shape')
			.then((body) => {
				if (alive) setOwn(body && typeof body === 'object' ? body : {})
			})
			.catch((error) => {
				warn('拉树形失败，侧栏先只按血缘折', error)
				if (alive) setOwn({})
			})
		return () => {
			alive = false
		}
	}, [missing])

	const sessions = react.useMemo(
		() => (listState ? (listState.ids || []).map((id) => listState.byId[id]).filter((item) => item !== undefined) : []),
		[listState],
	)
	const heads = react.useMemo(() => foldHeads(sessions, live || {}), [sessions, live])
	const current = listState ? listState.current : undefined
	const byId = (listState && listState.byId) || {}

	// 切到一条折在树里的分支 → 把那棵树摊开，不然你正看着的会话在左边找不到。
	// 只在**切会话那一下**做一次，之后想收照样能收（收了树头会带一层底色提示"当前在里面"）。
	const seen = react.useRef(undefined)
	react.useEffect(() => {
		if (!enabled || typeof current !== 'string' || seen.current === current) return
		const tree = heads.get(current)
		if (tree === undefined) return // 列表 / 形状还没到，下一次再看
		seen.current = current
		if (tree === current || open.includes(tree)) return
		const next = nextOpen(open, tree, true)
		writeOpenTrees(next)
		setOpen(next)
	}, [enabled, current, heads, open])

	const toggle = react.useCallback((tree) => {
		setOpen((now) => {
			const next = nextOpen(now, tree, !now.includes(tree))
			writeOpenTrees(next)
			return next
		})
	}, [])

	react.useEffect(() => {
		if (!enabled) {
			clearFold()
			return undefined
		}
		const off = installSidebarStyle()
		return () => {
			off()
			clearFold()
		}
	}, [enabled])

	react.useEffect(() => {
		if (!enabled || typeof document === 'undefined' || typeof MutationObserver === 'undefined') return undefined
		const openSet = new Set(open)
		let frame = 0
		let observer
		const repaint = () => {
			frame = 0
			try {
				applyFold(heads, openSet, byId, current, toggle)
			} catch (error) {
				warn('侧栏折叠没贴上', error)
			}
			// 自己贴的那些变动别再触发自己
			if (observer !== undefined) observer.takeRecords()
		}
		observer = new MutationObserver(() => {
			if (frame === 0) frame = requestAnimationFrame(repaint)
		})
		observer.observe(document.body, { childList: true, subtree: true })
		repaint()
		return () => {
			if (frame !== 0) cancelAnimationFrame(frame)
			observer.disconnect()
		}
	}, [enabled, heads, open, byId, current, toggle])
}
