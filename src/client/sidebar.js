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
import { currentOf } from './tree.js'
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
	'data-dsht-dot', // 树头：状态槽里有没有东西（有的话整行右移，箭头和槽里的点并排都露着）
	'data-dsht-holds', // 树头：收起着、而当前会话就在里面
	'data-dsht-busy', // 树头：收起着、而里面有分支在跑（running）或刚跑完（completed）
	'data-dsht-hidden', // 分支：收起时藏掉（贴在座位上，见 unitOf；行上也顺手清）
	'data-dsht-last', // 分支：最后一条（连线画成 └ 而不是 ├）
]

/** 只有树头才有的那几项，分支行上要清掉。 */
const HEAD_ATTRS = ROW_ATTRS.filter((name) => !['data-dsht-role', 'data-dsht-hidden', 'data-dsht-last'].includes(name))

/**
 * 一行在容器里占的那个"座位"元素。
 *
 * ⚠️ 宿主的会话行**不是**容器的直接孩子：每一行都被 HoverCard 包在一个
 *    `<span style="display:block">` 里（悬停预览卡的锚点），工作区标题行也一样。
 *    座位号（CSS `order`）和"藏起来"必须落在这个包装上 —— 落在行上的话，行藏了
 *    包装还在，留一条 2px 的空缝；`order` 落在行上更是没用，它根本不是 flex 的孩子。
 *    第一版就是这么栽的：每行的 parentElement 各不相同，于是"同一个容器里的两行"永远找不到。
 *
 * 判法不认 HoverCard 的类名：从行往上爬，爬到父元素是 `[role="tree"]`、或者父元素底下
 * 有两个以上带 treeitem 的孩子为止 —— 那个父元素就是容器，爬到的就是座位。
 * 宿主哪天不套那层 span 了，座位就是行本身，照样对。
 * @param row - `[role="treeitem"]` 那个元素
 * @returns 座位元素（可能就是行本身）
 */
export function unitOf(row) {
	let unit = row
	for (let hop = 0; hop < 6; hop += 1) {
		const parent = unit.parentElement
		if (parent === null || parent === undefined) return unit
		if (parent.getAttribute('role') === 'tree') return unit
		let seats = 0
		for (const child of parent.children) {
			if (child.getAttribute('role') === 'treeitem' || child.querySelector('[role="treeitem"]') !== null) seats += 1
			if (seats >= 2) return unit
		}
		unit = parent
	}
	return unit
}

/**
 * 座位里的那一行。
 * @param unit - 座位元素
 * @returns 行；这个座位不是会话行（工作区标题、"还有 n 条"按钮）就 null
 */
function rowIn(unit) {
	return unit.getAttribute('role') === 'treeitem' ? unit : unit.querySelector('[role="treeitem"]')
}

/** 分叉图标（三个点、一条弯线），当 CSS mask 用 —— 颜色由 background 给，跟主题走。 */
const FORK_ICON = `url("data:image/svg+xml,${encodeURIComponent(
	"<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'><circle cx='4' cy='3' r='2'/><circle cx='4' cy='13' r='2'/><circle cx='12' cy='5' r='2'/><path d='M4 5v6M12 7c0 3-8 2-8 4' fill='none' stroke='#000' stroke-width='1.6'/></svg>",
)}")`

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
 *   · 树头没有状态槽（"一个列表"视图里没在跑的行）就补 padding 给箭头腾地方；
 *     槽里有东西（在跑的点、桌面版的 leading 插槽）也补，箭头和它并排，**不藏箭头**。
 *     以前是箭头平时藏着、悬停才盖到点上，桌面版每行槽里都有东西，箭头就永远看不见（John 提的）。
 */
