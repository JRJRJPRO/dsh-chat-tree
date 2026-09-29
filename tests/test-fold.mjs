/**
 * dsh-chat-tree —— 左侧会话列表折叠。
 *
 * 【导读】
 * 干嘛的：宿主的侧栏一条分支一行；我们把一棵树折成一行，箭头一点摊开。
 * 分两半测：
 *   · fold.js 的纯函数 —— 谁归哪棵树（foldHeads）、座位怎么排（foldRows）、摊开清单（nextOpen）
 *   · sidebar.js 往宿主行上贴记号那半 —— 喂一个手捏的假 DOM（带假 React fiber）进去，
 *     看它贴的属性、插的箭头、挪的座位对不对，以及**认不出来时一动不动**（fail open）
 *
 * 阅读顺序：
 *   第1步  取 client 的真函数
 *   第2步  foldHeads：血缘 / 拆 / 认领 / 合并 / 子代理 / 坏数据
 *   第3步  foldRows：座位号
 *   第4步  nextOpen + localStorage
 *   第5步  假 DOM
 *   第6步  applyFold / clearFold
 *
 * 跑法：node tests/test-fold.mjs
 *
 * @module test-fold
 */

import { check, loadClientPure, report } from './test-kit.mjs'

// ===== 第 1 步：取 client 的真函数 =====

const pure = await loadClientPure()
const { foldHeads, foldRows, nextOpen, readOpenTrees, writeOpenTrees, OPEN_KEY, applyFold, clearFold, sessionIdOf, unitOf, FOLD_ATTR, FOLD_BUTTON } = pure

/** 造一条会话。 */
const session = (id, parentId, extra) => Object.assign({ id, parentId, running: false, updatedAt: 0 }, extra || {})

// ===== 第 2 步：foldHeads =====

console.log('用例 1：血缘 —— fork 出来的都归树根')
{
	// A ← B ← C，D 独立
	const heads = foldHeads([session('A'), session('B', 'A'), session('C', 'B'), session('D')], {})
	check(heads.get('A') === 'A', 'A 是自己的树头')
	check(heads.get('B') === 'A', 'B 归 A')
	check(heads.get('C') === 'A', 'C 隔一代也归 A')
	check(heads.get('D') === 'D', 'D 自成一树')
	// 没传 shape / 传坏 shape 都不许炸
	check(foldHeads([session('A'), session('B', 'A')], undefined).get('B') === 'A', 'shape 缺席也按血缘算')
	check(foldHeads([session('A'), session('B', 'A')], { groupOf: 3, detached: 'x', adopted: null }).get('B') === 'A', 'shape 字段类型不对当没有')
	check(foldHeads(undefined, {}).size === 0, '会话列表缺席给空表')
}

console.log('用例 2：拆 —— 剪点所在的那条会话自己当树头，底下的跟着走')
{
	// A ← B ← C，剪在 B:3 上
	const heads = foldHeads([session('A'), session('B', 'A'), session('C', 'B')], { detached: ['B:3'] })
	check(heads.get('A') === 'A', 'A 还是 A')
	check(heads.get('B') === 'B', 'B 被剪出去，自己当树头')
	check(heads.get('C') === 'B', 'C 跟着 B 走')
	// 老格式（纯会话 id）也认
	const legacy = foldHeads([session('A'), session('B', 'A')], { detached: ['B'] })
	check(legacy.get('B') === 'B', '老格式的 detached（纯会话 id）也认')
	// 剪的不是它们家的：不影响
	const other = foldHeads([session('A'), session('B', 'A')], { detached: ['Z:1', '', 42] })
	check(other.get('B') === 'A', '别家的剪点 / 垃圾项不影响')
}

console.log('用例 3：认领 —— 在拆出去那棵树的前缀上开的分支，归剪点那棵')
{
	// A ← B（剪点 B:2）；D 的父亲是 A，但登记了 adopted[D] = 'B:2'
	const heads = foldHeads([session('A'), session('B', 'A'), session('D', 'A')], { detached: ['B:2'], adopted: { D: 'B:2' } })
	check(heads.get('D') === 'B', '认领过的归剪点那条会话')
	// 剪缝愈合了、认领还在：跟着剪点那条会话按血缘算 —— 回到 A
	const healed = foldHeads([session('A'), session('B', 'A'), session('D', 'A')], { detached: [], adopted: { D: 'B:2' } })
	check(healed.get('D') === 'A', '愈合之后认领跟着 B 回到 A')
	// 认领指向不存在的会话：当没登记
	const junk = foldHeads([session('A'), session('D', 'A')], { adopted: { D: 'Q:1' } })
	check(junk.get('D') === 'A', '认领对象不存在就按血缘')
	// 自己认领自己：不许挂死
	const self = foldHeads([session('A'), session('D', 'A')], { adopted: { D: 'D:1' } })
	check(self.get('D') === 'A', '自己认领自己当没登记')
}

