/**
 * 八个测试脚本共用的那点东西：一条断言、一个收尾、一份"把浏览器半骗起来"的加载器。
 *
 * 【为什么有这个文件】这三样以前在每个 test-*.mjs 里各抄了一遍。抄八遍的东西一旦要改
 * （比如 client.js 换了加载方式），就得改八处，而漏掉的那处会**静悄悄跳过整个文件的断言**。
 *
 * 【新写一个测试脚本】
 *   import { check, report, loadClientPure } from './test-kit.mjs'
 *   const pure = await loadClientPure()      // 只有要测浏览器半才需要
 *   check(条件, '失败时打印什么')
 *   report()                                  // 最后一行
 *
 * @module test-kit
 */

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
 * 加载 client.js 并把它的纯函数取出来。
 *
 * client.js 是给浏览器的 `window.__ModuleLoader__.load({factory})` 格式，
 * 这里塞一个假的 loader 和假的 react/react-dom，让 factory 跑完，
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
 * ⚠️ 只加载一次：`import('./client.js')` 第二次会命中 ESM 缓存，factory 不会重跑，
 *    所以结果缓存在模块里，谁来要都是同一份。
 * @returns client.js 的 module.exports
 */
export async function loadClient() {
	if (loaded !== undefined) return loaded
	const fakeReact = new Proxy({}, { get: () => () => undefined })
	let exported
	globalThis.window = {
		__ModuleLoader__: {
			load: (definition) => {
				exported = definition.factory((name) => (name === 'react' ? fakeReact : { createPortal: () => null }))
			},
		},
	}
	// 真的存得住的 localStorage。以前是个"读永远给 {}、写永远丢掉"的假货，
	// 于是改名和收藏那一整套**存进去再读出来**的逻辑，一条断言都写不出来。
	const cells = new Map()
	globalThis.localStorage = {
		getItem: (key) => (cells.has(key) ? cells.get(key) : null),
		setItem: (key, value) => cells.set(key, String(value)),
		removeItem: (key) => cells.delete(key),
		clear: () => cells.clear(),
	}
	globalThis.document = { querySelector: () => null, head: { appendChild: () => {} }, createElement: () => ({ dataset: {}, remove: () => {} }) }
	await import('./client.js')
	if (exported === undefined || exported.__pure === undefined) throw new Error('client.js 没有导出 __pure，测试无法进行')
	loaded = exported
	return loaded
}

/** `loadClient()` 的缓存。 */
let loaded