const STYLE =
	`[${FOLD_ATTR}]{display:flex;flex-direction:column}` +
	`[${FOLD_ATTR}="group"]{gap:2px}` +
	`[${FOLD_ATTR}]>*{flex:none;margin-top:0!important}` +
	'[data-dsht-role]{position:relative}' +
	'[data-dsht-role="head"]:not([data-dsht-slot="1"]),[data-dsht-role="head"][data-dsht-dot="1"]{padding-left:26px}' +
	'[data-dsht-role="branch"]{padding-left:26px}' +
	'[data-dsht-role="branch"]::before{content:"";position:absolute;left:15px;top:-2px;bottom:0;width:1px;background:var(--dsw-alias-border-l4);pointer-events:none}' +
	'[data-dsht-role="branch"][data-dsht-last="1"]::before{bottom:50%}' +
	'[data-dsht-role="branch"]::after{content:"";position:absolute;left:15px;top:50%;width:7px;height:1px;background:var(--dsw-alias-border-l4);pointer-events:none}' +
	'[data-dsht-hidden="1"]{display:none!important}' +
	// 树头右边写"这棵树几条对话"：分叉图标 + 数字，灰的、没底色。带底色的数字角标看着像
	// "几条新消息"（John 提的）；分叉图标说的是"几条分支"，误会不了。
	// 宿主那几个 span 先全推到 -1，再把最后两个（时间、"…"菜单）推到 1，
	// 图标（::before）和数字（::after）就落在标题和时间之间。
	'[data-dsht-role="head"]>span{order:-1}' +
	'[data-dsht-role="head"]>span:nth-last-of-type(-n+2){order:1}' +
	`[data-dsht-role="head"][data-dsht-open="0"]::before{content:"";order:0;flex:none;width:12px;height:12px;margin-left:6px;background:var(--dsw-alias-label-tertiary);-webkit-mask:${FORK_ICON} center/contain no-repeat;mask:${FORK_ICON} center/contain no-repeat}` +
	'[data-dsht-role="head"][data-dsht-open="0"]::after{content:attr(data-dsht-count);order:0;flex:none;margin:0 6px 0 3px;font-size:11px;line-height:18px;font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-tertiary)}' +
	// 折着的树里有分支在跑（蓝）/ 跑完了你还没看（绿）：箭头右上角一个小点。
	// 点在箭头上，说的就是"里面"—— 和树头自己的状态（宿主画在状态槽里）分得开。
	`.${FOLD_BUTTON}::after{content:"";position:absolute;right:0;top:0;width:6px;height:6px;border-radius:50%;background:transparent}` +
	`[data-dsht-busy="running"]>.${FOLD_BUTTON}::after{background:var(--dsw-alias-state-business-primary)}` +
	`[data-dsht-busy="completed"]>.${FOLD_BUTTON}::after{background:var(--dsw-alias-state-success-primary,#3fb950)}` +
	'[data-dsht-role="head"][data-dsht-holds="1"]:not(:hover){background:color-mix(in srgb,var(--dsw-alias-interactive-bg-hover) 55%,transparent)}' +
	`.${FOLD_BUTTON}{position:absolute;left:6px;top:50%;width:20px;height:20px;margin-top:-10px;padding:0;border:0;border-radius:6px;background:none;color:var(--dsw-alias-label-tertiary);display:inline-flex;align-items:center;justify-content:center;cursor:pointer;z-index:1}` +
	`.${FOLD_BUTTON}:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}` +
	`.${FOLD_BUTTON} svg{display:block;transition:transform .15s ease}` +
	`[data-dsht-open="1"]>.${FOLD_BUTTON} svg{transform:rotate(90deg)}`

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

/** 摘掉一行上的全部记号（不含座位号，那个在座位上）。 */
function unmarkRow(el) {
	for (const name of ROW_ATTRS) put(el, name, null)
	const button = el.querySelector(`:scope > .${FOLD_BUTTON}`)
	if (button !== null) button.remove()
}

/** 摘掉一个座位（座位号、藏起来）和它里面那一行的记号。 */
function unmarkUnit(unit) {
	put(unit, 'data-dsht-hidden', null)
	if (unit.style && unit.style.order !== '') unit.style.order = ''
	const row = rowIn(unit)
	if (row !== null) unmarkRow(row)
}

/** 摘掉一个容器和它所有座位上的记号。 */
function unmarkContainer(el) {
	put(el, FOLD_ATTR, null)
	for (const child of el.children) unmarkUnit(child)
}