console.log('用例 4：合并 —— 根被登记进别人的组，整棵归过去')
{
	// A ← B；E 独立；groupOf[E] = A
	const heads = foldHeads([session('A'), session('B', 'A'), session('E'), session('F', 'E')], { groupOf: { E: 'A' } })
	check(heads.get('E') === 'A', 'E 合进 A')
	check(heads.get('F') === 'A', 'E 的孩子也跟着进 A')
	check(heads.get('B') === 'A', 'A 自家的不变')
	// 组号指向不存在的会话（被归档了）：不动
	const gone = foldHeads([session('E')], { groupOf: { E: 'A' } })
	check(gone.get('E') === 'E', '组号对应的会话不在列表里就留在原地')
	// 互相指：不许挂死
	const loop = foldHeads([session('A'), session('E')], { groupOf: { E: 'A', A: 'E' } })
	check(loop.get('A') === loop.get('E'), '环状登记就地停，不挂死，两边归到同一棵')
}

console.log('用例 5：子代理不折；环状血缘不挂死')
{
	const heads = foldHeads([session('A'), session('S', 'A', { origin: 'subagent' }), session('B', 'A')], {})
	check(heads.get('S') === 'S', '子代理自己一行，不折进父会话')
	check(heads.get('B') === 'A', '普通分支照折')
	const ring = foldHeads([session('A', 'B'), session('B', 'A')], {})
	check(ring.has('A') && ring.has('B'), '父子互指也能算完')
	const orphan = foldHeads([session('B', 'A')], {})
	check(orphan.get('B') === 'B', '父亲不在列表里（被归档）就自己当树头')
}

// ===== 第 3 步：foldRows =====

console.log('用例 6：座位 —— 树头留在这棵树最靠前那行，分支紧跟其后，别人原地不动')
{
	const heads = new Map([['a', 'a'], ['b', 'a'], ['c', 'a'], ['x', 'x']])
	// 容器孩子：标题行(undefined), b, a, x, c
	const rows = foldRows([undefined, 'b', 'a', 'x', 'c'], heads)
	check(rows.length === 5, '和输入一一对应')
	const byId = new Map(rows.map((row) => [row.id === undefined ? 'other' : row.id, row]))
	check(byId.get('other').role === 'other' && byId.get('other').order === 0, '标题行占第 0 座')
	check(byId.get('a').role === 'head' && byId.get('a').count === 2 && byId.get('a').tree === 'a', 'a 是树头，底下两条')
	check(byId.get('b').role === 'branch' && byId.get('c').role === 'branch', 'b、c 是分支')
	check(byId.get('x').role === 'plain' && byId.get('x').tree === undefined, 'x 一棵树只有一行，不折')
	// 视觉顺序：按 order 排
	const visual = rows.slice().sort((left, right) => left.order - right.order).map((row) => (row.id === undefined ? '#' : row.id))
	check(visual.join(',') === '#,a,b,c,x', `视觉顺序该是 #,a,b,c,x，实际 ${visual.join(',')}`)
	// 树头坐在 b 原来的位置（这棵树最靠前那行），x 留在自己的位置
	check(byId.get('a').order < byId.get('x').order, '整棵树挪到最靠前那条分支的位置，不被沉底的树根拖下去')
}

