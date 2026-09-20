/**
 * 启用 / 停用 / 再启用，两半都不许留东西。
 *
 * 【为什么要测这个】插件市场的「停用」干两件事：往 `cordis.patch.yml` 写
 * `disabled: true`，以及把包从 `dsh.profile.bundles` 里摘掉。两件事合起来 =
 * 我们的 fiber 被 dispose。**没有断言盯着的话，少收一个东西是完全静默的**：
 *   · 路由没摘 → 停用后 `/plugins/dsh-tree/outlines` 还在答，用户以为没停掉
 *   · 监听没摘 → 停用后还在接管别人的分支
 *   · 设置 namespace 没释放 → **再启用时抛 "already registered"，插件直接起不来**
 * 最后这条最要命，而它只在"停用再启用"这一条路径上才出现 —— 正常开发从不经过。
 *
 * 这里的假 ctx 按 cordis 的真契约写：`ctx.effect(body, label)` 跑 body，
 * 收下它返回的 cleanup，并返回一个 disposer；settings 那份 registry **跨 apply
 * 保留**（模拟宿主进程里那张全局表），否则"重复注册"这种 bug 根本测不出来。
 *
 * @module test-lifecycle
 */

import { check, report, loadClient } from './test-kit.mjs'
import { apply as hostApply } from './index.js'

// ===== 第 1 步：假宿主 =====

/**
 * 一个够用的假 cordis context。
 * @param world - 跨 apply 存活的东西（宿主进程级的注册表）
 * @returns `{ctx, dispose, state}`
 */
function fakeHost(world) {
	const cleanups = []
	const state = { routes: new Map(), listeners: [], logs: [] }

	const effect = (body, label) => {
		const done = body()
		cleanups.push({ label, done: typeof done === 'function' ? done : () => {} })
		return () => {}
	}

	const scoped = {
		effect,
		logger: { info: () => {}, warn: () => {} },
		settings: {
			// 照抄 dsh-settings 的真实做法：登记挂在**调用方的 fiber** 上，
			// fiber 一 dispose 就自动摘掉（它的 register 实现就是 ctx.effect(...)）
			register: (ns, schema) => {
				if (world.namespaces.has(ns)) throw new Error(`settings namespace "${ns}" is already registered`)
				effect(() => {
					world.namespaces.set(ns, schema)
					return () => world.namespaces.delete(ns)
				}, `settings.register(${ns})`)
				return { get: () => ({}), watch: () => () => {} }
			},
		},
	}

	const ctx = {
		effect,
		logger: { info: (text) => state.logs.push(text), warn: (text) => state.logs.push(text) },
		on: (event, handler) => {
			const entry = { event, handler }
			state.listeners.push(entry)
			return () => {
				state.listeners = state.listeners.filter((one) => one !== entry)
			}
		},
		inject: (_names, run) => run(scoped),
		agents: { get: () => undefined },
		sessionPersistence: { list: async () => [] },
		webServer: {
			register: (route) => {
				if (state.routes.has(route.path)) throw new Error(`duplicate route ${route.path}`)
				state.routes.set(route.path, route.handler)
				return () => state.routes.delete(route.path)
			},
		},
	}

	return {
		ctx,
		state,
		dispose: () => {
			// 后登记的先收，和 cordis 的拆解顺序一致
			for (const one of cleanups.reverse()) one.done()
			cleanups.length = 0
		},
	}
}

/**
 * 假浏览器 context。
 * @param world - 跨 apply 存活的东西
 */
function fakeClient(world) {
	const cleanups = []
	const state = { slots: new Map() }
	const effect = (body) => {
		const done = body()
		cleanups.push(typeof done === 'function' ? done : () => {})
		return () => {}
	}
	// ⚠️ 照抄真实现：`slots.inject` 和 `slots.register` **内部都是 `this.ctx.effect(...)`**
	//    （dsh-client-ui-renderer 的 SlotRegistry），所以它们自己挂在调用方的 fiber 上，
	//    调用方不用接那个 disposer。假成"普通函数调用"的话，会冤枉一个根本不存在的泄漏。
	const slots = {
		inject: (_name, run) => effect(() => run()),
		register: (spec) =>
			effect(() => {
				const key = `${spec.name}:${spec.id || spec.key}`
				if (state.slots.has(key)) throw new Error(`duplicate slot ${key}`)
				state.slots.set(key, spec)
				return () => state.slots.delete(key)
			}),
	}
	const scoped = {
		effect,
		slots,
		settingsScope: {
			bind: () => ({
				getSnapshot: () => ({ value: {}, user: {}, writable: true }),
				subscribe: () => () => {},
				set: () => {},
				unset: () => {},
			}),
		},
	}
	const ctx = {
		effect,
		slots,
		inject: (_names, run) => run(scoped),
		sessions: { list: {}, open: () => {}, binding: () => undefined, fork: async () => 'x', create: async () => 'x' },
		workspaces: { list: {} },
	}
	world.clientSlots = state.slots
	return {
		ctx,
		state,
		dispose: () => {
			for (const done of cleanups.reverse()) done()
			cleanups.length = 0
		},
	}
}

