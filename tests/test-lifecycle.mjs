/**
 * 启用 / 停用 / 再启用，两半都不许留东西。
 *
 * 【为什么要测这个】插件市场的「停用」干两件事：往 `cordis.patch.yml` 写
 * `disabled: true`，以及把包从 `dsh.profile.bundles` 里摘掉。两件事合起来 =
 * 我们的 fiber 被 dispose。**没有断言盯着的话，少收一个东西是完全静默的**：
 *   · 路由没摘 → 停用后 `/plugins/dsh-chat-tree/outlines` 还在答，用户以为没停掉
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

import { check, report, loadClient, loadClientPure } from './test-kit.mjs'
import { __test, Config, SETTINGS_NS, apply as hostApply } from '../index.js'

// ===== 第 1 步：假宿主 =====

/**
 * 一个够用的假 cordis context。
 * @param world - 跨 apply 存活的东西（宿主进程级的注册表）
 * @param generation - 学哪代宿主：1 = dsh 0.1.5（settings 有 register）；
 *                     2 = dsh 0.2 桌面版（settings 是 SettingsForms，只有 configure，靠插件的 Config）
 * @returns `{ctx, dispose, state}`
 */
function fakeHost(world, generation = 1) {
	const cleanups = []
	const state = { routes: new Map(), listeners: [], logs: [] }

	const effect = (body, label) => {
		const done = body()
		cleanups.push({ label, done: typeof done === 'function' ? done : () => {} })
		return () => {}
	}

	const settings = generation === 2
		? { configure: () => () => {} }
		: {
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
		}
	const scoped = {
		effect,
		logger: { info: (text) => state.logs.push(text), warn: (text) => state.logs.push(text) },
		settings,
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
function fakeClient(world, generation = 1) {
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
	const scope = {
		getSnapshot: () => ({ value: {}, user: {}, writable: true }),
		subscribe: () => () => {},
		set: () => {},
		unset: () => {},
	}
	state.opened = [] // 谁被"打开"了：0.1.5 走 ctx.sessions.open，0.2 走 uiWorkspace.openSession
	state.status = new Map([['s2', { running: false, completionUnread: true }]])
	const scoped = {
		effect,
		slots,
		// 两代宿主的设置服务只挂一个：0.1.5 是 settingsScope.bind，0.2 是 configForms.get。
		// 0.2 另外多两个服务：uiWorkspace（开会话）和 uiSession（在跑 / 跑完未读的状态表）。
		...(generation === 2
			? {
				configForms: { get: () => scope },
				uiWorkspace: { openSession: (id) => state.opened.push(`ui:${id}`) },
				uiSession: { sessionStatus: { getSnapshot: () => state.status, subscribe: () => () => {} } },
			}
			: { settingsScope: { bind: () => scope } }),
	}
	const ctx = {
		effect,
		slots,
		// 照抄 cordis：要的服务**全都在**回调才跑，缺一个就静默等着（这里就是永远不跑）。
		// 以前不看名字一律跑，两代宿主的两条 inject 就会都跑，冤枉出一个"多挂了 slot"。
		inject: (names, run) => (names.every((one) => one in scoped) ? run(scoped) : undefined),
		// 0.2 的 sessions 服务没有 open 了 —— 假件也不给，走错路会当场 TypeError
		sessions: {
			list: {},
			...(generation === 2 ? {} : { open: (id) => state.opened.push(`sessions:${id}`) }),
			binding: () => undefined, fork: async () => 'x', create: async () => 'x',
		},
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
	check(paths.length === 4, `注册了 ${paths.length} 个路由，应该是 4 个：${paths.join(' ')}`)
	check(
		paths.join(' ') === '/plugins/dsh-chat-tree/icon /plugins/dsh-chat-tree/labels /plugins/dsh-chat-tree/outlines /plugins/dsh-chat-tree/shape',
		`路由不对：${paths.join(' ')}`,
	)
	check(host.state.listeners.length === 1 && host.state.listeners[0].event === 'agent/created', '没接管 agent/created')
	check(world.namespaces.has('dsh-chat-tree'), '设置 namespace 没注册上')
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
	check(second.state.routes.size === 4, `再启用后只剩 ${second.state.routes.size} 个路由`)
	check(world.namespaces.has('dsh-chat-tree'), '再启用后设置 namespace 没回来')
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

console.log('用例 5：停用时，等父会话空闲的补接定时器也要一并取消')
{
	// 父会话正在跑的时候开岔路，graft 会先收手（读旁车会打断那一轮），
	// 改成排队等它空下来再补。⚠️ 这些定时器要是活过插件本身，
	// 就会在插件已经卸掉之后去写别人的旁车 —— 这一条就钉着它。
	__test.cancelPendingGrafts() // 先清干净，免得被前面的用例带进来
	const host = fakeHost(world)
	hostApply(host.ctx)
	// 间隔给得很长：这一条测的是"停用能不能取消"，不是"重试灵不灵"
	__test.scheduleGraftRetry(host.ctx, 'child-1', 'parent-1', 3, { intervalMs: 60000 })
	__test.scheduleGraftRetry(host.ctx, 'child-2', 'parent-1', 5, { intervalMs: 60000 })
	host.dispose()
	const leaked = __test.cancelPendingGrafts()
	check(leaked === 0, `停用后还剩 ${leaked} 个补接定时器 —— 它们会活过插件，去写已经不归我们管的旁车`)
	world.namespaces.clear()
	console.log('  排了 2 个补接，停用后一个不剩')
}

// ===== 第 4 步：dsh 0.2（桌面版）的宿主 =====

console.log('用例 6：0.2 的宿主没有 settings.register —— 两半都得照常装上，设置改走 Config')
{
	// host 半：settings 服务在，但只有 configure。以前这里会在宿主的 fiber 里抛
	// "register is not a function"，日志一条红字，设置不工作，人还以为插件坏了。
	const host = fakeHost(world, 2)
	let failure
	try {
		hostApply(host.ctx)
	} catch (error) {
		failure = error
	}
	check(failure === undefined, `0.2 宿主上 apply 抛了：${failure && failure.message}`)
	check(host.state.routes.size === 4, `0.2 宿主上只注册了 ${host.state.routes.size} 个路由`)
	check(world.namespaces.size === 0, '0.2 宿主上不该再登记 namespace（它没有这个概念）')
	check(host.state.logs.some((line) => /Config/.test(line)), '0.2 宿主上该有一行日志说明设置改走 Config')
	host.dispose()

	// Config 出口：宿主按它出表单，每个字段都要标 volatile，否则不显示、写了也被拒
	const fields = Object.keys(Config.dict || {})
	check(fields.length >= 10, `Config 只有 ${fields.length} 个字段 —— 和 SETTINGS_SCHEMA 不是同一份？`)
	const dead = fields.filter((name) => Config.dict[name].meta.volatile !== true)
	check(dead.length === 0, `这些字段没标 volatile，0.2 的设置表单里不会出现：${dead.join(' ')}`)
	check(Config.meta.volatile !== true, '整个 Config 不该整体标 volatile —— 宿主只认"字段级"的固定路径')
	// 宿主拿到的是 `new Schema(Config.toJSON())` 重建出来的副本（dsh-settings 的 plainSchema）：
	// schemastery 的 toJSON 是 {uid, refs} 那种图，两边（npm 版 / @deepseek-ai 版）格式一样
	const json = typeof Config.toJSON === 'function' ? Config.toJSON() : undefined
	check(Config.type === 'object' && json !== undefined && json.refs !== undefined && json.refs[json.uid].type === 'object', 'Config 必须是 object 且能 toJSON 成 {uid, refs}，宿主靠它重建表单 schema')

	// 浏览器半：没有 settingsScope，只有 configForms；设置卡不再挂 settings.plugin.item，
	// 改挂设置导航里自己的一节 settings.section，id 必须是 entry id（SETTINGS_NS）
	const bundle = await loadClient()
	if (bundle !== undefined && typeof bundle.apply === 'function') {
		const client = fakeClient(world, 2)
		bundle.apply(client.ctx)
		const keys = [...client.state.slots.keys()]
		check(keys.length === 2, `0.2 宿主上挂了 ${keys.length} 个 slot，应该是导轨 + 设置一节：${keys.join(' ')}`)
		check(keys.includes(`settings.section:${SETTINGS_NS}`), `设置那一节没挂上或 id 不是 ${SETTINGS_NS}：${keys.join(' ')}`)
		check(!keys.some((key) => key.startsWith('settings.plugin.item')), '0.2 宿主上不该再挂 settings.plugin.item（那个插槽已经没了）')
		const section = client.state.slots.get(`settings.section:${SETTINGS_NS}`)
		check(section !== undefined && typeof section.label === 'function' && section.label() === '对话树', '设置那一节的导航标题该是「对话树」')
		check(section !== undefined && section.inject().section === true, '独占一节时要告诉设置卡 section:true（根元素换 div、默认展开）')

		// 会话服务的三处搬家：开会话走 uiWorkspace.openSession（0.2 的 sessions 没有 open 了），
		// 状态表从 uiSession.sessionStatus 转发过来
		const rail = client.state.slots.get('shell.overlay:dsh-chat-tree')
		const api = rail !== undefined ? rail.inject().api : undefined
		check(api !== undefined, '导轨 slot 没把 api 注进去')
		if (api !== undefined) {
			await api.open('s1')
			check(JSON.stringify(client.state.opened) === '["ui:s1"]', `0.2 宿主上开会话该走 uiWorkspace.openSession，实际 ${JSON.stringify(client.state.opened)}`)
			const status = api.status.getSnapshot()
			check(status instanceof Map && status.get('s2').completionUnread === true, '0.2 宿主的状态表没转发到 api.status')
		}
		client.dispose()
		check(client.state.slots.size === 0, `0.2 宿主上停用后还剩 ${client.state.slots.size} 个 slot`)

		// 0.1.5 那条路也钉住：开会话走 sessions.open，状态表是空的
		const old = fakeClient(world, 1)
		bundle.apply(old.ctx)
		const oldApi = old.state.slots.get('shell.overlay:dsh-chat-tree').inject().api
		await oldApi.open('s1')
		check(JSON.stringify(old.state.opened) === '["sessions:s1"]', `0.1.5 宿主上开会话该走 sessions.open，实际 ${JSON.stringify(old.state.opened)}`)
		check(oldApi.status.getSnapshot() === undefined, '0.1.5 宿主上没有状态表，api.status 该是 undefined')
		old.dispose()
		console.log(`  host 4 个路由、不登记 namespace；Config ${fields.length} 个字段全 volatile；浏览器半挂 settings.section:${SETTINGS_NS}；开会话两代各走各的`)
	}

	// 列表快照的两代差异（tree.js 的 currentOf / withStatus）
	const pure = await loadClientPure()
	const old = { ids: ['a', 'b'], byId: { a: {}, b: {} }, current: 'a' }
	check(pure.currentOf(old) === 'a', '0.1.5：current 字段直接就是当前会话')
	const fresh = { ids: ['a', 'b', 'c'], byId: { a: { retainedBy: {} }, b: { retainedBy: { mainView: 1 } }, c: {} } }
	check(pure.currentOf(fresh) === 'b', '0.2：retainedBy.mainView > 0 的那条才是当前会话')
	check(pure.currentOf({ ids: ['a'], byId: { a: { retainedBy: { mainView: 0 } } } }) === undefined, 'mainView 为 0 不算当前')
	check(pure.currentOf(undefined) === undefined, '没有快照就没有当前会话')
	check(pure.withStatus(fresh, undefined) === fresh, '没有状态表时必须原样返回同一个对象（memo 靠引用）')
	check(pure.withStatus(fresh, new Map()) === fresh, '空状态表也原样返回')
	const merged = pure.withStatus(fresh, new Map([['a', { running: true }], ['b', { running: false, completionUnread: true }], ['zz', { completionUnread: true }]]))
	check(merged !== fresh && merged.byId.a.running === true && merged.byId.b.completed === true && merged.byId.b.running === false, `状态表没并进列表项：${JSON.stringify(merged.byId)}`)
	check(merged.byId.c === fresh.byId.c && fresh.byId.b.completed === undefined, '没在状态表里的项要原样保留，且不许改传进来的快照')
	check(pure.withStatus(merged, new Map([['b', { running: false, completionUnread: false }]])).byId.b.completed === undefined, '读过之后 completed 要摘掉')
	console.log('  currentOf / withStatus：两代快照都认，状态表按宿主的 running ?? 列表项 合并')
}

report()
