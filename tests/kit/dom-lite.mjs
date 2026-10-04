/**
 * dom-lite：离线测试用的假 `document` / `window`，以及 react-lite 画出来的 `Element`。
 *
 * 【只实现组件真用到的那一点】`contains / closest / querySelector / getBoundingClientRect /
 * focus / blur / addEventListener / elementFromPoint / activeElement / matchMedia`。
 * 选择器只认最简单的几种：`tag`、`[attr]`、`[attr="v"]`、`.class`、以及它们的拼接
 * （`style[data-plugin-css*="x"]` 这种带 `*=` 的也认）。不认空格后代选择器 —— 组件里没用到。
 *
 * 【事件】`document.dispatch('pointerdown', {target})` 会把 `addEventListener` 挂上去的
 * 监听全部叫一遍（capture 的先）。导轨"戳到外面关卡片"、焦点守卫的 pointerdown 记录
 * 都是挂在 document 上的，测试靠这一下模拟"用户点了别处"。
 *
 * ⚠️ 这里的一切都是 **plain object**：已有的测试会 `delete globalThis.window.matchMedia`
 *    再装回去（test-pointer），或者整个换掉 `globalThis.document`（test-fold）。
 *    做成 class 实例带 getter 的话那些测试会炸。
 *
 * @module dom-lite
 */

/** 当前的假 document（Element.focus 要往它身上写 activeElement）。 */
let currentDocument = null

/**
 * 一个 host 元素。react-lite 每个 `h('div', …)` 对应一个；文本节点的 tag 是 `'#text'`。
 */
export class Element {
	constructor(tag) {
		this.tag = tag
		this.props = {}
		this.children = []
		this.parent = null
		this.style = {}
		this.text = undefined
		this.rect = undefined
		this.listeners = new Map()
		this.value = undefined
		this.files = undefined
		this.dataset = {}
	}

	/** react-lite 每帧调它把 props 灌进来；`style` 抄一份可变的，组件会直接改 `el.style.borderColor`。 */
	setProps(props) {
		this.props = props
		this.style = Object.assign({}, props.style || {})
		// 受控输入框：props.value 每帧盖回 DOM 值（和真 React 一致）
		if ('value' in props && props.value !== undefined && props.value !== null) this.value = String(props.value)
		this.dataset = {}
		for (const name of Object.keys(props)) {
			if (name.startsWith('data-')) this.dataset[name.slice(5).replace(/-([a-z])/g, (_, ch) => ch.toUpperCase())] = String(props[name])
		}
	}

	get textContent() {
		if (this.tag === '#text') return this.text === undefined ? '' : String(this.text)
		if (this._text !== undefined) return this._text
		return this.children.map((child) => child.textContent).join('')
	}

	set textContent(value) {
		this._text = String(value)
	}

	get className() {
		return this.props.className || this._className || ''
	}

	set className(value) {
		this._className = String(value)
	}

	get parentElement() {
		return this.parent
	}

	get firstElementChild() {
		return this.children.find((child) => child.tag !== '#text') || null
	}

	getAttribute(name) {
		if (name === 'class') return this.className || null
		if (name in this.props) return String(this.props[name])
		if (this._attrs !== undefined && name in this._attrs) return this._attrs[name]
		return null
	}

	hasAttribute(name) {
		return this.getAttribute(name) !== null
	}

	setAttribute(name, value) {
		if (this._attrs === undefined) this._attrs = {}
		this._attrs[name] = String(value)
	}

	removeAttribute(name) {
		if (this._attrs !== undefined) delete this._attrs[name]
	}

	/** 手动往树上挂一个孩子（给测试搭宿主 DOM 用；react-lite 自己不走这条）。 */
	appendChild(child) {
		if (child.parent !== null && child.parent !== undefined && child.parent !== this) child.parent.removeChild(child)
		child.parent = this
		this.children.push(child)
		return child
	}

	removeChild(child) {
		this.children = this.children.filter((one) => one !== child)
		child.parent = null
		return child
	}

	/** 从父元素底下摘掉（`style.remove()` 那种）。 */
	remove() {
		if (this.parent !== null && this.parent !== undefined) this.parent.removeChild(this)
	}

	/** react-lite 卸载时调：不改 parent 的 children（那边会整体换掉），只断掉引用。 */
	detach() {
		this.parent = null
	}

	contains(other) {
		let at = other
		while (at !== null && at !== undefined) {
			if (at === this) return true
			at = at.parent
		}
		return false
	}

	matches(selector) {
		return (selector || '')
			.split(',')
			.map((one) => one.trim())
			.filter((one) => one !== '')
			.some((one) => matchSimple(this, one))
	}

	closest(selector) {
		let at = this
		while (at !== null && at !== undefined) {
			if (at.tag !== '#text' && at.matches(selector)) return at
			at = at.parent
		}
		return null
	}

	querySelectorAll(selector) {
		const out = []
		const walk = (el) => {
			for (const child of el.children) {
				if (child.tag !== '#text' && child.matches(selector)) out.push(child)
				walk(child)
			}
		}
		walk(this)
		return out
	}

	querySelector(selector) {
		return this.querySelectorAll(selector)[0] || null
	}

	getBoundingClientRect() {
		const rect = this.rect || { top: 0, left: 0, width: 0, height: 0 }
		return {
			top: rect.top,
			left: rect.left,
			width: rect.width,
			height: rect.height,
			right: rect.right === undefined ? rect.left + rect.width : rect.right,
			bottom: rect.bottom === undefined ? rect.top + rect.height : rect.bottom,
		}
	}