// ===== 第 2 步：host 半 =====

const world = { namespaces: new Map(), clientSlots: undefined }

console.log('用例 1：装上之后该有的都在')
{
	const host = fakeHost(world)
	hostApply(host.ctx)
	const paths = [...host.state.routes.keys()].sort()
	check(paths.length === 3, `注册了 ${paths.length} 个路由，应该是 3 个：${paths.join(' ')}`)
	check(
		paths.join(' ') === '/plugins/dsh-tree/icon /plugins/dsh-tree/outlines /plugins/dsh-tree/shape',
		`路由不对：${paths.join(' ')}`,
	)
	check(host.state.listeners.length === 1 && host.state.listeners[0].event === 'agent/created', '没接管 agent/created')
	check(world.namespaces.has('dsh-tree'), '设置 namespace 没注册上')
	console.log(`  3 个路由 + agent/created 监听 + 设置 namespace`)
	host.dispose()
	check(host.state.routes.size === 0, `停用后还剩 ${host.state.routes.size} 个路由 —— 界面没了但接口还在答`)
	check(host.state.listeners.length === 0, '停用后还在监听 agent/created —— 会继续接管别人的分支')
	check(world.namespaces.size === 0, '停用后设置 namespace 没释放 —— 再启用会抛 already registered')
	console.log('  停用后：路由 0、监听 0、namespace 0')
}

console.log('用例 2：停用 → 再启用（市场里点两下就会走这条路）')
{
	const first = fakeHost(world)
	hostApply(first.ctx)
	first.dispose()
	const second = fakeHost(world)
	let failure
	try {
		hostApply(second.ctx)
	} catch (error) {
		failure = error
	}
	check(failure === undefined, `再启用抛了：${failure && failure.message}`)
	check(second.state.routes.size === 3, `再启用后只剩 ${second.state.routes.size} 个路由`)
	check(world.namespaces.has('dsh-tree'), '再启用后设置 namespace 没回来')
	console.log('  第二次装上照样是 3 个路由 + namespace')
	second.dispose()
}

console.log('用例 3：连装两次（同一个 ctx 上重复 apply）必须当场炸，不许静默')
{
	// 这不是正常路径，但如果宿主哪天重复派发，我们宁可看见异常也不要
	// "两套路由抢同一个路径"那种查半天的怪事
	const host = fakeHost(world)
	hostApply(host.ctx)
	let failure
	try {
		hostApply(host.ctx)
	} catch (error) {
		failure = error
	}
	check(failure !== undefined, '重复 apply 没报错 —— 说明有东西被悄悄覆盖了')
	host.dispose()
	world.namespaces.clear()
	console.log(`  重复注册当场抛「${String(failure && failure.message).slice(0, 40)}」`)
}

// ===== 第 3 步：浏览器半 =====

console.log('用例 4：浏览器半也要收干净')
{
	const bundle = await loadClient()
	check(bundle !== undefined && typeof bundle.apply === 'function', 'client.js 没导出 apply')
	if (bundle !== undefined && typeof bundle.apply === 'function') {
		const client = fakeClient(world)
		bundle.apply(client.ctx)
		check(client.state.slots.size === 2, `挂了 ${client.state.slots.size} 个 slot，应该是导轨 + 设置卡片两个`)
		check([...client.state.slots.keys()].some((key) => key.startsWith('shell.overlay')), '导轨没挂上')
		client.dispose()
		check(client.state.slots.size === 0, `停用后还剩 ${client.state.slots.size} 个 slot —— 导轨会一直挂在页面上`)
		check(globalThis.window.__dshTree === undefined, '停用后 window.__dshTree 还在 —— 敲出来的是上一次的陈年数据')
		// 再来一次
		const again = fakeClient(world)
		let failure
		try {
			bundle.apply(again.ctx)
		} catch (error) {
			failure = error
		}
		check(failure === undefined, `浏览器半再启用抛了：${failure && failure.message}`)
		check(again.state.slots.size === 2, '再启用后 slot 没回来')
		again.dispose()
		console.log('  导轨 + 设置卡片挂上、收掉、再挂上；__dshTree 跟着走')
	}
}

report()
