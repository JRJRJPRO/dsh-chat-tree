/**
 * 装配：宿主 API 的转调层 + 往 slot 上挂组件。
 *
 * 这是浏览器半唯一碰宿主服务（`ctx.sessions` / `ctx.slots` / `ctx.workspaces`）的地方，
 * 别处一律只用下面这个 `api` 对象。插件自己不碰会话数据，全是转调。
 */
import { SETTINGS_NS } from './const.js'
import { warn, postJson } from './net.js'
import { pinActiveTurn } from './hooks.js'
import { settingsStore } from './settings-model.js'
import { SettingsCard } from './ui-settings.js'
import { Rail } from './rail.js'

export const inject = ['slots', 'sessions', 'workspaces']

/**
 * 转调宿主 API 的统一外壳：**出了事只告警，绝不让异常冒到 React 渲染里去**。
 *
 * 导轨是常驻组件，一个没接住的异常就是整条导轨白屏 —— 而它只是个旁观者，
 * 宿主 API 哪次抽风都不该由它来陪葬。
 * @param what - 人话，说清楚是哪件事没成
 * @param run - 真正要干的事
 * @returns run 的结果；失败就是 undefined
 */
async function attempt(what, run) {
	try {
		return await run()
	} catch (error) {
		warn(what, error)
		return undefined
	}
}

/**
 * 插件体。
 * @param ctx - 浏览器根 context
 */