console.log('用例 7：树头不在容器里（被宿主"还有 n 条"藏了）—— 最靠前那行代班，树号照旧')
{
	const heads = new Map([['a', 'a'], ['b', 'a'], ['c', 'a']])
	const rows = foldRows(['c', 'b'], heads)
	const head = rows.find((row) => row.role === 'head')
	check(head !== undefined && head.id === 'c' && head.tree === 'a' && head.count === 1, '最靠前的 c 代班树头，树号仍是 a')
	check(rows.find((row) => row.id === 'b').role === 'branch', 'b 是分支')
	// 只有一行：什么都不折
	check(foldRows(['c'], heads).every((row) => row.role === 'plain'), '一棵树只剩一行就不折')
	// 没有 heads：每行各成一树
	check(foldRows(['a', 'b'], undefined).every((row) => row.role === 'plain'), '没有 heads 时不折')
	check(foldRows(undefined, heads).length === 0, '输入缺席给空表')
}

console.log('用例 8：两棵树交错也各归各的')
{
	const heads = new Map([['a', 'a'], ['b', 'a'], ['p', 'p'], ['q', 'p']])
	const rows = foldRows(['q', 'b', 'a', 'p'], heads)
	const visual = rows.slice().sort((left, right) => left.order - right.order).map((row) => row.id)
	check(visual.join(',') === 'p,q,a,b', `p 树在前（q 最靠前）、a 树在后，实际 ${visual.join(',')}`)
	check(rows.filter((row) => row.role === 'head').length === 2, '两个树头')
}

// ===== 第 4 步：nextOpen + localStorage =====

console.log('用例 9：摊开清单')
{
	check(nextOpen([], 'a', true).join() === 'a', '摊开一棵')
	check(nextOpen(['a', 'b'], 'a', false).join() === 'b', '收起一棵')
	check(nextOpen(['a'], 'a', true).join() === 'a', '重复摊开不重复')
	check(nextOpen(undefined, 'a', true).join() === 'a', '清单缺席当空')
	check(nextOpen(['a', 3, null], 'b', true).join() === 'a,b', '垃圾项被清掉')
	localStorage.setItem(OPEN_KEY, '{bad json')
	check(readOpenTrees().length === 0, '存坏了当空')
	writeOpenTrees(['a', 'b'])
	check(readOpenTrees().join() === 'a,b', '写了读得回来')
	localStorage.removeItem(OPEN_KEY)
}

// ===== 第 5 步：假 DOM =====
//
// 只造 sidebar.js 用得到的那几样：属性、style、children、几种选择器、insertBefore、
// 以及元素上挂的假 React fiber。

