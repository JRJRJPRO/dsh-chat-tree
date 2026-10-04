/**
 * react-lite：给离线测试用的一个**极简 React**。
 *
 * 【为什么要自己写一个】浏览器半的组件（详情卡、设置卡、导轨）只拿得到宿主注入的 react，
 * node 里没有。以前测试塞的是一个 `Proxy`（什么 hook 都返回 undefined），于是组件
 * 一行都跑不起来 —— 卡片"双击展开 / 点外面收起 / 改名时不许关"这类交互 bug，
 * 一条断言都写不出来，全靠 John 在桌面版里手点。
 *
 * 这个文件实现了组件真正用到的那一小撮 API（`grep -o 'react\.[A-Za-z]*' src/client`
 * 就这几个）：createElement、useState、useRef、useEffect、useMemo、useCallback。
 * 渲染是**同步**的：setState 立刻重画整棵树，effect 在重画之后立刻跑。
 * 没有调度、没有并发、没有 Suspense —— 测试要的就是"确定性"。
 *
 * 【产出是什么】不是真 DOM，是一棵 `Element` 树（见 dom-lite.mjs）：每个 host 节点
 * 有 `tag / props / children / parent / style`，支持 `contains / closest / querySelector`
 * 这几个组件真用到的方法。事件靠 `fire(el, 'onClick', …)` 手动派发，沿 parent 冒泡，
 * `stopPropagation` 能拦住 —— 和 React 的合成事件同一套语义。
 *
 * 【怎么用】见 test-kit.mjs 的 `mount()`，以及 test-card.mjs 里的例子。
 *
 * @module react-lite
 */

import { Element } from './dom-lite.mjs'

/** 这些事件在 React 里**不冒泡**，派发时只打给目标自己。 */
const NON_BUBBLING = new Set(['onMouseEnter', 'onMouseLeave', 'onPointerEnter', 'onPointerLeave'])

/** 重画的死循环保险：一次 flush 里超过这么多轮还没稳定，就是 effect 在无条件 setState。 */
const MAX_PASSES = 100

/**
 * 造一份独立的 react 实例。每个测试进程一份就够（test-kit 只造一次）。
 * @returns `{ react, reactDom, mount }`
 */