/** 把页面上所有记号全摘掉。停用 / 关掉设置时用。 */
export function clearFold() {
	if (typeof document === 'undefined') return
	for (const el of document.querySelectorAll(`[${FOLD_ATTR}]`)) unmarkContainer(el)
	for (const el of document.querySelectorAll('[data-dsht-hidden]')) unmarkUnit(el)
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
	const label = `${open ? '收起' : '展开'}这棵树（${count} 条对话）`
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

/** 最近一次贴完的账：几个容器、几行、认出几行、折了几棵。`__dshTree()` 里看。 */
let lastFold = { containers: 0, rows: 0, known: 0, folded: 0 }

/**
 * 最近一次贴完的账，一句人话。自诊断用："一棵都没折"时先看认没认出会话 id。
 * @returns 描述
 */
export function foldReport() {
	const { containers, rows, known, folded } = lastFold
	return `容器 ${containers} 个，会话行 ${rows} 行，认出 ${known} 行，折了 ${folded} 棵`
}

/**
 * 贴一遍。幂等：同样的输入贴两次，DOM 不再变。
 * @param heads - `foldHeads` 的结果
 * @param open - 摊开着的树（Set）
 * @param byId - 会话列表快照的 byId
 * @param current - 当前会话 id
 * @param onToggle - 箭头点了叫谁
 * @param trees - 树编号 → 全部成员的会话 id（按会话列表算，含被宿主收起的）；缺就按画出来的行算
 * @param wantMore - 刚被用户摊开的树（Set）；成员被宿主收着的话替他按一下「还有 n 条」，按完划掉
 * @returns 折了几棵树（自诊断 / 测试用）
 */
export function applyFold(heads, open, byId, current, onToggle, trees, wantMore) {
	if (typeof document === 'undefined') return 0
	const parents = []
	for (const row of document.querySelectorAll('[role="treeitem"]')) {
		const parent = unitOf(row).parentElement
		if (parent !== null && parent !== undefined && !parents.includes(parent)) parents.push(parent)
	}
	const kept = new Set()
	let folded = 0
	const tally = { containers: parents.length, rows: 0, known: 0, folded: 0 }
	for (const parent of parents) {
		const children = Array.from(parent.children)
		const rows = children.map(rowIn)
		const ids = rows.map((el) => (el === null ? undefined : sessionIdOf(el)))
		tally.rows += rows.filter((el) => el !== null).length
		tally.known += ids.filter((id) => id !== undefined).length
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
			const unit = children[row.index]
			const order = String(row.order)
			if (unit.style && unit.style.order !== order) unit.style.order = order
			const el = rows[row.index]
			if (el === null) {
				put(unit, 'data-dsht-hidden', null)
				continue
			}
			if (row.role === 'head') {
				const isOpen = open.has(row.tree)
				// 这棵树的全部成员按**会话列表**算，不按侧栏画出来的行算：宿主每个工作区只画
				// 最近 5 条、其余收进「还有 n 条」，被收进去的分支也要算进"几条"、也要算进"里面有没有在跑"
				const members = trees !== undefined && trees.get(row.tree) !== undefined ? trees.get(row.tree) : (branchesOf.get(row.tree) || []).concat([row.id])
				const others = members.filter((id) => id !== row.id)
				const slot = el.querySelector(':scope > span[class*="_slot"]')
				put(el, 'data-dsht-role', 'head')
				put(el, 'data-dsht-open', isOpen ? '1' : '0')
				put(el, 'data-dsht-count', String(members.length))
				put(el, 'data-dsht-slot', slot === null ? null : '1')
				put(el, 'data-dsht-dot', slot !== null && slot.childElementCount > 0 ? '1' : null)
				put(el, 'data-dsht-holds', !isOpen && others.includes(current) ? '1' : null)
				put(el, 'data-dsht-busy', isOpen ? null : busyOf(others, byId))
				put(el, 'data-dsht-last', null)
				put(unit, 'data-dsht-hidden', null)
				ensureButton(el, row.tree, members.length, isOpen, onToggle)
				// 刚摊开、而有成员被宿主收在「还有 n 条」里：替用户把宿主那个按钮按一下，
				// 否则摊开了也只露出画出来的那几条。只按一次（wantMore 里划掉），之后收不收随宿主。
				if (isOpen && wantMore !== undefined && wantMore.has(row.tree)) {
					wantMore.delete(row.tree)
					if (members.length > row.count + 1) {
						const more = parent.querySelector('button[class*="_sessionOverflowButton"][aria-expanded="false"]')
						if (more !== null && typeof more.click === 'function') more.click()
					}
				}
				folded += 1
			} else if (row.role === 'branch') {
				const isOpen = open.has(row.tree)
				const branches = branchesOf.get(row.tree) || []
				put(el, 'data-dsht-role', 'branch')
				put(el, 'data-dsht-last', branches[branches.length - 1] === row.id ? '1' : null)
				for (const name of HEAD_ATTRS) put(el, name, null)
				// 藏在座位上而不是行上：行藏了包装还在，会留一条 2px 的空缝
				put(unit, 'data-dsht-hidden', isOpen ? null : '1')
				const button = el.querySelector(`:scope > .${FOLD_BUTTON}`)
				if (button !== null) button.remove()
			} else {
				// 没折的行也要占座（order 已经设了），别的记号全清
				put(unit, 'data-dsht-hidden', null)
				unmarkRow(el)
			}
		}
	}
	for (const el of document.querySelectorAll(`[${FOLD_ATTR}]`)) if (!kept.has(el)) unmarkContainer(el)
	tally.folded = folded
	lastFold = tally
	return folded
}

