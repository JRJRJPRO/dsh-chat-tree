/**
 * 全部测试脚本共用的那点东西：一条断言、一个收尾、一份"把浏览器半骗起来"的加载器，
 * 以及**能把组件真的挂起来**的 `mount`。
 *
 * 【为什么有这个文件】断言和加载器以前在每个 test-*.mjs 里各抄了一遍。抄 N 遍的东西一旦要改
 * （比如 client.js 换了加载方式），就得改 N 处，而漏掉的那处会**静悄悄跳过整个文件的断言**。
 *
 * 【新写一个测试脚本】
 *   import { check, report, loadClientPure } from './test-kit.mjs'
 *   const pure = await loadClientPure()      // 只有要测浏览器半才需要
 *   check(条件, '失败时打印什么')
 *   report()                                  // 最后一行
 *
 * 【要测组件（卡片 / 设置卡 / 导轨）】
 *   import { check, report, loadClient, mount, h, dom } from './test-kit.mjs'
 *   const { __pure } = await loadClient()
 *   const card = mount(h(__pure.Detail, { node, labels: {}, … }))
 *   card.fire(card.el, 'onDoubleClick')
 *   check(card.byTitle('把这条支线拆成独立的一棵树') !== undefined, '展开后该露出 ⇥')
 *   card.unmount()
 * 组件从 `__pure` 里拿（pure.js 把 Detail / SettingsCard / Rail 也挂了出去）。
 * react 是 tests/kit/react-lite.mjs 那份极简实现，DOM 是 tests/kit/dom-lite.mjs。
 *
 * @module test-kit
 */

import { createReactLite } from './kit/react-lite.mjs'
import { createDom } from './kit/dom-lite.mjs'

let failures = 0

/**
 * 一条断言。**不抛异常** —— 一次跑完把所有问题都摆出来，比修一条跑一次快得多。
 * @param ok - 条件
 * @param message - 失败时打印什么
 */
export function check(ok, message) {
	if (ok) return
	failures += 1
	console.log(`  ✗ ${message}`)
}

/**
 * 收尾：打印结论并决定退出码。**每个脚本的最后一行。**
 * @returns 失败条数
 */
export function report() {
	console.log(failures === 0 ? '\n✓ 全部断言通过' : `\n✗ ${failures} 条断言失败`)
	process.exit(failures === 0 ? 0 : 1)
}

/**
 * 等几毫秒（让 setTimeout 0 这类排到下一帧的东西跑完）。
 * @param ms - 毫秒，缺省 0
 */
export const tick = (ms) => new Promise((resolve) => setTimeout(resolve, ms || 0))

/** 极简 react。`loadClient()` 把它喂给 client.js 的 factory；测试自己也能直接用。 */
export const lite = createReactLite()

/** react-lite 的 react 对象（`useState` 这些）。 */
export const react = lite.react

/** `h(type, props, ...children)`，和组件里用的是同一个 createElement。 */
export const h = lite.react.createElement

/** 把一个 vnode 挂起来。见 react-lite.mjs 里 `mount` 返回的句柄。 */
export const mount = lite.mount

/** 假 DOM：`dom.document` / `dom.window` / `dom.body`。`loadClient()` 会把它装到 globalThis 上。 */
export const dom = createDom()

/**
 * 加载 client.js 并把它的纯函数取出来。
 *
 * client.js 是给浏览器的 `window.__ModuleLoader__.load({factory})` 格式，
 * 这里塞一个假的 loader 和 react-lite，让 factory 跑完，
 * 然后从 `exports.__pure` 拿函数 —— **测的是真代码，不是复制品**。
 *
 * ⚠️ 测的是**生成物** `client.js`，不是 `src/client/*.js`。改了 src 忘了
 *    `npm run build` 的话，测的还是旧代码 —— 所以 `npm test` 第一步就是构建。
 * @returns client.js 的 __pure 出口
 */
export async function loadClientPure() {
	return (await loadClient()).__pure
}

/**
 * 同上，但把 bundle 的**全部出口**给出来（`apply` / `inject` / `__pure`）。
 *
 * 测启用、停用这类生命周期的东西要调 `apply`，光有纯函数不够。
 *
 * ⚠️ 只加载一次：`import('../client.js')` 第二次会命中 ESM 缓存，factory 不会重跑，
 *    所以结果缓存在模块里，谁来要都是同一份。
 * @returns client.js 的 module.exports
 */
export async function loadClient() {
	if (loaded !== undefined) return loaded
	let exported
	// window / document 是 plain object：已有的测试会 delete / 替换上面的字段再装回去
	globalThis.window = dom.window
	globalThis.window.__ModuleLoader__ = {
		load: (definition) => {
			exported = definition.factory((name) => {
				if (name === 'react') return lite.react
				if (name === 'react-dom') return lite.reactDom
				throw new Error(`client.js require 了没准备的模块：${name}`)
			})
		},
	}
	// 真的存得住的 localStorage。以前是个"读永远给 {}、写永远丢掉"的假货，
	// 于是改名和收藏那一整套**存进去再读出来**的逻辑，一条断言都写不出来。
	globalThis.localStorage = storage()
	globalThis.sessionStorage = storage()
	globalThis.document = dom.document
	// hooks.js 的 schedule 用 rAF；node 里没有，拿 setTimeout 顶
	if (typeof globalThis.requestAnimationFrame !== 'function') {
		globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 16)
		globalThis.cancelAnimationFrame = (id) => clearTimeout(id)
	}
	await import('../client.js')
	if (exported === undefined || exported.__pure === undefined) throw new Error('client.js 没有导出 __pure，测试无法进行')
	loaded = exported
	return loaded
}

/** 一份内存里的 Storage。 */
function storage() {
	const cells = new Map()
	return {
		getItem: (key) => (cells.has(key) ? cells.get(key) : null),
		setItem: (key, value) => cells.set(key, String(value)),
		removeItem: (key) => cells.delete(key),
		clear: () => cells.clear(),
		get length() {
			return cells.size
		},
		key: (index) => [...cells.keys()][index] ?? null,
	}
}

/** `loadClient()` 的缓存。 */
let loaded