/** 极简选择器：`.cls` / `[attr]` / `[attr="v"]` / `tag[attr*="v"]` / `tag`。 */
function matches(el, simple) {
	let rest = simple
	let tag
	const tagMatch = /^[a-z]+/.exec(rest)
	if (tagMatch) {
		tag = tagMatch[0]
		rest = rest.slice(tag.length)
	}
	if (tag !== undefined && el.tagName !== tag) return false
	while (rest.length > 0) {
		if (rest.startsWith('.')) {
			const end = rest.search(/[.[]|$/g) === 0 ? rest.slice(1).search(/[.[]|$/) + 1 : rest.slice(1).search(/[.[]|$/) + 1
			const cls = rest.slice(1, end)
			if (!el.className.split(' ').includes(cls)) return false
			rest = rest.slice(end)
		} else if (rest.startsWith('[')) {
			const end = rest.indexOf(']')
			const body = rest.slice(1, end)
			const eq = /^([a-z-]+)(\*?=)"(.*)"$/.exec(body)
			if (eq) {
				const value = el.getAttribute(eq[1])
				if (value === null) return false
				if (eq[2] === '=' && value !== eq[3]) return false
				if (eq[2] === '*=' && !value.includes(eq[3])) return false
			} else if (!el.hasAttribute(body)) return false
			rest = rest.slice(end + 1)
		} else throw new Error(`假 DOM 不认这个选择器：${simple}`)
	}
	return true
}

class FakeElement {
	constructor(tagName) {
		this.tagName = tagName
		this.attrs = new Map()
		this.style = { order: '' }
		this.children = []
		this.parentElement = null
		this.className = ''
		this.innerHTML = ''
		this.dataset = {}
		this.listeners = {}
	}
	get firstChild() {
		return this.children[0] || null
	}
	get childElementCount() {
		return this.children.length
	}
	getAttribute(name) {
		if (name === 'class') return this.className
		return this.attrs.has(name) ? this.attrs.get(name) : null
	}
	setAttribute(name, value) {
		if (name === 'class') this.className = String(value)
		else this.attrs.set(name, String(value))
	}
	hasAttribute(name) {
		return name === 'class' ? this.className !== '' : this.attrs.has(name)
	}
	removeAttribute(name) {
		this.attrs.delete(name)
	}
	appendChild(child) {
		this.insertBefore(child, null)
	}
	insertBefore(child, before) {
		if (child.parentElement) child.remove()
		child.parentElement = this
		const at = before === null ? this.children.length : this.children.indexOf(before)
		this.children.splice(at === -1 ? this.children.length : at, 0, child)
		return child
	}
	remove() {
		if (this.parentElement === null) return
		const list = this.parentElement.children
		list.splice(list.indexOf(this), 1)
		this.parentElement = null
	}
	addEventListener(name, fn) {
		this.listeners[name] = fn
	}
	/** 模拟点一下（只跑自己的监听，顺便记一下有没有 stopPropagation）。 */
	click() {
		this.clicks = (this.clicks || 0) + 1
		const event = { stopped: false, prevented: false, preventDefault() { this.prevented = true }, stopPropagation() { this.stopped = true } }
		if (this.listeners.click) this.listeners.click(event)
		return event
	}
	querySelectorAll(selector) {
		const scoped = selector.startsWith(':scope > ')
		const simple = scoped ? selector.slice(':scope > '.length) : selector
		const out = []
		const walk = (el, deep) => {
			for (const child of el.children) {
				if (matches(child, simple)) out.push(child)
				if (deep) walk(child, true)
			}
		}
		walk(this, !scoped)
		return out
	}
	querySelector(selector) {
		return this.querySelectorAll(selector)[0] || null
	}
}

/** 造一个假的 document，根节点就是它自己。 */
function fakeDocument() {
	const root = new FakeElement('body')
	root.createElement = (tag) => new FakeElement(tag)
	return root
}

/**
 * 造一条宿主那样的会话行：`div[role=treeitem]`，里面 span.slot（可选）、span.title、span.time、span.actions，
 * 元素上挂一个假 fiber：div → HoverCard 内层 → SessionNodeItem（props.node.id）。
 * @param id - 会话 id；undefined = 造一条没 fiber 的行（认不出来）
 * @param opts - `{slot: 有没有状态槽, dot: 槽里有没有点, flat}`
 */
function fakeRow(id, opts) {
	const o = opts || {}
	const row = new FakeElement('div')
	row.setAttribute('role', 'treeitem')
	row.className = 'X_sessionRow'
	if (o.slot !== false) {
		const slot = new FakeElement('span')
		slot.className = 'X_slot'
		if (o.dot) slot.appendChild(new FakeElement('span'))
		row.appendChild(slot)
	}
	for (const cls of ['X_title', 'X_time', 'X_rowActions']) {
		const span = new FakeElement('span')
		span.className = cls
		row.appendChild(span)
	}
	if (id !== undefined) {
		const item = { memoizedProps: { node: { id }, currentId: undefined }, return: null }
		const inner = { memoizedProps: { anchor: {} }, return: item }
		row['__reactFiber$abc'] = { memoizedProps: { role: 'treeitem' }, return: inner }
	}
	return row
}

/**
 * 宿主的 HoverCard：每一行（标题行也一样）外面套一层 `<span style="display:block">`。
 * 座位号和"藏起来"必须落在这层上 —— 第一版落在行上，真机上一棵都没折出来。
 */
function hoverWrap(row) {
	const seat = new FakeElement('span')
	seat.className = 'X_root'
	seat.appendChild(row)
	return seat
}

/** 造一个分组容器：标题行 + 若干会话行 + "还有 n 条"按钮，行都套着 HoverCard 的 span。 */
function fakeGroup(ids) {
	const group = new FakeElement('div')
	group.className = 'X_groupSection'
	const header = new FakeElement('div')
	header.setAttribute('role', 'treeitem')
	header.className = 'X_projectRow'
	group.appendChild(hoverWrap(header))
	const rows = new Map()
	for (const id of ids) {
		const row = fakeRow(id)
		rows.set(id, row)
		group.appendChild(hoverWrap(row))
	}
	const more = new FakeElement('button')
	more.className = 'X_sessionOverflowButton'
	group.appendChild(more)
	return { group, header, rows, more }
}

// ===== 第 6 步：applyFold / clearFold =====

/** 座位里的那一行（座位可能就是行本身）。 */
const rowOf = (seat) => (seat.getAttribute('role') === 'treeitem' ? seat : seat.querySelector('[role="treeitem"]'))

const visualOrder = (container) =>
	container.children
		.slice()
		.sort((left, right) => Number(left.style.order) - Number(right.style.order))
		.map((seat) => {
			const row = rowOf(seat)
			return row === null ? '+' : row.className.includes('projectRow') ? '#' : sessionIdOf(row)
		})
		.join(',')

console.log('用例 10：贴记号 —— 座位、箭头、角标、藏分支')
{
	const doc = fakeDocument()
	globalThis.document = doc
	const { group, header, rows, more } = fakeGroup(['b', 'a', 'x', 'c'])
	doc.appendChild(group)
	const heads = new Map([['a', 'a'], ['b', 'a'], ['c', 'a'], ['x', 'x']])
	const byId = { a: { running: false }, b: { running: true }, c: { running: false, completed: true }, x: { running: false } }
	const toggled = []
	const trees = new Map([['a', ['a', 'b', 'c']], ['x', ['x']]])
	const folded = applyFold(heads, new Set(), byId, 'c', (tree) => toggled.push(tree), trees)
	check(folded === 1, `折了一棵树，实际 ${folded}`)
	check(group.getAttribute(FOLD_ATTR) === 'group', '分组容器标成 group')
	check(visualOrder(group) === '#,a,b,c,x,+', `视觉顺序：标题, a, b, c, x, 按钮；实际 ${visualOrder(group)}`)
	check(unitOf(header).style.order === '0' && more.style.order !== '', '标题行和"还有 n 条"按钮也拿到座位号，不会跑到别处去')
	const a = rows.get('a')
	check(unitOf(a) !== a && unitOf(a).className === 'X_root' && unitOf(a).parentElement === group, '座位是 HoverCard 那层 span，容器是分组')
	check(unitOf(a).style.order !== '' && a.style.order === '', '座位号贴在 span 上，不在行上（行不是 flex 的孩子）')
	check(a.getAttribute('data-dsht-role') === 'head' && a.getAttribute('data-dsht-open') === '0' && a.getAttribute('data-dsht-count') === '3', '树头：收起，数字是这棵树一共几条对话（不是分支数，5 个叶子写 4 看着怪 —— John 提的）')
	check(a.getAttribute('data-dsht-slot') === '1' && a.getAttribute('data-dsht-dot') === null, '有状态槽、槽里没东西')
	check(a.getAttribute('data-dsht-holds') === '1', '当前会话 c 折在里面 → holds')
	check(a.getAttribute('data-dsht-busy') === 'running', 'b 在跑 → busy=running（跑的优先于跑完的）')
	const button = a.querySelector(`:scope > .${FOLD_BUTTON}`)
	check(button !== null && a.firstChild === button, '箭头插在第一个位置')
	check(button !== null && button.getAttribute('aria-expanded') === 'false' && button.getAttribute('aria-label') === '展开这棵树（3 条对话）', '箭头的无障碍标签')
	check(rows.get('b').getAttribute('data-dsht-role') === 'branch' && unitOf(rows.get('b')).getAttribute('data-dsht-hidden') === '1', 'b 是分支，收起时整个座位藏掉')
	check(rows.get('b').getAttribute('data-dsht-hidden') === null, '"藏起来"不贴在行上 —— 行藏了 span 还在，会留一条空缝')
	check(rows.get('c').getAttribute('data-dsht-last') === '1' && rows.get('b').getAttribute('data-dsht-last') === null, 'c 是最后一条分支（画 └）')
	check(rows.get('x').getAttribute('data-dsht-role') === null && rows.get('x').querySelector(`:scope > .${FOLD_BUTTON}`) === null, 'x 不折：没记号没箭头')
	// 点箭头：拦住冒泡（否则宿主会把它当成点了整行 → 打开会话），并把树号交出去
	const event = button.click()
	check(event.stopped && event.prevented, '点箭头拦住冒泡')
	check(toggled.join() === 'a', `箭头交出树号 a，实际 ${toggled.join()}`)

	// 摊开：分支露出来，角标状态清掉，箭头还是同一颗（不重建，悬停态不丢）
	applyFold(heads, new Set(['a']), byId, 'c', () => {})
	check(a.getAttribute('data-dsht-open') === '1' && a.getAttribute('data-dsht-holds') === null && a.getAttribute('data-dsht-busy') === null, '摊开后 holds / busy 清掉')
	check(unitOf(rows.get('b')).getAttribute('data-dsht-hidden') === null, '摊开后分支不再藏')
	check(a.querySelector(`:scope > .${FOLD_BUTTON}`) === button && button.getAttribute('aria-expanded') === 'true', '箭头复用同一颗，只改状态')
	check(a.children.length === 5, '树头行的孩子数：箭头 + 4 个 span，没多插')

	// 幂等：同样输入再贴一遍，DOM 不变
	const snapshot = () =>
		JSON.stringify(
			group.children.map((seat) => {
				const row = rowOf(seat)
				return [seat.style.order, [...seat.attrs.entries()], row === null ? null : [[...row.attrs.entries()], row.children.length]]
			}),
		)
	const before = snapshot()
	applyFold(heads, new Set(['a']), byId, 'c', () => {})
	check(before === snapshot(), '同样的输入贴两遍，DOM 一个字节不变')

	// 树散了（比如 b、c 被归档，列表里只剩 a、x）：记号全摘
	unitOf(rows.get('b')).remove()
	unitOf(rows.get('c')).remove()
	applyFold(heads, new Set(['a']), byId, 'a', () => {})
	check(group.getAttribute(FOLD_ATTR) === null, '没得折了，容器记号摘掉')
	check(a.getAttribute('data-dsht-role') === null && a.querySelector(`:scope > .${FOLD_BUTTON}`) === null && unitOf(a).style.order === '', '树头的记号、箭头、座位号全摘')
}

console.log('用例 11：树头被宿主藏掉时最靠前那行代班；"一个列表"视图标成 flat；没有状态槽要腾地方')
{
	const doc = fakeDocument()
	globalThis.document = doc
	const list = new FakeElement('div')
	list.setAttribute('role', 'tree')
	doc.appendChild(list)
	const c = fakeRow('c', { slot: false })
	const b = fakeRow('b', { slot: false, dot: false })
	list.appendChild(hoverWrap(c))
	list.appendChild(hoverWrap(b))
	const heads = new Map([['a', 'a'], ['b', 'a'], ['c', 'a']])
	applyFold(heads, new Set(), {}, undefined, () => {})
	check(list.getAttribute(FOLD_ATTR) === 'flat', 'role=tree 的容器标成 flat（不加行距）')
	check(unitOf(c).parentElement === list && unitOf(b).getAttribute('data-dsht-hidden') === '1', '座位是 span，容器是 role=tree 那层；b 的座位藏掉')
	check(c.getAttribute('data-dsht-role') === 'head' && c.getAttribute('data-dsht-slot') === null, 'c 代班树头，而且没有状态槽（CSS 据此补 padding）')
	const button = c.querySelector(`:scope > .${FOLD_BUTTON}`)
	check(button !== null && button.dataset.tree === 'a', '箭头记的是树号 a，不是代班的 c')
	check(b.getAttribute('data-dsht-role') === 'branch', 'b 是分支')
}

console.log('用例 12：认不出来就一动不动（fail open）')
{
	const doc = fakeDocument()
	globalThis.document = doc
	const { group, rows } = fakeGroup([undefined, undefined])
	doc.appendChild(group)
	check([...rows.values()].every((row) => sessionIdOf(row) === undefined), '没 fiber 的行认不出会话 id')
	const folded = applyFold(new Map([['a', 'a'], ['b', 'a']]), new Set(), {}, 'a', () => {})
	check(folded === 0 && group.getAttribute(FOLD_ATTR) === null, '一棵都不折，容器没记号')
	check([...rows.values()].every((row) => unitOf(row).style.order === '' && row.attrs.size === 1), '行上除了 role 什么都没贴，座位也没座位号')
	// 状态槽里有点：箭头平时藏着（data-dsht-dot），悬停才盖上去 —— 这里只验属性。
	// 顺便：这里的行**没套** HoverCard 的 span，座位就是行本身，照样要能折（宿主哪天不套了也不坏）
	const doc2 = fakeDocument()
	globalThis.document = doc2
	const holder = new FakeElement('div')
	doc2.appendChild(holder)
	const head = fakeRow('a', { dot: true })
	const tail = fakeRow('b')
	holder.appendChild(head)
	holder.appendChild(tail)
	applyFold(new Map([['a', 'a'], ['b', 'a']]), new Set(), {}, 'a', () => {})
	check(head.getAttribute('data-dsht-dot') === '1', '槽里有点 → data-dsht-dot=1')
	check(unitOf(head) === head && head.style.order !== '' && tail.getAttribute('data-dsht-hidden') === '1', '没套 span 时座位就是行本身：座位号和藏起来都落在行上')
}

console.log('用例 14：被宿主收进「还有 n 条」的成员也算数；刚摊开就替用户按那个按钮')
{
	const doc = fakeDocument()
	globalThis.document = doc
	// 容器里只画了 a、b；d、e 被宿主收着（不在 DOM 里），"还有 n 条"按钮 aria-expanded=false
	const { group, rows, more } = fakeGroup(['a', 'b'])
	more.setAttribute('aria-expanded', 'false')
	doc.appendChild(group)
	const heads = new Map([['a', 'a'], ['b', 'a'], ['d', 'a'], ['e', 'a']])
	const trees = new Map([['a', ['a', 'b', 'd', 'e']]])
	const byId = { a: {}, b: {}, d: { running: true }, e: { completed: true } }
	applyFold(heads, new Set(), byId, 'e', () => {}, trees, new Set())
	const a = rows.get('a')
	check(a.getAttribute('data-dsht-count') === '4', '数字按会话列表算：4 条（含被宿主收着的 d、e）')
	check(a.getAttribute('data-dsht-busy') === 'running', '被收着的 d 在跑 → 箭头上的点是蓝的')
	check(a.getAttribute('data-dsht-holds') === '1', '当前会话 e 被收着也算"在里面"')
	check((more.clicks || 0) === 0, '没摊开就不碰宿主的按钮')
	// 用户摊开：wantMore 里有 a → 按一下宿主的「还有 n 条」，按完划掉
	const wantMore = new Set(['a'])
	applyFold(heads, new Set(['a']), byId, 'e', () => {}, trees, wantMore)
	check(more.clicks === 1 && wantMore.size === 0, '摊开时替用户按了一下「还有 n 条」，并且只按这一次')
	applyFold(heads, new Set(['a']), byId, 'e', () => {}, trees, wantMore)
	check(more.clicks === 1, '再贴一遍不重复按')
	// 成员都画出来了就不按：宿主按钮上 aria-expanded=false 也不碰
	const doc2 = fakeDocument()
	globalThis.document = doc2
	const g2 = fakeGroup(['a', 'b'])
	g2.more.setAttribute('aria-expanded', 'false')
	doc2.appendChild(g2.group)
	applyFold(heads, new Set(['a']), byId, undefined, () => {}, new Map([['a', ['a', 'b']]]), new Set(['a']))
	check((g2.more.clicks || 0) === 0, '成员都在 DOM 里就不去按宿主的按钮')
	// 不传 trees：退回按画出来的行算（a + b = 2）
	applyFold(heads, new Set(), byId, undefined, () => {})
	check(g2.rows.get('a').getAttribute('data-dsht-count') === '2', '没有 trees 时按画出来的行算')
}

console.log('用例 13：clearFold 把页面上的记号全摘干净')
{
	const doc = fakeDocument()
	globalThis.document = doc
	const { group, rows } = fakeGroup(['a', 'b'])
	doc.appendChild(group)
	applyFold(new Map([['a', 'a'], ['b', 'a']]), new Set(['a']), {}, 'a', () => {})
	check(group.getAttribute(FOLD_ATTR) === 'group' && rows.get('a').querySelector(`:scope > .${FOLD_BUTTON}`) !== null, '先确认贴上了')
	clearFold()
	check(group.getAttribute(FOLD_ATTR) === null, '容器记号摘掉')
	check([...rows.values()].every((row) => row.attrs.size === 1 && unitOf(row).style.order === '' && unitOf(row).attrs.size === 0), '行上只剩 role，座位上什么都不剩')
	check(doc.querySelectorAll(`.${FOLD_BUTTON}`).length === 0, '箭头全拔掉')
	// 没有 document 也不许炸
	delete globalThis.document
	clearFold()
	check(applyFold(new Map(), new Set(), {}, undefined, () => {}) === 0, '没有 document 时 applyFold 安静返回 0')
}

report()
