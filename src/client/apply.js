/**
 * 装配：宿主 API 的转调层 + 往 slot 上挂组件。
 *
 * 这是浏览器半唯一碰宿主服务（`ctx.sessions` / `ctx.slots` / `ctx.workspaces`）的地方，
 * 别处一律只用下面这个 `api` 对象。插件自己不碰会话数据，全是转调。
 */
import { SETTINGS_NS } from './const.js'
import { warn, postJson } from './net.js'
import { shapeOps } from './tree.js'
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
	const api = {
		list: ctx.sessions.list,
		workspaces: ctx.workspaces.list,

		/** 切到某条会话。 */
		open: (id) => attempt('打开会话失败', () => ctx.sessions.open(id)),

		/** 切到某条会话并滚到第 `turn` 轮。 */
		jump: (id, turn, seq) =>
			attempt('跳转失败', async () => {
				ctx.sessions.open(id)
				const binding = ctx.sessions.binding(id)
				if (binding && binding.session && typeof binding.session.loadThrough === 'function') {
					await binding.session.loadThrough(seq)
				}
				await new Promise((resolve) => setTimeout(resolve, 60))
				const row = document.querySelector(`[data-chat-turn="${turn}"]`)
				if (row && typeof row.scrollIntoView === 'function') row.scrollIntoView({ block: 'start', behavior: 'smooth' })
			}),

		/**
		 * 在某一轮之后开岔路。**故意只有一行有效逻辑** —— 原生 fork 的两个缺陷
		 * 由 host 半在 `agent/created` 里接管，在这儿补会被原生分支按钮绕过。
		 */
		fork: (id, atSeq) => attempt('开分支失败', async () => ctx.sessions.open(await ctx.sessions.fork({ sessionId: id, atSeq, increaseTitle: true }))),

		/**
		 * 在同一棵树里新开一条对话。
		 *
		 * ⚠️ 新会话归到哪个工作区看的是 `workspaceId`，**不是 cwd**：侧栏按
		 *    workspace.sessionIds 这张显式成员表分组，只传 cwd 建出来的会话谁都不认领，
		 *    于是掉进"未分组"。宿主自己的新建按钮就是 create({ workspaceId })。
		 *    查不到归属时才退回 cwd（至少工作目录是对的）。
		 */
		fresh: (workspaceId, cwd, tree) =>
			attempt('新建对话失败', async () => {
				const id = await ctx.sessions.create(workspaceId ? { workspaceId } : cwd ? { cwd } : {})
				// 登记进当前这棵树 —— 这是"空节点底下能有好几条对话"的唯一来源。
				// dsh 不给新建会话任何父子关系，不自己记就永远各自成树。
				if (tree) await api.reshape(shapeOps.merge(id, tree))
				return ctx.sessions.open(id)
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
	}, 'dsh-tree: 自诊断钩子')

	// ⚠️ 必须挂 `shell.overlay`，**不能**挂 `conversation.session.*`。
	//    宿主把 conversation.session.header.utilities 声明成 `scope: 'session'`
	//    （见 dsh-client-ui-conversation 的 slot 注册），切会话时整个 session 子树
	//    连同我们的组件一起卸载重挂：box / activeTurn / 缓存的树全部清零，outlines
	//    还要重新 fetch —— 导轨真的会"消失再出现"，机器越卡越明显。
	//    shell.overlay 是 `scope: 'root'`，由 AppFrame 常驻渲染，切会话只是 current 变了。
	ctx.effect(
		() =>
			ctx.slots.inject('shell.overlay', () =>
				ctx.slots.register({ name: 'shell.overlay', id: 'dsh-tree', order: 90, inject: () => ({ api }) }, Rail),
			),
		'dsh-tree: rail',
	)

	// 设置卡片。host 没注册 namespace 的话宿主根本不会派发这个 key，静默缺席。
	try {
		ctx.inject(['settingsScope'], (scoped) =>
			scoped.slots.inject('settings.plugin.item', () =>
				scoped.slots.register({ name: 'settings.plugin.item', key: SETTINGS_NS, inject: () => ({ store: api.settings }) }, SettingsCard),
			),
		)
	} catch (error) {
		warn('设置卡片注册失败', error)
	}
}