export function createReactLite() {
	const Fragment = Symbol('Fragment')

	// ===== 第 1 步：createElement =====
	//
	// 和 React 一样：`key` 不进 props；children 既可以是第三个参数起的位置参数，
	// 也可以是 props.children。数组一律摊平，null / undefined / 布尔值丢掉。

	const flatten = (list, out) => {
		for (const item of list) {
			if (Array.isArray(item)) flatten(item, out)
			else if (item === null || item === undefined || typeof item === 'boolean') continue
			else out.push(item)
		}
		return out
	}

	function createElement(type, props, ...kids) {
		const given = props === null || props === undefined ? {} : props
		const next = {}
		let key = null
		for (const name of Object.keys(given)) {
			if (name === 'key') key = given.key === null || given.key === undefined ? null : String(given.key)
			else next[name] = given[name]
		}
		const children = kids.length > 0 ? kids : given.children === undefined ? [] : [given.children]
		next.children = flatten(children, [])
		return { $$vnode: true, type, key, props: next }
	}

	// ===== 第 2 步：fiber 树 =====
	//
	// 一个 fiber = 一个 vnode 的"实例"：组件 fiber 带 hooks，host fiber 带 Element，
	// 文本 fiber 带 text。重画时按 (key 或 位置) + type 复用旧 fiber，否则卸掉重建。

	let cursor = null // 正在渲染的组件 fiber
	let hookAt = 0
	let rendering = false
	let dirty = false
	const roots = new Set()
	let effectQueue = []

	const normalize = (out) => flatten([out], [])

	const sameDeps = (a, b) => {
		if (a === undefined || b === undefined) return false
		if (a.length !== b.length) return false
		for (let i = 0; i < a.length; i += 1) if (!Object.is(a[i], b[i])) return false
		return true
	}

	/**
	 * 卸掉一个 fiber：跑掉它和后代的全部 effect cleanup，ref 置空。
	 * @param fiber - 要卸的 fiber
	 */
	function unmount(fiber) {
		for (const child of fiber.children) unmount(child)
		if (fiber.hooks !== undefined) {
			for (const hook of fiber.hooks) {
				if (hook.kind === 'effect' && typeof hook.cleanup === 'function') {
					const done = hook.cleanup
					hook.cleanup = undefined
					done()
				}
			}
		}
		if (fiber.el !== undefined && fiber.el.detach) fiber.el.detach()
		if (fiber.el !== undefined) setRef(fiber.props, null)
		fiber.alive = false
	}

	function setRef(props, value) {
		const ref = props && props.ref
		if (typeof ref === 'function') ref(value)
		else if (ref !== null && ref !== undefined && typeof ref === 'object') ref.current = value
	}

	/**
	 * 把一组 vnode 对上一组旧 fiber。
	 * @param olds - 上一帧的 fiber
	 * @param vnodes - 这一帧的 vnode
	 * @param parentEl - 最近的 host 祖先元素（组件 fiber 没有自己的元素）
	 * @returns 新的 fiber 数组
	 */
	function reconcile(olds, vnodes, parentEl) {
		const byKey = new Map()
		const byIndex = []
		for (const [index, old] of olds.entries()) {
			if (old.key !== null) byKey.set(old.key, old)
			else byIndex[index] = old
		}
		const used = new Set()
		const out = []
		for (const [index, vnode] of vnodes.entries()) {
			const isText = typeof vnode === 'string' || typeof vnode === 'number'
			const type = isText ? '#text' : vnode.type
			const key = isText ? null : vnode.key
			let old = key !== null ? byKey.get(key) : byIndex[index]
			if (old !== undefined && (old.type !== type || used.has(old))) old = undefined
			if (old !== undefined) used.add(old)
			out.push(renderFiber(old, vnode, type, isText, parentEl))
		}
		for (const old of olds) if (!used.has(old)) unmount(old)
		return out
	}

	/**
	 * 渲染一个 vnode（复用旧 fiber 或新建）。
	 * @returns fiber
	 */
	function renderFiber(old, vnode, type, isText, parentEl) {
		const fiber = old || { type, key: isText ? null : vnode.key, children: [], alive: true }
		fiber.alive = true
		if (isText) {
			fiber.text = String(vnode)
			if (fiber.el === undefined) fiber.el = new Element('#text')
			fiber.el.text = fiber.text
			fiber.el.parent = parentEl
			return fiber
		}
		fiber.props = vnode.props
		if (type === Fragment) {
			fiber.children = reconcile(fiber.children, vnode.props.children, parentEl)
			return fiber
		}
		if (typeof type === 'function') {
			if (fiber.hooks === undefined) fiber.hooks = []
			const outer = cursor
			const outerAt = hookAt
			cursor = fiber
			hookAt = 0
			let out
			try {
				out = type(vnode.props)
			} finally {
				cursor = outer
				hookAt = outerAt
			}
			fiber.children = reconcile(fiber.children, normalize(out), parentEl)
			return fiber
		}
		if (typeof type === 'string') {
			if (fiber.el === undefined) fiber.el = new Element(type)
			const el = fiber.el
			el.parent = parentEl
			el.setProps(vnode.props)
			fiber.children = reconcile(fiber.children, vnode.props.children, el)
			el.children = hostChildren(fiber)
			setRef(vnode.props, el)
			return fiber
		}
		throw new Error(`react-lite 不认这种 vnode type：${String(type)}`)
	}

	/** 一个 fiber 底下**最近的那层** host 元素（穿过组件 fiber 和 Fragment）。 */
	function hostChildren(fiber) {
		const out = []
		const walk = (node) => {
			for (const child of node.children) {
				if (child.el !== undefined) out.push(child.el)
				else walk(child)
			}
		}
		walk(fiber)
		return out
	}

	// ===== 第 3 步：hooks =====

	function hook(kind, init) {
		if (cursor === null) throw new Error(`react-lite：${kind} 只能在组件渲染期间调用`)
		const slot = cursor.hooks[hookAt]
		hookAt += 1
		if (slot !== undefined) {
			if (slot.kind !== kind) throw new Error(`react-lite：hook 顺序变了（第 ${hookAt} 个以前是 ${slot.kind}，现在是 ${kind}）`)
			return slot
		}
		const made = init()
		made.kind = kind
		cursor.hooks.push(made)
		return made
	}

	function useState(initial) {
		const slot = hook('state', () => ({ state: typeof initial === 'function' ? initial() : initial }))
		if (slot.set === undefined) {
			slot.set = (next) => {
				const value = typeof next === 'function' ? next(slot.state) : next
				if (Object.is(value, slot.state)) return
				slot.state = value
				schedule()
			}
		}
		return [slot.state, slot.set]
	}

	function useRef(initial) {
		return hook('ref', () => ({ current: initial }))
	}

	function useMemo(factory, deps) {
		const slot = hook('memo', () => ({ deps: undefined, value: undefined }))
		if (!sameDeps(slot.deps, deps)) {
			slot.value = factory()
			slot.deps = deps
		}
		return slot.value
	}

	function useCallback(fn, deps) {
		return useMemo(() => fn, deps)
	}

	function useEffect(fn, deps) {
		const slot = hook('effect', () => ({ deps: undefined, cleanup: undefined, fiber: cursor }))
		if (slot.deps !== undefined && sameDeps(slot.deps, deps)) return
		slot.deps = deps === undefined ? undefined : deps.slice()
		slot.pending = fn
		effectQueue.push(slot)
	}

	// ===== 第 4 步：根与调度 =====

	function schedule() {
		if (rendering) {
			dirty = true
			return
		}
		flush()
	}

	function runEffects() {
		const queue = effectQueue
		effectQueue = []
		for (const slot of queue) {
			if (!slot.fiber.alive) continue
			if (typeof slot.cleanup === 'function') slot.cleanup()
			slot.cleanup = undefined
			const fn = slot.pending
			slot.pending = undefined
			if (typeof fn !== 'function') continue
			const result = fn()
			slot.cleanup = typeof result === 'function' ? result : undefined
		}
	}

	/** 把所有根重画到稳定为止（effect 里 setState 会再画一轮）。 */
	function flush() {
		if (rendering) {
			dirty = true
			return
		}
		rendering = true
		try {
			let passes = 0
			do {
				dirty = false
				passes += 1
				if (passes > MAX_PASSES) throw new Error(`react-lite：重画了 ${MAX_PASSES} 轮还没稳定 —— 有 effect 在无条件 setState`)
				for (const root of roots) {
					if (root.vnode === null) continue
					root.fibers = reconcile(root.fibers, normalize(root.vnode), root.container)
					root.container.children = root.fibers.flatMap((fiber) => (fiber.el !== undefined ? [fiber.el] : hostChildren(fiber)))
				}
				runEffects()
			} while (dirty)
		} finally {
			rendering = false
		}
	}

	/**
	 * 挂一棵树。
	 * @param vnode - `h(Component, props)`
	 * @param container - 挂到哪个 Element 下（缺省新建一个 `#root`）
	 * @returns 句柄，见下面各方法的说明
	 */
	function mount(vnode, container) {
		const root = { vnode, fibers: [], container: container || new Element('#root') }
		roots.add(root)
		flush()
		const all = () => {
			const out = []
			const walk = (el) => {
				for (const child of el.children) {
					if (child.tag !== '#text') out.push(child)
					walk(child)
				}
			}
			walk(root.container)
			return out
		}
		const handle = {
			/** 容器元素。 */
			get container() {
				return root.container
			},
			/** 第一个 host 元素（组件的根 div）。 */
			get el() {
				return root.container.children[0]
			},
			/** 换 props 重画（同一个组件）。 */
			update(next) {
				root.vnode = next
				flush()
			},
			/** 卸掉：全部 effect cleanup 都会跑。 */
			unmount() {
				root.vnode = null
				for (const fiber of root.fibers) unmount(fiber)
				root.fibers = []
				root.container.children = []
				roots.delete(root)
			},
			/** 所有 host 元素，深度优先。 */
			all,
			/** 第一个满足条件的元素。 */
			find(pred) {
				return all().find(pred)
			},
			findAll(pred) {
				return all().filter(pred)
			},
			/** 按 `title` 属性找（卡片上的按钮全靠 title 说明自己是谁）。 */
			byTitle(title) {
				return all().find((el) => el.props.title === title)
			},
			/**
			 * 按文字找：**最深**的那个 textContent 正好等于 `text` 的元素。
			 * 深的优先，不然拿到的是整张卡片的外壳。
			 */
			byText(text) {
				const hits = all().filter((el) => el.textContent === text)
				return hits[hits.length - 1]
			},
			/** 按某个 prop 的值找。 */
			byProp(name, value) {
				return all().find((el) => el.props[name] === value)
			},
			/**
			 * 派发一个 React 风格的事件：从 `el` 沿 parent 冒泡，`stopPropagation` 能拦。
			 * @param el - 目标元素
			 * @param name - 处理器名，如 `'onClick'`
			 * @param init - 盖在事件上的字段（`key` / `target` / `nativeEvent` …）
			 * @returns 派发完的事件对象
			 */
			fire(el, name, init) {
				return fire(el, name, init)
			},
			/** 手动再画一轮（比如改了 ref 之后）。 */
			flush,
		}
		return handle
	}

	/**
	 * 派发事件（也给 Element.focus/blur 用）。
	 */
	function fire(el, name, init) {
		if (el === undefined || el === null) throw new Error(`react-lite.fire：目标元素是 ${el}（${name}）`)
		const event = Object.assign(
			{
				type: name.replace(/^on/, '').toLowerCase(),
				target: el,
				currentTarget: el,
				defaultPrevented: false,
				nativeEvent: {},
				preventDefault() {
					this.defaultPrevented = true
				},
				stopPropagation() {
					this.__stopped = true
				},
			},
			init || {},
		)
		let node = el
		while (node !== null && node !== undefined) {
			const handler = node.props && node.props[name]
			if (typeof handler === 'function') {
				event.currentTarget = node
				handler(event)
				if (event.__stopped) break
			}
			if (NON_BUBBLING.has(name)) break
			node = node.parent
		}
		return event
	}

	const react = { createElement, Fragment, useState, useRef, useEffect, useLayoutEffect: useEffect, useMemo, useCallback }
	const reactDom = {
		/** portal 原地渲染：测试里不需要真的挪到 body 底下。 */
		createPortal: (child) => child,
	}
	return { react, reactDom, mount, fire, flush }
}