/**
 * 挂在 Rail 上的钩子：算好该折成什么样，盯着侧栏贴上去。
 *
 * Rail 是常驻组件（shell.overlay），所以侧栏折叠也跟着常驻 —— 不在会话界面时
 * 左边的列表照样在，照样要折。
 *
 * **切会话不自动摊开**（John 的原话：不然和直接全列着没什么区别）。当前会话折在
 * 某棵树里时，树头带一层底色（`data-dsht-holds`）提示"你在里面"，想看就点箭头。
 * @param listState - 会话列表快照（`ctx.sessions.list`）
 * @param shape - Rail 手里的 `shape.json`（改树形的回显也在里面）；没有就自己拉
 * @param enabled - 设置里开着吗
 * @param archived - 归档集（`ctx.workspaces` 快照的 archivedSessionIds）：归档的不算树的成员
 */
export function useSidebarFold(listState, shape, enabled, archived) {
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

	const archivedKey = (archived || []).join(',')
	const sessions = react.useMemo(() => {
		const gone = new Set(archived || [])
		return listState ? (listState.ids || []).map((id) => listState.byId[id]).filter((item) => item !== undefined && !gone.has(item.id)) : []
	}, [listState, archivedKey]) // archived 按内容比（archivedKey），不按引用 —— 宿主每帧给的是新数组
	const heads = react.useMemo(() => foldHeads(sessions, live || {}), [sessions, live])
	// 树编号 → 全部成员（按会话列表算，含被宿主收进「还有 n 条」的那些）
	const trees = react.useMemo(() => {
		const out = new Map()
		for (const item of sessions) {
			const tree = heads.get(item.id) || item.id
			const list = out.get(tree) || []
			list.push(item.id)
			out.set(tree, list)
		}
		return out
	}, [sessions, heads])
	const current = currentOf(listState) // 两代宿主的"当前会话"都认（tree.js）
	const byId = (listState && listState.byId) || {}

	// 用户刚摊开的树：成员被宿主收着的话，applyFold 替他按一下「还有 n 条」（按完划掉）
	const wantMore = react.useRef(new Set())
	const toggle = react.useCallback((tree) => {
		setOpen((now) => {
			const opening = !now.includes(tree)
			if (opening) wantMore.current.add(tree)
			const next = nextOpen(now, tree, opening)
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
				applyFold(heads, openSet, byId, current, toggle, trees, wantMore.current)
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
	}, [enabled, heads, trees, open, byId, current, toggle])
}