export function apply(ctx) {
	// ===== 两代宿主在浏览器半的三处分岔（DESIGN.md「宿主 0.2：浏览器半的三处搬家」）=====
	//
	// 0.1.5 的"当前会话 / 打开会话 / 跑完未读"全在 `ctx.sessions` 上；0.2（桌面版起）
	// 拆到了三个服务：当前会话看列表项的 `retainedBy.mainView`（tree.js 的 currentOf），
	// 打开会话是 `uiWorkspace.openSession`，跑完未读是 `uiSession.sessionStatus`。
	// 这两个服务都用 `ctx.inject` 可选地接：0.1.5 没有它们，回调永远不跑，走老路。
	// **认服务，不认版本号** —— 宿主哪天把这几样搬回来，这里一行都不用改。
	const hosted = { open: undefined, status: undefined }
	// 状态表的订阅者。Rail 装上时服务可能还没到，所以订阅先记在这儿，服务到了再接过去并通知一次。
	const statusFans = new Set()
	const tellStatusFans = () => {
		for (const fn of [...statusFans]) fn()
	}
	try {
		ctx.inject(['uiWorkspace'], (scoped) => {
			hosted.open = (id) => scoped.uiWorkspace.openSession(id)
		})
		ctx.inject(['uiSession'], (scoped) => {
			hosted.status = scoped.uiSession.sessionStatus
			scoped.effect(() => hosted.status.subscribe(tellStatusFans), 'dsh-chat-tree: 会话状态转发')
			tellStatusFans()
		})
	} catch (error) {
		warn('接 0.2 宿主的会话服务失败，按 0.1.5 的路走', error)
	}
	/**
	 * 切到某条会话：有 `uiWorkspace` 就走它，否则走 0.1.5 的 `sessions.open`。
	 * @param id - 会话 id
	 */
	const open = (id) => (hosted.open !== undefined ? hosted.open(id) : ctx.sessions.open(id))

	const api = {
		list: ctx.sessions.list,
		workspaces: ctx.workspaces.list,

		/**
		 * 每条会话的实时状态（0.2 宿主：`Map<id, {running, completionUnread}>`），
		 * 用来标"别的分支跑完了你还没看"。0.1.5 没有这张表（那时 `completed` 就在列表项上），
		 * 快照永远 undefined。做成转发器而不是直接放服务：Rail 拿到 api 时服务可能还没到。
		 */
		status: {
			getSnapshot: () => (hosted.status === undefined ? undefined : hosted.status.getSnapshot()),
			subscribe: (fn) => {
				statusFans.add(fn)
				return () => statusFans.delete(fn)
			},
		},

		/** 切到某条会话。 */
		open: (id) => attempt('打开会话失败', () => open(id)),

		/** 切到某条会话并滚到第 `turn` 轮。 */
		jump: (id, turn, seq) =>
			attempt('跳转失败', async () => {
				open(id)
				const binding = ctx.sessions.binding(id)
				if (binding && binding.session && typeof binding.session.loadThrough === 'function') {
					await binding.session.loadThrough(seq)
				}
				await new Promise((resolve) => setTimeout(resolve, 60))
				const row = document.querySelector(`[data-chat-turn="${turn}"]`)
				if (row && typeof row.scrollIntoView === 'function') row.scrollIntoView({ block: 'start', behavior: 'smooth' })
				// 末尾几轮都短时滚不到那么远（容器到底了），按位置算会判成更靠后的那轮 ——
				// 你点的是哪轮树上就亮哪轮，直到你自己再滚动（见 hooks.js 的钉住那段）。
				pinActiveTurn(turn)
			}),

		/**
		 * 在某一轮之后开岔路。**故意只有一行有效逻辑** —— 原生 fork 的两个缺陷
		 * 由 host 半在 `agent/created` 里接管，在这儿补会被原生分支按钮绕过。
		 *
		 * `born(id)` 在新会话建好、**切过去之前**跑：Rail 用它把"在拆出去那棵树的前缀上
		 * 开的分支"认领到那棵树。要赶在 open 之前 —— open 之后导轨立刻按新会话重画，
		 * 认领还没落地的那一帧画的就是旧树。
		 * @returns 新会话 id
		 */
		fork: (id, atSeq, born) =>
			attempt('开分支失败', async () => {
				const made = await ctx.sessions.fork({ sessionId: id, atSeq, increaseTitle: true })
				if (typeof born === 'function') await born(made)
				open(made)
				return made
			}),

		/**
		 * 在同一棵树里新开一条对话。
		 *
		 * ⚠️ 新会话归到哪个工作区看的是 `workspaceId`，**不是 cwd**：侧栏按
		 *    workspace.sessionIds 这张显式成员表分组，只传 cwd 建出来的会话谁都不认领，
		 *    于是掉进"未分组"。宿主自己的新建按钮就是 create({ workspaceId })。
		 *    查不到归属时才退回 cwd（至少工作目录是对的）。
		 *
		 * `born(id)` 同 fork：登记进当前这棵树 —— 这是"空节点底下能有好几条对话"的唯一来源。
		 * dsh 不给新建会话任何父子关系，不自己记就永远各自成树。补丁由 Rail 拼
		 * （`shapeOps.merge`，站在拆出去的树上时再加一条 `shapeOps.adopt`）。
		 * @returns 新会话 id
		 */
		fresh: (workspaceId, cwd, born) =>
			attempt('新建对话失败', async () => {
				const id = await ctx.sessions.create(workspaceId ? { workspaceId } : cwd ? { cwd } : {})
				if (typeof born === 'function') await born(id)
				open(id)
				return id
			}),

		/**
		 * 改树形关系。补丁一律由 `shapeOps` 造（见 tree.js），别自己拼字段。
		 * @param patch - `shapeOps.*` 的产物
		 * @returns 打完补丁的完整形状；失败是 undefined（调用方据此决定要不要回显）
		 */
		reshape: (patch) => attempt('改树形失败', () => postJson('/shape', patch)),
	}

	api.settings = settingsStore(ctx)

	// 自诊断钩子（window.__dshTree）是 Rail 每帧覆盖上去的，**它是个全局变量，
	// 没人替我们收**。插件被停用之后还留在那儿的话，敲出来的是停用那一刻的陈年数据，
	// 而看的人完全不知道它已经不更新了 —— 调试工具骗人比没有更糟。
	ctx.effect(() => () => {
		if (typeof window !== 'undefined') delete window.__dshTree
	}, 'dsh-chat-tree: 自诊断钩子')

	// ⚠️ 必须挂 `shell.overlay`，**不能**挂 `conversation.session.*`。
	//    宿主把 conversation.session.header.utilities 声明成 `scope: 'session'`
	//    （见 dsh-client-ui-conversation 的 slot 注册），切会话时整个 session 子树
	//    连同我们的组件一起卸载重挂：box / activeTurn / 缓存的树全部清零，outlines
	//    还要重新 fetch —— 导轨真的会"消失再出现"，机器越卡越明显。
	//    shell.overlay 是 `scope: 'root'`，由 AppFrame 常驻渲染，切会话只是 current 变了。
	ctx.effect(
		() =>
			ctx.slots.inject('shell.overlay', () =>
				ctx.slots.register({ name: 'shell.overlay', id: 'dsh-chat-tree', order: 90, inject: () => ({ api }) }, Rail),
			),
		'dsh-chat-tree: rail',
	)

	// 设置卡片。两代宿主挂的地方不同（DESIGN.md「设置：两代宿主」）：
	//   · 0.1.5：设置 → 插件 → 插件配置，一个 `<ul>` 按 namespace 派发
	//     `settings.plugin.item`。host 没注册 namespace 的话宿主根本不会派发这个 key，静默缺席。
	//   · 0.2（桌面版起）：那个插槽没了，宿主按 Config 在插件管理页自动出一张表单（能用，
	//     但没有色板和形状预览）。我们另外在设置导航里挂一节「对话树」（`settings.section`），
	//     还是原来那张卡。哪代宿主就走哪条：认服务，不认版本号。
	try {
		ctx.inject(['settingsScope'], (scoped) =>
			scoped.slots.inject('settings.plugin.item', () =>
				scoped.slots.register({ name: 'settings.plugin.item', key: SETTINGS_NS, inject: () => ({ store: api.settings }) }, SettingsCard),
			),
		)
		ctx.inject(['configForms'], (scoped) =>
			scoped.slots.inject('settings.section', () =>
				scoped.slots.register(
					{ name: 'settings.section', id: SETTINGS_NS, order: 60, label: () => '对话树', inject: () => ({ store: api.settings, section: true }) },
					SettingsCard,
				),
			),
		)
	} catch (error) {
		warn('设置卡片注册失败', error)
	}
}