	addEventListener(type, fn) {
		if (!this.listeners.has(type)) this.listeners.set(type, new Set())
		this.listeners.get(type).add(fn)
	}

	removeEventListener(type, fn) {
		if (this.listeners.has(type)) this.listeners.get(type).delete(fn)
	}

	/** 聚焦：改 `document.activeElement`，再叫自己的 onFocus。 */
	focus() {
		if (currentDocument !== null) {
			const was = currentDocument.activeElement
			if (was === this) return
			currentDocument.activeElement = this
			if (was && typeof was.props?.onBlur === 'function') was.props.onBlur({ target: was, currentTarget: was, relatedTarget: this })
		}
		if (typeof this.props.onFocus === 'function') this.props.onFocus({ target: this, currentTarget: this })
	}

	/** 失焦：activeElement 退回 body，再叫自己的 onBlur。 */
	blur() {
		if (currentDocument !== null && currentDocument.activeElement === this) currentDocument.activeElement = currentDocument.body
		if (typeof this.props.onBlur === 'function') this.props.onBlur({ target: this, currentTarget: this, relatedTarget: null })
	}

	scrollIntoView() {}
}

/**
 * 简单选择器匹配：`tag`、`[a]`、`[a="v"]`、`[a*="v"]`、`.cls`，可拼接。
 */
function matchSimple(el, selector) {
	const re = /^([a-zA-Z][\w-]*|\*)?((?:\[[^\]]+\]|\.[\w-]+|#[\w-]+)*)$/
	const matched = re.exec(selector)
	if (matched === null) return false
	const tag = matched[1]
	if (tag !== undefined && tag !== '*' && el.tag !== tag) return false
	const rest = matched[2] || ''
	const parts = rest.match(/\[[^\]]+\]|\.[\w-]+|#[\w-]+/g) || []
	for (const part of parts) {
		if (part.startsWith('.')) {
			if (!String(el.className).split(/\s+/).includes(part.slice(1))) return false
			continue
		}
		if (part.startsWith('#')) {
			if (el.getAttribute('id') !== part.slice(1)) return false
			continue
		}
		const attr = /^\[([\w-]+)(?:([*^$]?)=["']?([^"'\]]*)["']?)?\]$/.exec(part)
		if (attr === null) return false
		const value = el.getAttribute(attr[1])
		if (value === null) return false
		if (attr[3] === undefined) continue
		if (attr[2] === '*') {
			if (!value.includes(attr[3])) return false
		} else if (attr[2] === '^') {
			if (!value.startsWith(attr[3])) return false
		} else if (attr[2] === '$') {
			if (!value.endsWith(attr[3])) return false
		} else if (value !== attr[3]) return false
	}
	return true
}

/**
 * 一个带 add/remove/dispatch 的事件目标（document 和 window 共用这套）。
 */
function eventTarget(base) {
	const listeners = new Map()
	base.addEventListener = (type, fn, options) => {
		if (!listeners.has(type)) listeners.set(type, [])
		listeners.get(type).push({ fn, capture: options === true || (options && options.capture === true) })
	}
	base.removeEventListener = (type, fn) => {
		if (!listeners.has(type)) return
		listeners.set(type, listeners.get(type).filter((one) => one.fn !== fn))
	}
	/**
	 * 派发：capture 的先叫，再叫其余的。返回事件对象。
	 * @param type - 事件名（不带 on）
	 * @param init - 盖在事件上的字段；`target` 不给就是 body
	 */
	base.dispatch = (type, init) => {
		const event = Object.assign(
			{ type, target: base.body || base, clientX: 0, clientY: 0, defaultPrevented: false, preventDefault() { this.defaultPrevented = true }, stopPropagation() {} },
			init || {},
		)
		const list = (listeners.get(type) || []).slice()
		for (const one of list.filter((item) => item.capture)) one.fn(event)
		for (const one of list.filter((item) => !item.capture)) one.fn(event)
		return event
	}
	base.listenerCount = (type) => (listeners.get(type) || []).length
	return base
}

/**
 * 造一套假 `window` + `document`。
 *
 * `document.body` 是个 Element，测试可以 `appendChild` 搭宿主的 DOM
 * （比如 `[data-conversation-scroll]`）。`document.hitTest = (x, y) => el` 可以
 * 控制 `elementFromPoint` 的答案。
 * @returns `{ window, document, body }`
 */
export function createDom() {
	const body = new Element('body')
	const html = new Element('html')
	html.appendChild(body)
	const head = new Element('head')
	const document = eventTarget({
		body,
		head,
		documentElement: html,
		activeElement: body,
		hitTest: undefined,
		createElement: (tag) => new Element(tag),
		createTextNode: (text) => {
			const el = new Element('#text')
			el.text = String(text)
			return el
		},
		querySelector: (selector) => body.querySelector(selector),
		querySelectorAll: (selector) => body.querySelectorAll(selector),
		elementFromPoint(x, y) {
			return typeof this.hitTest === 'function' ? this.hitTest(x, y) : null
		},
	})
	const window = eventTarget({
		document,
		innerWidth: 1600,
		innerHeight: 900,
		devicePixelRatio: 1,
		/** 默认当成"能悬停"的桌面；要测触摸就换掉它（test-pointer 的做法）。 */
		matchMedia: (query) => ({ matches: query === '(hover: hover)', media: query, addEventListener() {}, removeEventListener() {} }),
	})
	currentDocument = document
	return { window, document, body }
}

/** 换掉 Element.focus 要写的那个 document（test-fold 那种整个替换 document 的测试不需要调它）。 */
export function useDocument(document) {
	currentDocument = document
}
