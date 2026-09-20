/**
 * dsh-tree host 半的入口。**只负责装配**，逻辑都在 `src/host/` 里。
 *
 * 干三件事：
 *   ① 听 `agent/created`，每条新分支一出生就接管（修掉原生 fork 的两个缺陷）→ src/host/adopt.js
 *   ② 注册设置 namespace → src/host/settings.js
 *   ③ 开三个路由 → outlines / shape / icon
 *
 * 【想改点什么，去哪个文件】
 *   日志怎么折成轮次 ······ src/host/outline.js
 *   撤回过的轮次 ·········· src/host/rewind.js（⚠️ 读旁车那一段的规矩不许放宽）
 *   哪几条对话算一棵树 ···· src/host/shape.js
 *   自定义节点图片 ········ src/host/icons.js
 *   外部引擎的记忆嫁接 ···· src/host/graft.js
 *   HTTP 那层壳 ··········· src/host/http.js
 *
 * 浏览器半在 `client.js`，那是 `node build.mjs` 从 `src/client/` 拼出来的**生成物**。
 * 背景和踩坑记录见 DESIGN.md。
 * @module dsh-tree
 */

import { adoptBranch, agentOf, forkTurnOf, inheritedPendingIds } from './src/host/adopt.js'
import { collect } from './src/host/collect.js'
import { graft } from './src/host/graft.js'
import { HttpError, raw, route } from './src/host/http.js'
import { ICON_KEEP, ICON_MAX, isIconId, putIcon, readIcon } from './src/host/icons.js'
import { lineage } from './src/host/lineage.js'
import { iconDir } from './src/host/paths.js'
import { SIDECAR_QUIET_MS, markRewound, rewindStateOf, statusProbe, turnHidden } from './src/host/rewind.js'
import { readShape, reshape } from './src/host/shape.js'
import { SETTINGS_NS, SETTINGS_SCHEMA } from './src/host/settings.js'

/** cordis 插件名。 */
export const name = 'tree'

/** 必须的宿主服务；少一个都会让 fiber 永远 pending，所以只要这三个。 */
export const inject = ['webServer', 'sessionPersistence', 'agents']

// 对外出口。测试和别人从这里取，别直接 import src/ 里的文件 ——
// 那些是内部结构，哪天拆了合了不该惊动外面。
export { SETTINGS_NS, SETTINGS_SCHEMA, graft, reshape }
export { foldOutline } from './src/host/outline.js'

/** 内部件出口，仅供离线测试（cordis 只读 name/inject/apply）。 */
export const __test = {
	adoptBranch, forkTurnOf, inheritedPendingIds, lineage,
	putIcon, readIcon, isIconId, iconDir, ICON_KEEP, ICON_MAX,
	statusProbe, rewindStateOf, markRewound, turnHidden, SIDECAR_QUIET_MS,
	collect,
}

/**
 * 装上监听、设置和三个路由。
 * @param ctx - 携带 webServer / sessionPersistence / agents 的 context
 */
export function apply(ctx) {
	ctx.effect(() => {
		// 开机报到：看不到这行就说明监听没装上
		ctx.logger?.info?.('dsh-tree: 已接管分支创建（agent/created）')
		return ctx.on('agent/created', (...args) => {
			const agent = agentOf(args)
			if (agent === undefined) {
				ctx.logger?.warn?.('dsh-tree: agent/created 的参数里没认出 agent，分支不会被接管')
				return
			}
			adoptBranch(ctx, agent)
		})
	}, 'dsh-tree: 接管新分支')

	// 设置 namespace。ctx.settings 是可选服务，所以走 ctx.inject 而不是顶层 inject
	// —— 写进顶层 inject 的话，没挂设置提供方的部署会让整个 fiber 永远 pending。
	try {
		ctx.inject(['settings'], (scoped) => {
			scoped.settings.register(SETTINGS_NS, SETTINGS_SCHEMA)
			scoped.logger?.info?.(`dsh-tree: 设置 namespace ${SETTINGS_NS} 已注册`)
		})
	} catch (error) {
		ctx.logger?.warn?.(`dsh-tree: 注册设置失败，前端会按默认半径画（${error}）`)
	}

	// 画树要的全部数据。形状跟大纲一起发：少一个往返，也不会出现
	// "大纲到了形状没到"那一帧的错分组。
	route(ctx, '/outlines', {
		GET: async ({ query }) => Object.assign(await collect(ctx, query.get('cwd') || ''), { shape: readShape() }),
	})

	route(ctx, '/shape', {
		GET: () => readShape(),
		POST: ({ body }) => reshape(body),
	})

	route(ctx, '/icon', {
		GET: ({ query }) => {
			const bytes = readIcon(query.get('id') || '')
			if (bytes === undefined) throw new HttpError(404, '没有这张图')
			// 短缓存而不是 immutable：每次取走都会刷新 mtime，靠这个把"正在用的"
			// 那几张顶在 pruneIcons 的保留名单里（见 icons.js 的 readIcon）
			return raw({ 'content-type': 'image/png', 'cache-control': 'private, max-age=300' }, bytes)
		},
		POST: ({ body }) => ({ id: putIcon(body.data) }),
	})
}
