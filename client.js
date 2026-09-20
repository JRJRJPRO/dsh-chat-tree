/**
 * dsh-tree 浏览器半：贴着聊天区右缘的对话树。
 *
 * ⚠️ 这个文件是 `node build.mjs` 从 `src/client/*.js` 拼出来的，**别手改**：
 *    下一次构建就会把你的改动冲掉。要改去改 src/client/ 里对应的那个 part。
 *
 * 数据流：host 的 /outlines 给「每个分支的自有轮次」→ 扣掉归档 → 只留当前那棵树
 * → buildGraph 摊成节点算出 (column, depth) → 绝对定位画点和折线。
 *
 * 三条规矩（改之前先看 DESIGN.md §5）：
 *   · y = 树深度，不是行号 —— 同一岔路分出去的两条支线，第一个节点同高度。
 *   · x = 列，**与"当前在哪条分支"无关** —— 切分支只换颜色，图的形状不动。
 *   · 太远的节点省略掉（elide），最外两圈**鱼眼淡出**（越远越小越淡），不画「⋯」这类记号；
 *     半径设为 0 就退回"永远画全"。
 *
 * 高亮两条判据，别混：
 *   边框蓝 ⟺ 节点在当前会话的对话里；填充蓝 ⟺ 边框已蓝 且 轮次 == 现在滑到的那一轮。
 */

window.__ModuleLoader__.load({
	id: 'dsh-tree',
	factory: (require) => {
		var module = { exports: {} }
		var exports = module.exports
		Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

		// ===== const.js ================================================

		/**
		 * 全局常量：设置命名空间、滑杆档位、基准尺寸、配色。
		 *
		 * 这些东西**不属于任何一个功能**，谁都要用，所以单独一份。
		 * 改 `Z` 之前先看它自己的注释（那张表是 1.2 倍老基准取整出来的）。
		 */

		/** 设置命名空间。host 半用同名 namespace 注册 schema，两边必须一致。 */
		const SETTINGS_NS = 'dsh-tree'

		/** 省略半径。0 = 不省略；滑杆位置就是 [5..30, 0]。 */
		const RADIUS = { min: 5, max: 30, fallback: 12, off: 0 }

		/** 节点缩放，百分比。 */
		const SCALE = { min: 50, max: 250, step: 10, fallback: 100 }

		// hit = 命中区宽度，同时也是导轨右侧留给第 0 列的宽度（圆心在 hit/2 处）。
		// 以前 18 和 9 是散在渲染里的魔数，收进来才能跟着缩放一起动。
		/**
		 * 基准尺寸。滑杆上的 100% 指的就是这张表。
		 *
		 * 前八项（`scaleZ` 会缩的那些）是**老基准的 1.2 倍再取整** —— 原来要调到 120%
		 * 才顺眼，那就把 120% 挪成默认的 100%。取整是为了 1px 描边落在整像素上不发虚，
		 * 代价是各项相对老基准差 ±2% 以内。
		 * 老基准：row 20 / rowMin 7 / dot 9 / dotMin 6 / dotPad 5 / lane 14 / hit 18
		 */
		const Z = { row: 24, rowMin: 8, dot: 11, dotMin: 7, dotPad: 6, lane: 17, hit: 22, pad: 16, card: 270, gap: 20, restMs: 140, graceMs: 600, rewindMs: 2000 }

		/**
		 * 按百分比缩放尺寸。**只缩几何量** —— `restMs` 是时间、`card` 是文字卡片宽度，
		 * 跟着点一起放大只会挡住聊天区，所以都不动。
		 *
		 * 小例子（percent=150）：dot 11→16.5、lane 17→25.5、hit 22→33，
		 * 于是点变大、列变宽、命中区同比变宽，图整体等比例放大。
		 *
		 * @param percent - 百分比，100 = 原样
		 * @returns 新的尺寸表；`scaleZ(100)` 必须与 Z 逐字段相等
		 */
		function scaleZ(percent) {
			const k = Number.isFinite(percent) && percent > 0 ? percent / 100 : 1
			const out = Object.assign({}, Z)
			for (const key of ['row', 'rowMin', 'dot', 'dotMin', 'dotPad', 'lane', 'hit']) out[key] = Z[key] * k
			return out
		}

		const C = {
			line: '#30363d', lineActive: 'rgba(88,166,255,.6)',
			dim: '#6e7681', dimActive: 'rgba(88,166,255,.9)',
			muted: '#8b949e', text: '#c9d1d9',
			blue: '#58a6ff', orange: '#ffa657', bg: '#161b22',
		}

		// ===== runtime.js ==============================================

		/**
		 * 浏览器运行时：宿主注入的 react。
		 *
		 * bundle 里 `require` 是 `__ModuleLoader__` 交给 factory 的那个参数（见 build.mjs）；
		 * 在 node 里跑离线测试时它根本不存在，于是这里全是 undefined。
		 *
		 * 所以约定是：**纯函数模块一律不 import 这个文件**，只有画界面的模块才碰 `h`。
		 * 哪天某个 `*.js` 突然要用 react 了，先想想它是不是该拆成"算"和"画"两半。
		 */

		// `typeof` 不会因为 require 不存在而抛 ReferenceError —— 整个文件能同时在浏览器和
		// node 里被加载，靠的就是这一行。
		const loaded = typeof require === 'function'

		const react = loaded ? require('react') : undefined

		const reactDom = loaded ? require('react-dom') : undefined

		const h = loaded ? react.createElement : undefined

		const portal = loaded ? reactDom.createPortal : undefined

		// ===== net.js ==================================================

		/**
		 * 和 host 半说话的唯一出口：三个路由的地址、两个 fetch、一个 warn。
		 *
		 * 【为什么单独一份】以前三处各写一遍 `fetch(...).then(r => r.ok ? r.json() : reject)`，
		 * 三处的出错处理各不相同（一处吞掉、一处抛、一处 console.warn），加第四个路由时
		 * 还得挑一份抄。现在的约定只有一条：
		 *
		 *   **失败一律 throw**，要不要吞由调用方决定（画树的吞，上传图片的不吞）。
		 *
		 * host 那边的对应物是 `src/host/http.js`，两边的错误体格式都是 `{error: string}`。
		 */

		/** host 半三个路由的公共前缀。改路由只改这一行（host 的 `src/host/http.js` 里有同一个常量）。 */
		const API = '/plugins/dsh-tree'

		/**
		 * 统一的告警。前缀固定成 `[dsh-tree]`，好在一屏控制台里一眼捞出来是谁在叫。
		 * @param what - 人话，说清楚是哪件事没成
		 * @param error - 原始错误
		 */
		function warn(what, error) {
			console.warn(`[dsh-tree] ${what}`, error)
		}

		/**
		 * 把答复解出来；HTTP 不是 2xx 就抛。
		 *
		 * 错误信息优先取 body 里的 `error` 字段 —— host 半出错时回的就是 `{error: '…'}`，
		 * 直接把那句话摆给用户看，比 "400" 有用得多。
		 * @param response - fetch 的答复
		 * @returns 解析好的 body
		 */
		async function unwrap(response) {
			const body = await response.json().catch(() => undefined)
			if (!response.ok) throw new Error((body && body.error) || `HTTP ${response.status}`)
			return body
		}

		/**
		 * GET 一个 JSON。
		 * @param path - `API` 之后那一段，比如 `/outlines`
		 * @param params - 查询串，值会自己 encode
		 * @returns 解析好的 body
		 */
		async function getJson(path, params) {
			const query = new URLSearchParams(params || {}).toString()
			return unwrap(await fetch(`${API}${path}${query === '' ? '' : `?${query}`}`, { credentials: 'same-origin' }))
		}

		/**
		 * POST 一个 JSON。
		 * @param path - `API` 之后那一段，比如 `/shape`
		 * @param body - 会被 JSON.stringify 的东西
		 * @returns 解析好的 body
		 */
		async function postJson(path, body) {
			return unwrap(
				await fetch(`${API}${path}`, {
					method: 'POST',
					credentials: 'same-origin',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify(body),
				}),
			)
		}

		// ===== labels.js ===============================================

		/**
		 * 节点改名：存 localStorage。
		 *
		 * ⚠️ **这是个半成品**：换浏览器就没了，也进不了手机。真正的落点应该是 host 半的
		 * `shape.json` 旁边（那儿已经有 `$DSH_HOME/plugins/dsh-tree/`），接口保持成
		 * `readLabels()/writeLabel()` 两个函数就是为了那天只改这一个文件。
		 */

		const LS_KEY = 'dsh-tree.labels'

		/** @returns {Record<string,string>} */
		function readLabels() {
			try {
				return JSON.parse(localStorage.getItem(LS_KEY) || '{}') || {}
			} catch {
				return {}
			}
		}

		/**
		 * @param key - `<sessionId>:<turn>` 或 `root`
		 * @param value - 名字；空串 = 删除，回到默认
		 */
		function writeLabel(key, value) {
			const all = readLabels()
			if (value) all[key] = value
			else delete all[key]
			try {
				localStorage.setItem(LS_KEY, JSON.stringify(all))
			} catch {
				/* 存不下就算了 */
			}
		}

		// ===== tree.js =================================================

		/**
		 * 一棵树由哪些会话组成 —— 过滤、归组、以及节点上能做什么。
		 *
		 * 这里全是**纯函数**，不碰 react、不碰 fetch，离线测试直接 import 就能跑。
		 * 数据流：host 的 /outlines → visibleTree（扣归档）→ conversationOf（只留当前那棵树）
		 * → 交给 graph.js 摊成节点。
		 */

		// ===== 节点 key：全插件唯一的"一个节点"的写法 =====
		//
		// 一个节点 = (会话, 该会话自己的第几轮)，写成 `<sessionId>:<turn>`；树根那个空节点
		// 没有轮次，固定叫 `root`。localStorage 的改名表、shape.json 的 detached 清单、
		// buildGraph 的 nodeOf 索引用的都是它，所以**只准从这两个函数里出**，
		// 别再有第四处手拼 `${id}:${turn}`。

		/** 树根那个空节点的 key。 */
		const ROOT_KEY = 'root'

		/**
		 * 拼一个节点 key。
		 * @param sessionId - 会话 id
		 * @param turn - 会话内的轮次号
		 * @returns `<sessionId>:<turn>`
		 */
		function keyOf(sessionId, turn) {
			return `${sessionId}:${turn}`
		}

		// ===== 形状补丁：改树形只有这四种动作 =====
		//
		// host 的 `/shape` 收的是 `{session, group?, detach?}`，其中 `session` 这个字段
		// **在两种动作里含义不同**（合并时是会话 id，剪边时是节点 key）—— host 半刻意
		// 不解析它，好让 key 的格式将来能改。代价是调用方手拼补丁时很容易拼错，
		// 所以补丁一律由下面这张表造，Rail 里不许再出现字面量补丁。

		/** 改树形的四种动作。每一个都返回一个能直接喂给 `api.reshape` 的补丁。 */
		const shapeOps = {
			/**
			 * 把一棵树整个并进另一棵。
			 * @param treeRoot - 被合并那棵树的**树根会话 id**
			 * @param into - 目标树的编号
			 */
			merge: (treeRoot, into) => ({ session: treeRoot, group: into }),
			/**
			 * 把合进来的那棵树拆回独立的一棵。
			 * @param treeRoot - 它的树根会话 id
			 */
			unmerge: (treeRoot) => ({ session: treeRoot, group: '' }),
			/**
			 * 剪断一个节点和它父亲的连接，自成一棵树。
			 * @param nodeKey - 剪点的节点 key（必须是 `cutPointOf` 算出来的那个）
			 */
			cut: (nodeKey) => ({ session: nodeKey, detach: true }),
			/**
			 * 把剪出去的支线接回来。
			 * @param nodeKey - 剪缝所在的节点 key
			 */
			heal: (nodeKey) => ({ session: nodeKey, detach: false }),
		}

		/**
		 * 按可见集过滤，并把"父亲被归档"的孤儿重接到最近的可见祖先。
		 *
		 * 小例子：A ← B ← C，B 被归档 → 剩 {A, C}，C 沿原链上溯到 A → 重接成 A ← C。
		 * 树仍是一棵，而不是裂成两棵。
		 * @param all - host 返回的全部分支（含已归档）
		 * @param visible - 可见 sessionId 集合
		 */
		function visibleTree(all, visible) {
			const byId = indexOf(all)
			return all
				.filter((item) => visible.has(item.id))
				.map((item) => {
					let parent = item.parentId
					const guard = new Set()
					while (parent !== undefined && !visible.has(parent) && byId.has(parent) && !guard.has(parent)) {
						guard.add(parent)
						parent = byId.get(parent).parentId
					}
					return Object.assign({}, item, { parentId: parent !== undefined && visible.has(parent) ? parent : undefined })
				})
		}

		/**
		 * 某条会话所在那棵树的编号。
		 *
		 * 先顺着 parentId 爬到树根（被"分离"的会话在 visibleTree 里已经断了父链，
		 * 自然就是自己的根），再看这个根有没有被登记进别人的组。
		 * @param byId - id → 会话
		 * @param groupOf - 登记表 `{sessionId: groupId}`
		 * @param id - 会话 id
		 * @returns 树编号；查不到返回 undefined
		 */
		function treeOf(byId, groupOf, id) {
			let root
			const seen = new Set()
			for (let node = byId.get(id); node !== undefined && !seen.has(node.id); node = byId.get(node.parentId)) {
				seen.add(node.id)
				root = node
			}
			if (root === undefined) return undefined
			return (groupOf && groupOf[root.id]) || root.id
		}

		/**
		 * 把会话列表变成 `treeOf` 要的那张索引表。
		 *
		 * 单独抽出来是因为它在四个地方各建了一遍，其中两处还是直接写在渲染里的
		 * `new Map(all.map((item) => [item.id, item]))` —— 一眼看不出那是张什么表。
		 * @param sessions - 会话列表
		 * @returns id → 会话
		 */
		function indexOf(sessions) {
			return new Map((sessions || []).map((item) => [item.id, item]))
		}

		/**
		 * `treeOf` 的顺手版：直接给会话列表，不用自己建索引。
		 * 一次只问一个会话时用它；要连问很多个就自己 `indexOf` 一次再反复调 `treeOf`。
		 * @param sessions - 会话列表
		 * @param groupOf - 登记表
		 * @param id - 会话 id
		 * @returns 树编号
		 */
		function treeOfSession(sessions, groupOf, id) {
			return treeOf(indexOf(sessions), groupOf, id)
		}

		/**
		 * 本 cwd 下**别的**对话，供「合并」挑。
		 *
		 * 合并是整棵树对整棵树的，所以这里按树归并，一棵树只出现一次。
		 * 合并结果不需要指定"接到哪个节点"：两棵树的节点互不相同，合完就是
		 * 各自的链并排挂在同一个空根下 —— 谁合进谁，结果都是确定的。
		 * @param sessions - 本 cwd 下全部可见分支（已过 visibleTree）
		 * @param currentId - 当前会话
		 * @param groupOf - 登记表
		 * @returns `[{tree, root, title, turns, joined, blocked}]`，按创建时间排
		 */
		function mergeTargets(sessions, currentId, groupOf) {
			const byId = indexOf(sessions)
			const mine = treeOf(byId, groupOf, currentId)
			const own = (item) => (item.turns || []).filter((entry) => !entry.inherited).length
			const trees = new Map()
			// 一棵树只要有**任何一条分支**在跑就不能合并。整棵树是一起并过来的，
			// 只看被点中那条分支的话，"跑着的那条"照样会被顺手带进来。
			const running = new Set()
			for (const item of sessions) {
				const tree = treeOf(byId, groupOf, item.id)
				if (tree === undefined) continue
				if (item.running === true) running.add(tree)
			}
			for (const item of sessions) {
				const tree = treeOf(byId, groupOf, item.id)
				if (tree === undefined || tree === mine) continue
				const seat = trees.get(tree)
				if (seat === undefined) trees.set(tree, { tree, root: item.id, title: item.title, turns: own(item), at: item.createdAt || 0 })
				else {
					seat.turns += own(item)
					if ((item.createdAt || 0) < seat.at) Object.assign(seat, { root: item.id, title: item.title, at: item.createdAt || 0 })
				}
			}
			// 已经合进来的那些：登记表里指着我这棵树的，拆得回去
			const joined = []
			for (const [key, value] of Object.entries(groupOf || {})) {
				if (value !== mine || !byId.has(key)) continue
				const item = byId.get(key)
				joined.push({ tree: key, root: key, title: item.title, turns: own(item), at: item.createdAt || 0, joined: true })
			}
			const mineBusy = running.has(mine)
			return [...joined, ...trees.values()]
				.map((one) => Object.assign(one, { blocked: blockedWhy(mineBusy, running.has(one.tree)) }))
				.sort((left, right) => left.at - right.at)
		}

		/**
		 * 不能合并的话，原因是什么人话。
		 *
		 * 现在只有一种：有一头还在跑。**合并本身不危险**（只写 shape.json，不碰对话），
		 * 但正在跑的那棵树形状算不准 —— 它的撤回记录这会儿读不了（见 src/host/rewind.js），
		 * 刚合进来就画错更难解释。等跑完再合，一切都是确定的。
		 * @param mineBusy - 当前这棵树在跑
		 * @param theirsBusy - 对方那棵树在跑
		 * @returns 原因；能合并就是空串
		 */
		function blockedWhy(mineBusy, theirsBusy) {
			if (theirsBusy && mineBusy) return '两边都还在运行，跑完再合'
			if (theirsBusy) return '这条对话还在运行，跑完再合'
			if (mineBusy) return '当前对话还在运行，跑完再合'
			return ''
		}

		/**
		 * 当前该画出来的那棵树。
		 *
		 * 同一棵树 = 树根相同，**或者**树根被显式登记进了同一组。
		 *
		 * ⚠️ 别改成"整个 cwd 全要"。那样 a/b/c 三条互不相干的对话会挤在一个空节点下面，
		 *    实测 16 条对话把导轨撑到 326px。分组必须是**主动登记**的：
		 *    只有在空节点上按 ＋ 开出来的新对话才登记进当前这棵树（见 onFork）。
		 * @param sessions - 本 cwd 下全部可见分支（已过 visibleTree）
		 * @param currentId - 当前会话
		 * @param groupOf - 登记表
		 * @returns 这棵树里的分支
		 */
		function conversationOf(sessions, currentId, groupOf) {
			const byId = indexOf(sessions)
			const mine = treeOf(byId, groupOf, currentId)
			if (mine === undefined) return []
			return sessions.filter((item) => treeOf(byId, groupOf, item.id) === mine)
		}

		/**
		 * 某个会话属于哪个工作区。
		 *
		 * 侧栏的分组按 `workspace.sessionIds` 这张显式成员表算，不是按 cwd。
		 * @param state - `ctx.workspaces` 的快照 `{items, archivedSessionIds}`
		 * @param sessionId - 会话 id
		 * @returns workspaceId，查不到就 undefined
		 */
		function workspaceOf(state, sessionId) {
			const hit = ((state && state.items) || []).find((item) => (item.sessionIds || []).includes(sessionId))
			return hit === undefined ? undefined : hit.workspaceId
		}

		/**
		 * 在某个节点上点"分离"，实际该剪在哪。
		 *
		 * **不是剪在你点的那个节点上。** 一路往上走，只要父亲只有这一个孩子就继续往上，
		 * 直到撞见一个有多个孩子的父亲 —— 剪点就是它底下的那个节点。
		 *
		 * 小例子：1 → 2 → {3 → 5, 4 → 6}，在 6 上点分离。
		 *   6 的父亲 4 只有一个孩子 → 上移；4 的父亲 2 有两个孩子 → 停，剪点是 **4**。
		 *   新树 = 1-2-4-6，旧树 = 1-2-3-5。
		 * ⚠️ 剪在 6 上的话，4 会留在旧树里，两棵树看起来"没同步"（踩过）。
		 * @param node - 被点的节点
		 * @returns 该剪的节点；一路到根都没岔路就 undefined（这时也不该给按钮）
		 */
		function cutPointOf(node) {
			let at = node
			while (at.parent !== undefined && at.parent.children.length === 1) at = at.parent
			return at.parent === undefined ? undefined : at
		}

		/**
		 * 把存盘的 `detached` 翻成一组**节点 key**。
		 *
		 * 现在剪的是图上的边，所以记的是 `<会话>:<轮次>`。早先记的是纯会话 id
		 * （那一版只会剪"fork 出来的新会话"），遇到就翻成它第一个自有轮次的节点，
		 * 免得你之前拆过的东西悄悄失效。
		 * @param detached - 存盘的清单
		 * @param sessions - 本树的分支，用来给老格式找落点
		 * @returns 节点 key 集合
		 */
		function cutSet(detached, sessions) {
			const out = new Set()
			for (const item of detached || []) {
				if (typeof item !== 'string' || item.length === 0) continue
				if (item.includes(':')) {
					out.add(item)
					continue
				}
				const session = (sessions || []).find((one) => one.id === item)
				const first = session && (session.turns || []).find((entry) => !entry.inherited)
				if (first !== undefined) out.add(keyOf(item, first.turn))
			}
			return out
		}

		/**
		 * 在某个节点上按 ＋ 该干什么。
		 * **叶子节点不 fork**：后面什么都没有，复制一份只会多出一条内容重复的会话。
		 * **撤回掉的节点也不给**：见函数体。
		 * @param node - 被点的节点
		 * @returns 'none' 什么都不该做 | 'fresh' 开新对话 | 'open' 就在本会话接着问 | 'fork' 真的开岔路
		 */
		function branchAction(node) {
			// 撤回掉的轮次：claude 那边连锚点都一起删了（planRewind），
			// 从这儿开分支只会开出一条没有上下文的失忆分支，不如不给按钮。
			if (node.rewound === true) return 'none'
			// 根部那个空节点：底下已经有分支了才谈得上"再开一条"。
			// ⚠️ 刚建的对话只有这一个空节点，它自己就是"一条空对话"，
			//    再 fresh 一条只是多出一条一模一样的空会话（和叶子节点同一条道理）。
			if (node.entry === undefined) return node.children.length === 0 ? 'none' : 'fresh'
			return node.children.length === 0 ? 'open' : 'fork'
		}

		/**
		 * 点一个节点时该在哪个会话里跳过去。**尽量不换路径**：节点若在当前路径上，
		 * 就留在当前会话里滚过去（fork 抄日志时 seq 没变，同一个 seq 就是同一轮）。
		 *
		 * ⚠️ 无脑切到"节点所属的会话"会把整条高亮路径换掉（DESIGN.md §5）。
		 * @param node - 被点的节点
		 * @param currentId - 当前会话
		 * @returns 要跳进去的会话 id
		 */
		function jumpTarget(node, currentId) {
			return node.active ? currentId : node.session.id
		}

		/**
		 * 该填实心蓝的是不是这一个。判据只有两条：在当前路径上 + 轮次号对得上
		 * （轮次号在一条路径上不重复，所以最多亮一个）。
		 *
		 * ⚠️ 别再加 `node.session.id === current`：继承来的那几轮画的是**父会话的节点**，
		 *    加了它往上滑到继承段就一个点都不亮。
		 * @param node - 节点
		 * @param activeTurn - 当前滑到的轮次
		 * @returns 是否该填实心蓝
		 */
		function isFocusedNode(node, activeTurn) {
			return node.entry !== undefined && node.active === true && node.entry.turn === activeTurn
		}

		// ===== graph.js ================================================

		/**
		 * 把一棵对话树摊成带 (column, depth) 坐标的节点图。
		 *
		 * 整个插件最核心的一步，也是唯一一处"图的形状"的定义。改之前先看 DESIGN.md §5，
		 * 尤其是"x 与当前在哪条分支无关"这一条。
		 */

		/**
		 * 把一棵对话树摊成带 (column, depth) 坐标的节点图。一个节点 = (会话, 自有轮次)。
		 *
		 * 四步：① 连节点 ② 算 depth ③ 定高亮范围 ④ 算 column。
		 *
		 * 小例子（父有 1-2-3-4，子从第 2 轮岔出、自有 3'-4'）：
		 *     column  1        0
		 *     depth2           2
		 *     depth3   3'      3      ← 同高度，这就是"两个 3 该并排"
		 *     depth4   4'      4
		 *   切到子分支时只有颜色变，列不动。
		 * @param sessions - 本对话的分支（已过滤）
		 * @param currentId - 当前会话
		 * @returns {nodes, maxDepth, maxColumn}
		 */
		function buildGraph(sessions, currentId, cuts) {
			const byId = indexOf(sessions)
			const ownTurns = (session) => (session.turns || []).filter((entry) => !entry.inherited)

			// 父在前、子在后，保证接线时父节点已经建好
			const ordered = []
			const emitted = new Set()
			const emit = (session) => {
				if (emitted.has(session.id)) return
				if (session.parentId !== undefined && byId.has(session.parentId)) emit(byId.get(session.parentId))
				emitted.add(session.id)
				ordered.push(session)
			}
			for (const session of sessions) emit(session)

			const root = { key: ROOT_KEY, kind: 'empty', session: ordered[0], entry: undefined, parent: undefined, children: [], depth: 0 }
			let nodes = [root]
			const nodeOf = new Map()
			const attachOf = new Map() // 会话 → 它挂在哪个节点下

			// ① 连节点 + ② 算 depth
			for (const session of ordered) {
				let anchor = root
				if (session.parentId !== undefined && byId.has(session.parentId)) {
					const hit = nodeOf.get(keyOf(session.parentId, session.forkTurn))
					// forkTurn 落在父分支的继承段里（爷爷辈岔出来的）→ 退到父分支自己的挂载点
					anchor = hit || attachOf.get(session.parentId) || root
				}
				attachOf.set(session.id, anchor)

				// 撤回过的轮次不能当"下一轮的父亲"：它已经不在对话里了。
				// previous = 上一个画出来的节点（含撤回的），live = 上一个**还在对话里**的节点。
				// 于是撤回的那一段自己串成一条支线，撤回之后新发的轮次接回 live —— 也就是
				// 1-2-3-4（撤回）-5 画成 1-2-3-4 和 1-2-3-5 两条，而不是一条 1-2-3-4-5。
				let previous = anchor
				let live = anchor
				for (const entry of ownTurns(session)) {
					const rewound = entry.rewound === true
					// 答到一半被中止、然后撤回 —— 这一轮什么都没留下，节点直接不画。
					// key 仍指到最近还活着的祖先，免得有分支正好从这一轮岔出去、找不到挂载点。
					if (rewound && entry.done !== true) {
						nodeOf.set(keyOf(session.id, entry.turn), live)
						continue
					}
					const parent = rewound ? previous : live
					const node = {
						key: keyOf(session.id, entry.turn), kind: entry.compact ? 'compact' : 'normal',
						session, entry, rewound, parent, children: [], depth: parent.depth + 1,
					}
					parent.children.push(node)
					nodes.push(node)
					nodeOf.set(node.key, node)
					previous = node
					if (!rewound) live = node
				}
			}

			// ③ 剪边：被"分离"的节点断开与父亲的连接，自成一棵树。
			//
			// 判据是**图上的分叉**，不是会话边界 —— "会话自己的下一轮"和"fork 出来的新会话"
			// 在图上都只是某个节点的一个孩子，凭什么只准剪后者？
			//
			// 剪在 N：新树 = 根到 N 父亲那段路径（前缀，照抄）+ N 的整棵子树；
			//         旧树 = 原树扣掉 N 的子树。
			// 所以每个节点归属于"它头顶最近的那个被剪节点"，没有就归 root。
			const cutAt = cuts instanceof Set ? cuts : new Set(cuts || [])
			const ownerOf = new Map([[root, root]])
			for (const node of nodes) {
				if (node === root) continue
				// 标出剪缝本身：分离完新树里照抄了根到剪点父亲的前缀，所以剪缝**看得见**，
				// 接回去接到哪一目了然 —— 这个标记就是给那个「接回去」按钮用的
				node.cut = cutAt.has(node.key)
				ownerOf.set(node, node.cut ? node : ownerOf.get(node.parent))
			}

			// 站在哪棵上：取当前会话最深的那个节点；这条会话一轮都还没有就待在 root 那棵
			let here = root
			for (const node of nodes) if (node.session.id === currentId && node.depth > here.depth) here = node
			const mine = ownerOf.get(here) || root

			if (mine !== root || cutAt.size > 0) {
				const keep = new Set()
				for (const node of nodes) if (ownerOf.get(node) === mine) keep.add(node)
				// 前缀：从被剪点的父亲一路抄到根（只抄这条链，不带它身上挂的别的岔路）
				for (let node = mine.parent; node !== undefined; node = node.parent) keep.add(node)
				nodes = nodes.filter((node) => keep.has(node))
				for (const node of nodes) node.children = node.children.filter((kid) => keep.has(kid))
			}

			// ④ 高亮范围：给血缘链上每个会话记一个"轮次上限"，
			//    从当前会话往祖先走，上限取一路上岔路点的**最小值**。
			//    （A→B→C→D 时 D 只继承 C 的前 2 轮而 C 继承 B 的前 3 轮，
			//     那么 B 的第 3 轮不在 D 的对话里 —— 只看相邻一层会多算。）
			// ⚠️ 别改回"沿 node.parent 往上爬"，会跳过节点（DESIGN.md §5）。
			//    岔路点缺失时不设限，宁可多亮不要少亮。
			const limitOf = new Map()
			let running = Infinity
			for (let item = byId.get(currentId); item !== undefined && !limitOf.has(item.id); item = byId.get(item.parentId)) {
				limitOf.set(item.id, running) // 当前会话拿到 Infinity = 自有轮次全要
				if (item.forkTurn !== undefined) running = Math.min(running, item.forkTurn)
			}

			// ⑤ 算 column —— **刻意和 currentId 无关**，否则每切一次分支整张图就左右翻一遍。
			//    同一会话的延续继承父节点那一列（主干天然是直线），
			//    岔出去的子分支各领一个新列，按创建时间从右往左排。
			//    必须排在剪边**之后**：剪掉的子树不该再占着列宽。
			let nextColumn = 0
			root.column = 0
			const assign = (node) => {
				const kids = node.children.slice().sort((left, right) => (left.session.createdAt || 0) - (right.session.createdAt || 0))
				if (kids.length === 0) return
				// ⚠️ 撤回掉的那一轮虽然也是"本会话的延续"，但它是条废弃支线，
				//    让它占住主列的话，还活着的下一轮反而被挤到旁边去了。
				const same = (kid) => kid.session.id === node.session.id
				const preferred = kids.find((kid) => same(kid) && kid.rewound !== true) || kids.find(same) || kids[0]
				for (const kid of kids) {
					kid.column = kid === preferred ? node.column : (nextColumn += 1)
					assign(kid)
				}
			}
			assign(root) // 剪边后 root 必定还在（前缀一路抄到根）

			// 全局编号按时间排：每条分支各自从 1 数会撞车（父的 #3 和子的 #3 是两个节点）
			const timed = nodes.filter((node) => node.entry !== undefined).sort((left, right) => (left.entry.time || 0) - (right.entry.time || 0))
			timed.forEach((node, index) => {
				node.no = index + 1
			})

			let maxDepth = 0
			let maxColumn = 0
			for (const node of nodes) {
				// 根部那个空节点永远算在路径上
				// 撤回掉的轮次恒不在路径上——它就在当前会话里，limitOf 是 Infinity，
				// 不挡一下的话整条废弃支线会跟着亮成"当前路径"。
				node.active =
					node.entry === undefined
						? true
						: node.rewound !== true && node.entry.turn <= (limitOf.has(node.session.id) ? limitOf.get(node.session.id) : -1)
				// 能不能分离：一路往上只要有哪个祖先有多个孩子就能。
				// 父在前子在后遍历，所以这里可以直接吃父亲算好的结果 —— O(1)，
				// 不用点击时再回溯，也不会因为别处新增/分离而过期。
				node.canDetach = node.parent !== undefined && (node.parent.children.length > 1 || node.parent.canDetach === true)
				maxDepth = Math.max(maxDepth, node.depth)
				maxColumn = Math.max(maxColumn, node.column || 0)
			}
			return { nodes, maxDepth, maxColumn }
		}

		// ===== elide.js ================================================

		/**
		 * 省略：只画离你正在看的那一轮若干步以内的节点，最外两圈鱼眼淡出。
		 */

		/**
		 * 鱼眼淡出：最外 `rings` 圈越画越小、越画越淡，到边界正好消失。
		 *
		 * 这是给"省略"收尾用的。以前是在剪断处画一个「⋯」，两个毛病：`⋯` 是**文字**，
		 * 和整张图的几何语言（点＋线）不是一套，糊在一堆小圆点里很扎眼；而且它只说"这里断了"，
		 * 不说断得有多软。现在换成不硬切 —— 树自己淡下去，边界处没有任何新元素。
		 *
		 * ⚠️ 淡出圈吃的是**半径自己的最外层**，不是额外往外多画两圈。
		 *    「12 步」说的就是最远画到 12 步：第 10 步以内正常，第 11 / 12 步淡出。
		 *    反过来（radius + rings）会让设置说谎，还凭空多占两行 —— 导轨本来就在压行高。
		 *
		 * 代价说清楚：一棵正好长到第 12 步就到头的树，末端也会淡，看着像"后面还有"。
		 *    换成"只有真被砍了才淡"的话，同一行里会出现一个亮叶子挨着一个淡节点，更怪。
		 *    按距离淡是鱼眼的本义（远＝不重要），不是"外面还有东西"的信号。
		 */
		const FADE = { rings: 2, scale: [1, 0.74, 0.52], alpha: [1, 0.66, 0.4] }

		/**
		 * 第 level 圈画多小、多淡。
		 * @param level - 0 = 正常，往外每圈 +1；超出 rings 的一律按最外圈算
		 * @returns `{scale, alpha}`，两者都 ∈ (0, 1]
		 */
		function fisheye(level) {
			const at = Math.min(Math.max(Math.trunc(level) || 0, 0), FADE.rings)
			return { scale: FADE.scale[at], alpha: FADE.alpha[at] }
		}

		/**
		 * 按「离你正在看的那一轮多远」把太远的节点省略掉。
		 *
		 * 距离是树上的无向步数：父节点 1 步，父节点的另一个孩子 2 步（上一步再下一步）。
		 * 藏掉的行不留空档 —— depth 重新压实成连续的 row，否则省略了也腾不出地方。
		 *
		 * 小例子（线性 1..20，站在 10，半径 5）：
		 *   留下 5..15；其中 7..13 正常画，6 和 14 缩到 74%、淡到 66%，5 和 15 缩到 52%、淡到 40%。
		 *
		 * @param nodes - buildGraph 出来的全部节点
		 * @param anchor - 从哪个节点量距离
		 * @param radius - 保留半径；<=0 表示不省略
		 * @returns {shown, rowOf, dimOf, rows, hidden}
		 */
		function elide(nodes, anchor, radius) {
			const shown = new Set()
			// 每个留下来的节点在第几圈淡出。0 = 正常画
			const dimOf = new Map()
			if (!(radius > 0) || anchor === undefined) {
				for (const node of nodes) {
					shown.add(node)
					dimOf.set(node, 0)
				}
			} else {
				const step = new Map([[anchor, 0]])
				const queue = [anchor]
				for (let head = 0; head < queue.length; head += 1) {
					const node = queue[head]
					const walked = step.get(node)
					if (walked >= radius) continue
					for (const near of [node.parent].concat(node.children)) {
						if (near === undefined || step.has(near)) continue
						step.set(near, walked + 1)
						queue.push(near)
					}
				}
				for (const [node, walked] of step) {
					shown.add(node)
					// 再套一层 min(walked, …)：半径比 rings 还小时（配置文件里手改出来的），
					// 不加这层连基准点自己都会被淡掉 —— 你正看着的那一轮必须永远是实的。
					dimOf.set(node, Math.min(walked, Math.max(0, FADE.rings - (radius - walked))))
				}
			}

			const depths = [...new Set([...shown].map((node) => node.depth))].sort((left, right) => left - right)
			const rowOf = new Map(depths.map((depth, index) => [depth, index]))
			return { shown, rowOf, dimOf, rows: depths.length, hidden: nodes.length - shown.size }
		}

		/**
		 * 量距离的基准点：优先用正在看的那一轮，没有就退到当前路径最深的那个节点。
		 * @param nodes - 全部节点
		 * @param activeTurn - 现在滑到第几轮
		 */
		function anchorNode(nodes, activeTurn) {
			const focused = nodes.find((node) => isFocusedNode(node, activeTurn))
			if (focused !== undefined) return focused
			let deepest
			for (const node of nodes) if (node.active === true && (deepest === undefined || node.depth > deepest.depth)) deepest = node
			return deepest || nodes[0]
		}

		// ===== shapes.js ===============================================

		/**
		 * 节点长什么样：形状、颜色、描边、填充。
		 *
		 * 一个角色（普通 / 当前路径 / 压缩 / 空）对应一组颜色和形状，设置里改的就是这些。
		 * ⚠️ 形状归 kind/active，状态归 active/focused，两者**正交** —— 别把状态塞回 kind 里。
		 */

		/** 自定义形状的两个前缀：`char:★` = 画那个字；`img:<id>` = 画上传的那张图。 */
		const CUSTOM = 'char:'
		const PICTURE = 'img:'

		/** 上传的图落在 host 半，这是取它的地址。 */
		const ICON_URL = `${API}/icon`

		/**
		 * 上传的图统一缩成 96×96 再存。
		 *
		 * 为什么是 96：点最大 `Z.dot(11) × 缩放 250% = 27.5px`，悬停再放大 1.4 倍 ≈ 38.5px，
		 * 二倍屏上 77 个物理像素 —— 96 够用且有余，再大纯属白存。
		 * （基准尺寸上调前这里是 64。改 Z.dot 时记得回来看一眼。）
		 */
		const ICON_EDGE = 96

		/**
		 * 预设形状。三种画法：
		 *   · `radius` + `spin` —— border-radius 画方/圆，`spin` 再转 45° 成菱形
		 *   · `poly` —— 单位框里的顶点，交给一个 `<svg><polygon>` 画。描边和填充和别的形状
		 *     **同一套**（同样的 ink / fill / 线宽），所以质感一致
		 *   · 表外的 `char:<字>` / `img:<id>` —— 见 shapeSpec
		 * 表里**不写中文名**：选择器上直接画出形状本身，不需要"圆形""菱形"这种字。
		 *
		 * ⚠️ 三角别用 `clip-path` 剪。剪出来的东西**斜边上没有描边**（border 被一起剪掉），
		 *    box-shadow 也整圈剪没 —— 只能整块填实，摆在一排空心圆里一眼就看得出格格不入。
		 *
		 * `grow` = 画多大。三角按**面积**配齐：底 1 高 0.87 的三角占单位框 0.435，
		 * 而正圆占 π/4 ≈ 0.785，所以要放大 √(0.785/0.435) ≈ 1.34 倍看着才一样大。
		 */
		const SHAPES = [
			{ value: 'circle', radius: '50%', spin: false },
			{ value: 'rounded', radius: '30%', spin: false },
			{ value: 'square', radius: 'px', spin: false },
			{ value: 'diamond', radius: 'px', spin: true },
			{ value: 'triangle', radius: 'px', spin: false, grow: 1.34, poly: [[0, 0.1], [1, 0.1], [0.5, 0.97]] },
		]

		/**
		 * 多边形顶点换算成 SVG 的 `points`。
		 *
		 * ⚠️ 要往里缩 `inset`（= 半条描边）。SVG 的描边是**骑在**路径上的，顶点落在画布
		 *    边缘的话外侧那半条会被切掉，三个角看着厚薄不均。
		 * @param points - 单位框（0..1）里的顶点
		 * @param edge - 画布边长（像素）
		 * @param inset - 四周留多少
		 * @returns `"x,y x,y …"`
		 */
		function polyPoints(points, edge, inset) {
			const span = Math.max(0, edge - inset * 2)
			return points.map(([x, y]) => `${(inset + x * span).toFixed(2)},${(inset + y * span).toFixed(2)}`).join(' ')
		}

		/**
		 * 一个形状画出来占多大。`grow` 是为了让不同形状的**面积**看齐，不是边长。
		 * @param shape - shapeSpec 的结果
		 * @param size - 点的直径
		 * @returns 边长（像素）
		 */
		function shapeBox(shape, size) {
			return size * (shape.grow === undefined ? 1 : shape.grow)
		}

		/**
		 * 上传的图的地址。
		 * @param id - 图片 id（内容哈希）
		 * @returns URL
		 */
		function iconUrl(id) {
			return `${ICON_URL}?id=${encodeURIComponent(id)}`
		}

		/**
		 * 四个角色各自的默认颜色与形状。设置里改的就是这张表。
		 *
		 * 空节点默认跟当前路径同色：它本来就永远在当前路径上，今天画出来就是这个蓝的，
		 * 不该因为"多了个设置项"就悄悄换个样子。虚线边是它自己的记号，不跟着配置走。
		 */
		const THEME = {
			normalColor: C.dim, normalShape: 'circle',
			currentColor: C.blue, currentShape: 'circle',
			compactColor: C.orange, compactShape: 'triangle',
			emptyColor: C.blue, emptyShape: 'circle',
		}

		// ===== 角色表：一个节点长什么样，全从这里查 =====
		//
		// 四个角色，**不是**四种 kind：`normal` 这一种 kind 站在当前路径上时算 `current`。
		// 形状归 kind/active（角色），状态归 focused（实心填充 + 外发光），两者**正交** ——
		// 以前是 `kind = focused ? 'current' : node.kind`，压缩节点一滑到就变回蓝圆点，
		// "一眼看出是压缩节点"恰好在最该看清的时候失效。别再把状态塞回 kind 里。
		//
		// 加第五个角色（比如"出错的那一轮"）要动的地方：这张表 + THEME 的两个默认值 +
		// settings-model.js 的 ROWS + host 的 SETTINGS_SCHEMA。画的那三个函数一行都不用改。

		/**
		 * 角色表。
		 *   · `color` / `shape` —— 到主题里查哪两个字段（字段名必须和 host 的 schema 对得上）
		 *   · `ink`  —— 描边色的不透明度；1 = 原色
		 *   · `fill` —— 填充色的不透明度；`'bg'` = 不垫色，直接用背景色
		 *   · `own`  —— 自带颜色，不随"在不在当前路径上"变（靠颜色表明**自己是什么**，
		 *               而不是表明**自己在哪**）
		 *   · `dashed` —— 虚线边，"还没说话"的记号；不跟着配置走
		 */
		const ROLES = {
			normal: { color: 'normalColor', shape: 'normalShape', ink: 1, fill: 'bg' },
			current: { color: 'currentColor', shape: 'currentShape', ink: 0.9, fill: 0.18 },
			compact: { color: 'compactColor', shape: 'compactShape', ink: 1, fill: 0.3, own: true },
			empty: { color: 'emptyColor', shape: 'emptyShape', ink: 1, fill: 0.15, own: true, dashed: true, plus: 2 },
		}

		/**
		 * 一个节点此刻算哪个角色。
		 * @param kind - 节点形态（normal / compact / empty）
		 * @param active - 在当前路径上
		 * @returns ROLES 的键
		 */
		function roleOf(kind, active) {
			if (ROLES[kind] !== undefined && ROLES[kind].own === true) return kind
			return active ? 'current' : 'normal'
		}

		/**
		 * 这个角色画成虚线边吗。
		 * @param kind - 节点形态
		 * @returns 是否虚线
		 */
		function dashedOf(kind) {
			return ROLES[kind] !== undefined && ROLES[kind].dashed === true
		}

		/**
		 * 一个点实际画多大。
		 *
		 * 空节点比别人大 2px —— 它是个占位，和普通节点一样大就看不出"这儿还能开一条"。
		 * ⚠️ **两拨人要用同一个答案**：真正画点的 Rail，和算连线该在哪儿停的 `reachFor`。
		 *    以前各写一遍 `kind === 'empty' ? dotSize + 2 : dotSize`，改一处线就戳进点里。
		 * @param kind - 节点形态
		 * @param dotSize - 基准直径
		 * @param grow - 鱼眼缩放，缺省 1
		 * @returns 直径（像素）
		 */
		function dotSizeOf(kind, dotSize, grow) {
			const role = ROLES[kind]
			const plus = role !== undefined && role.plus !== undefined ? role.plus : 0
			return (dotSize + plus) * (grow === undefined ? 1 : grow)
		}

		/**
		 * 上色：alpha 为 1 时原样返回。
		 *
		 * ⚠️ 别偷懒写成 `fade(hex, 1)` —— 那会把 `#6e7681` 变成 `rgba(110,118,129,1)`，
		 *    颜色一样但字符串不一样，快照类断言会整片红。
		 * @param hex - `#rrggbb`
		 * @param alpha - 0..1
		 */
		function tint(hex, alpha) {
			return alpha === 1 ? hex : fade(hex, alpha)
		}

		/**
		 * 给颜色加透明度。主题色是 `#rrggbb`，但路径垫色 / 外发光 / 连线都要半透明，
		 * 所以统一在这里转成 rgba —— 用户换了主色，这些派生色自动跟着换。
		 * @param hex - `#rrggbb`
		 * @param alpha - 0..1
		 * @returns rgba() 字符串；认不出来就原样返回
		 */
		function fade(hex, alpha) {
			const matched = /^#([0-9a-fA-F]{6})$/.exec(String(hex || ''))
			if (matched === null) return hex
			const value = Number.parseInt(matched[1], 16)
			return `rgba(${(value >> 16) & 255},${(value >> 8) & 255},${value & 255},${alpha})`
		}

		/**
		 * 一个形状值解析成画法。认不得的一律退回圆形 —— 存进设置的是任意字符串，
		 * 手改配置文件写错了不该把树画成空白。
		 * @param want - 预设 id，或 `char:<字>`
		 * @returns `{value, radius, spin, clip?, glyph?}`
		 */
		function shapeSpec(want) {
			const text = typeof want === 'string' ? want : ''
			if (text.startsWith(CUSTOM)) {
				const glyph = text.slice(CUSTOM.length).trim()
				if (glyph !== '' && [...glyph].length <= 2) return { value: text, radius: 'px', spin: false, glyph }
			}
			if (text.startsWith(PICTURE)) {
				// id 是内容哈希，样子固定。不肯宽松认是因为它要拼进 URL —— 认宽了等于
				// 把一个用户可控的字符串塞进 src，越界读文件就是这么来的
				const id = text.slice(PICTURE.length)
				if (/^[0-9a-f]{32}$/.test(id)) return { value: text, radius: 'px', spin: false, image: id }
			}
			return SHAPES.find((one) => one.value === text) || SHAPES[0]
		}

		/**
		 * 设置里那颗小预览：按形状值画出形状本身。和树上的点共用 shapeSpec，
		 * 所以选择器上看到的就是节点将来长的样子 —— 不需要"圆形""菱形"这些字。
		 * @param want - 形状值
		 * @param color - 用什么颜色画
		 * @param size - 边长
		 * @param dashed - 画成虚线（空节点那一行用）
		 * @returns 一个 <span>
		 */
		function preview(want, color, size, dashed) {
			const spec = shapeSpec(want)
			const skin = { ink: color, fill: fade(color, 0.3), accent: color }
			const drawn = spec.poly !== undefined || spec.glyph !== undefined || spec.image !== undefined
			return h('span', {
				style: {
					position: 'relative', display: 'inline-block', boxSizing: 'border-box',
					width: `${size}px`, height: `${size}px`,
					borderRadius: spec.radius === 'px' ? '2px' : spec.radius,
					borderWidth: drawn ? '0px' : '1.5px', borderStyle: dashed === true ? 'dashed' : 'solid', borderColor: color,
					background: spec.image !== undefined ? `center center / contain no-repeat url("${iconUrl(spec.image)}")` : drawn ? 'none' : skin.fill,
					color, fontSize: `${size}px`, lineHeight: `${size}px`, textAlign: 'center',
					transform: spec.spin ? 'rotate(45deg) scale(.78)' : 'none',
				},
			}, dotInside(spec, size, skin, 1.5, dashed))
		}

		/**
		 * 某个节点该用什么形状。
		 *
		 * ⚠️ 四个角色**各有各的形状**：压缩看 compactShape，树根空节点看 emptyShape，
		 *    在当前路径上看 currentShape，其余看 normalShape。以前这里把 current 和 normal
		 *    合成一个，于是设置里"当前路径形状"怎么改都没反应 —— John 报的"改了好像
		 *    没反应"就是这条。
		 * @param kind - 节点形态（normal / compact / empty）
		 * @param active - 在当前路径上
		 * @param theme - 主题
		 * @returns 画法
		 */
		function shapeOf(kind, active, theme) {
			const role = ROLES[roleOf(kind, active)]
			return shapeSpec((theme || THEME)[role.shape])
		}

		/**
		 * 一个节点此刻用什么描边色、什么填充色。
		 *
		 * 单独抽出来是因为**有两拨人要用同一套颜色**：方框类的 `dotStyle`，和多边形
		 * 那个 `<svg><polygon>`。各算各的必然对不齐，最后就是三角和圆看着不是一套东西。
		 * @param kind - normal / compact / empty
		 * @param active - 在当前路径上
		 * @param focused - 正看着这一轮
		 * @param theme - 颜色与形状，缺省用 THEME
		 * @returns `{accent, ink, fill}`
		 */
		function inkOf(kind, active, focused, theme) {
			const skin = theme || THEME
			const role = ROLES[roleOf(kind, active)]
			const color = skin[role.color]
			// 外发光色 = **这个 kind 在当前路径上时**用的颜色。普通节点借当前路径的蓝，
			// 压缩和空节点用自己的色（它们本来就不随路径变）。
			const accent = skin[ROLES[roleOf(kind, true)].color]
			return {
				accent,
				ink: focused ? accent : tint(color, role.ink),
				fill: focused ? accent : role.fill === 'bg' ? C.bg : tint(color, role.fill),
			}
		}

		/**
		 * 一个节点长什么样。
		 *
		 * ⚠️ 所有分支必须返回**相同的 key 集合**，边框只用 longhand，不许写 `border` 简写。
		 *    React 会把"上一帧有、这一帧没有"的属性置空，简写和 longhand 混用时
		 *    切回普通态会掉成白边框 —— 滑过一个点白一个（DESIGN.md §5）。
		 *
		 * ⚠️ 形状归 `kind`/`active`，状态归 `active`/`focused`，两者**正交**。
		 *    以前是 `kind = focused ? 'current' : node.kind`，压缩节点一滑到就变回蓝圆点 ——
		 *    "一眼看出是压缩节点"恰好在最该看清的时候失效。别再把状态塞回 kind 里。
		 * 描边和外发光都按直径同比例走，否则点放大后边框细得看不见。
		 * @param kind - normal / compact / empty
		 * @param active - 在当前路径上
		 * @param hover - 鼠标停在它上面
		 * @param size - 直径
		 * @param focused - 正看着这一轮
		 * @param theme - 颜色与形状，缺省用 THEME
		 * @param alpha - 鱼眼透明度，缺省 1；乘在原有透明度上，不是覆盖
		 * @returns 内联样式
		 */
		function dotStyle(kind, active, hover, size, focused, theme, alpha) {
			const k = size / Z.dot
			const shape = shapeOf(kind, active, theme)
			const { accent, ink, fill } = inkOf(kind, active, focused, theme)
			// 多边形 / 字 / 图片都不靠这个 <span> 的 border+background 成形：
			// 方框会在图形外面套一圈，所以这三类一律把方框关掉，由里面的内容自己画。
			// 外发光也得换 —— box-shadow 画的是**方框**的光晕，套在三角外面就是个方的光。
			const drawn = shape.poly !== undefined || shape.glyph !== undefined || shape.image !== undefined
			return {
				width: `${size}px`, height: `${size}px`,
				borderRadius: shape.radius === 'px' ? `${1.5 * k}px` : shape.radius,
				borderWidth: drawn ? '0px' : `${1.5 * k}px`,
				borderStyle: dashedOf(kind) ? 'dashed' : 'solid',
				borderColor: ink,
				background: shape.image !== undefined ? `center center / contain no-repeat url("${iconUrl(shape.image)}")` : drawn ? 'none' : fill,
				color: ink,
				fontSize: `${size}px`,
				lineHeight: `${size}px`,
				textAlign: 'center',
				boxShadow: focused && !drawn ? `0 0 0 ${3 * k}px ${fade(accent, 0.22)}` : 'none',
				filter: focused && drawn ? `drop-shadow(0 0 ${2 * k}px ${fade(accent, 0.75)})` : 'none',
				boxSizing: 'border-box',
				// 鱼眼的淡是**乘**上去的：路径外的点本来就只有 0.4，再乘一次才是"更远更淡"。
				// 直接赋值的话最外圈反而比路径外的普通点更亮，越远越显眼，正好反了。
				opacity: (focused || active ? 1 : 0.4) * (alpha === undefined ? 1 : alpha),
				transition: 'transform .12s ease, opacity .12s ease',
				transform: `${hover ? 'scale(1.4)' : 'scale(1)'}${shape.spin ? ' rotate(45deg)' : ''}`,
			}
		}

		/**
		 * 方框画不出来的那部分内容：多边形交给 `<svg><polygon>`，自定义字就是那个字。
		 * 圆/方/菱/图片靠 `dotStyle` 的 border+background 就够了，这里返回 null。
		 *
		 * ⚠️ polygon 的描边宽度、描边色、填充色和别的形状**用同一套**（`inkOf` + `1.5k`），
		 *    不然一排空心圆里混一个实心三角，一眼就看得出是两拨人画的。
		 * @param shape - shapeSpec 的结果
		 * @param size - 点的直径
		 * @param skin - `inkOf` 的结果
		 * @param stroke - 描边宽度，和同尺寸下方框类形状的边框一样粗
		 * @returns 子节点，或 null
		 */
		function dotInside(shape, size, skin, stroke, dashed) {
			if (shape.glyph !== undefined) return shape.glyph
			if (shape.poly === undefined) return null
			const edge = shapeBox(shape, size)
			return h(
				'svg',
				{
					width: edge, height: edge, 'aria-hidden': true,
					// 比 <span> 大一圈，所以绝对定位居中，别把自己挤进方框里
					style: { position: 'absolute', left: '50%', top: '50%', marginLeft: `${-edge / 2}px`, marginTop: `${-edge / 2}px`, overflow: 'visible', pointerEvents: 'none' },
				},
				h('polygon', polyProps(shape, size, skin, stroke, dashed)),
			)
		}

		/**
		 * `<polygon>` 上挂的那堆属性。
		 *
		 * 单独抽出来是为了**能测**：描边色、填充色、线宽必须和方框类形状同源，
		 * 藏在渲染函数里的话，哪天有人把 `fill` 改成 `skin.ink`（= 整块填实）
		 * 一条断言都不会响 —— 而那正是 John 说的"质感明显和其他图案不一样"。
		 * @param shape - shapeSpec 的结果，要有 `poly`
		 * @param size - 点的直径
		 * @param skin - `inkOf` 的结果
		 * @param stroke - 描边宽度
		 * @param dashed - 画成虚线（空节点的记号）
		 * @returns polygon 的属性
		 */
		function polyProps(shape, size, skin, stroke, dashed) {
			return {
				points: polyPoints(shape.poly, shapeBox(shape, size), stroke / 2),
				fill: skin.fill,
				stroke: skin.ink,
				strokeWidth: stroke,
				strokeLinejoin: 'round',
				// 虚线是空节点的记号。方框类靠 borderStyle: dashed，多边形只能自己描
				strokeDasharray: dashed === true ? `${(stroke * 2).toFixed(2)} ${(stroke * 1.5).toFixed(2)}` : 'none',
			}
		}

		// ===== geometry.js =============================================

		/**
		 * 导轨上的几何：连线怎么拐、线在哪儿停、鼠标压着哪个点。
		 *
		 * 全是纯函数，坐标系一律是"导轨内"（左上角为原点）。
		 */

		/**
		 * 导轨的一整套尺寸：行高、列宽、点多大、(列,行) 怎么换算成像素。
		 *
		 * 从渲染里抽出来是因为它**全是纯算术**，却是最容易出"差半个像素"那类毛病的地方；
		 * 留在组件里的话，只能靠人眼在浏览器里比对。
		 *
		 * 小例子（聊天区高 600、缩放 100%、12 行、最宽 2 列）：
		 *   available = 600 - 16×2 = 568；rowH = min(24, 568/12) = 24；树高 288；
		 *   railWidth = 22 + 2×17 = 56；第 0 列的圆心 x = 56 - 11 = 45。
		 *
		 * @param box - 聊天区的位置和大小
		 * @param scale - 节点缩放百分比
		 * @param rows - 省略之后实际要画几行
		 * @param maxColumn - 图上最宽到第几列（**不是可见列** —— 省略随滚动变，导轨宽度不该跟着跳）
		 * @returns 尺寸表 + 两个换算函数
		 */
		function railLayout(box, scale, rows, maxColumn) {
			const z = scaleZ(scale)
			const available = box.height - z.pad * 2
			// 放不下就压行高（下限 rowMin）。鱼眼不额外占行：淡出的那两圈本来就在半径里面，
			// 顶底不再留"放省略号"的空行。
			const rowH = Math.max(z.rowMin, Math.min(z.row, available / Math.max(1, rows)))
			const railWidth = z.hit + maxColumn * z.lane
			return {
				z,
				available,
				rowH,
				treeHeight: rows * rowH,
				railWidth,
				dotSize: Math.max(z.dotMin, Math.min(z.dot, rowH - z.dotPad)),
				/** 第 column 列的圆心 x。列号从右往左长，所以是减。 */
				xOf: (column) => railWidth - z.hit / 2 - column * z.lane,
				/** 第 row 行的圆心 y。 */
				yOf: (row) => row * rowH + rowH / 2,
			}
		}

		/**
		 * 一个节点在竖直方向要让开多少。
		 *
		 * ⚠️ 线必须在节点**边缘**停住，不能画到圆心：节点填充是半透明的（路径上垫一层淡色），
		 *    画到圆心的话线会从圆环 / 菱形正中间透出来，很难看。
		 *    菱形是正方形转 45°，半高是半边长的 √2 倍，得多让一点。
		 * @param kind - 节点形态
		 * @param active - 在当前路径上（形状可能和路径外不同）
		 * @param dotSize - 当前点的直径
		 * @param theme - 主题（形状会影响让开量）
		 * @param grow - 鱼眼缩放，缺省 1；淡出圈的点画得小，线就得多连一截过去
		 * @returns 像素，恒大于 0
		 */
		function reachFor(kind, active, dotSize, theme, grow) {
			const size = dotSizeOf(kind, dotSize, grow)
			const shape = shapeOf(kind, active, theme)
			// 多边形按它实际画多大让（三角放大了 1.34 倍），不然尖角会戳到线上
			return (shape.spin ? size * 0.71 : shapeBox(shape, size) / 2) + 1
		}

		/**
		 * 一条折线拆成几段矩形（导轨内坐标系）。
		 *
		 * 走法是**先横后竖**：先在父节点那一行横向挪到自己那一列，再往下走。
		 * ⚠️ 反过来（先竖后横）的话，从节点 2 岔到节点 4 的竖线会一路压过节点 3 再拐弯，
		 *    看着像"经过 3 之后转个弯到 4"。
		 *
		 * 两端各让开 gapFrom / gapTo；折角处不让（那里没有节点）。
		 *
		 * ⚠️ 线是 1px 宽的方块，**要把它的中心压在节点中心上**，所以 left/top 各减半个线宽。
		 *    不减的话线占的是 [x, x+1)，中心在 x+0.5，而点的中心在 x —— 整条线整体偏右
		 *    半个像素，线性的树看着就是"一段线一个点"左右不对称（John 报的）。
		 * @param xFrom - 父节点圆心 x
		 * @param xTo - 子节点圆心 x
		 * @param yFrom - 父节点圆心 y
		 * @param yTo - 子节点圆心 y
		 * @param gapFrom - 父这端让开多少
		 * @param gapTo - 子这端让开多少
		 * @returns 若干段 `{tag, left, top, width, height}`，长度为 0 的段不返回
		 */
		function segments(xFrom, xTo, yFrom, yTo, gapFrom, gapTo) {
			const out = []
			const half = 0.5 // 线宽的一半：把线的中心对齐到节点中心
			const bent = xTo !== xFrom
			if (bent) {
				const near = xFrom + (xTo > xFrom ? gapFrom : -gapFrom)
				// 横段往折角那头多伸半个线宽，好和竖段的笔画严丝合缝（否则拐角缺个小口）
				const width = Math.abs(near - xTo)
				if (width > 0) out.push({ tag: 'hz', left: Math.min(xTo, near) - half, top: yFrom - half, width: width + 2 * half, height: 1 })
			}
			const down = yTo > yFrom
			const top = yFrom + (bent ? 0 : down ? gapFrom : -gapFrom)
			const bottom = yTo + (down ? -gapTo : gapTo)
			const height = Math.abs(bottom - top)
			if (height > 0) out.push({ tag: 'v', left: xTo - half, top: Math.min(top, bottom), width: 1, height })
			return out
		}

		/**
		 * 连线的绘制顺序。
		 *
		 * ⚠️ 蓝线必须最后画。同一个父节点的几个孩子，横段都贴在父节点那一行，越远的
		 *    孩子横段越长 —— 短的会整段盖住长的右半截。谁后画谁赢（都没设 z-index，
		 *    DOM 顺序说了算），所以灰的先来，蓝的压在最上面。
		 *    别改成给蓝线加 z-index：那会连节点圆点一起盖住。
		 * @param nodes - 图上全部节点
		 * @returns 有父节点的那些，灰的在前蓝的在后
		 */
		function edgeOrder(nodes) {
			const linked = nodes.filter((node) => node.parent !== undefined)
			return [...linked.filter((node) => !node.active), ...linked.filter((node) => node.active)]
		}

		/**
		 * hover intent 的决策：鼠标现在压着 `at`，卡片当前停在 `hover`，该怎么办？
		 *
		 * ⚠️ 这是 ＋ 够不够得着的**唯一**关键。卡片开着时换目标一律返回 'rest'
		 *    （= 等鼠标停下来），绝不能图省事返回 'now'：从点走到卡片上的 ＋ 要横穿
		 *    左边每一列（列距 17px < 命中区 22px），沿途每个点都会抢走卡片，
		 *    ＋ 就永远够不着。改成 'now' 等于退回挂 onMouseEnter 的老做法。
		 * @param hover - 当前停着的点，null = 还没开卡片
		 * @param at - 鼠标正压着的点，undefined = 没压着
		 * @returns 'keep' 不动 / 'now' 立刻换 / 'rest' 等停下来再换
		 */
		function hoverNext(hover, at) {
			if (at === undefined || at === hover) return 'keep'
			return hover === null ? 'now' : 'rest'
		}

		/**
		 * 鼠标正压着哪个点（导轨内坐标系）。
		 *
		 * 命中区是每个点周围的一个矩形；重叠时取圆心最近的那个。
		 * @param seats - 可见的点，形如 {x, y, node}
		 * @param x - 鼠标横坐标
		 * @param y - 鼠标纵坐标
		 * @param w - 命中区宽
		 * @param hgt - 命中区高
		 * @returns 压着的点，没压着就 undefined
		 */
		function nodeAt(seats, x, y, w, hgt) {
			let best
			for (const seat of seats) {
				const dx = Math.abs(seat.x - x)
				const dy = Math.abs(seat.y - y)
				if (dx > w / 2 || dy > hgt / 2) continue
				const far = dx * dx + dy * dy
				if (best === undefined || far < best.far) best = { far, node: seat.node }
			}
			return best === undefined ? undefined : best.node
		}

		// ===== icon-upload.js ==========================================

		/**
		 * 自定义节点图片：浏览器里先光栅化成 PNG，再交给 host 存。
		 *
		 * ⚠️ 绝不能把用户原文件直接传上去（SVG 里能写脚本）—— 过一遍 canvas 就只剩像素了。
		 */

		/** 上传前的原图最大多少字节。太大的图光解码就能卡一下。 */
		const ICON_SOURCE_MAX = 4 * 1024 * 1024

		/**
		 * 把任意图片文件**光栅化**成 `ICON_EDGE` 见方的 PNG。
		 *
		 * 为什么不原样存用户的文件：
		 *   · SVG 里可以写脚本。把它原样挂到同源地址上再当图片引，等于给自己开了个后门 ——
		 *     过一遍 canvas 就只剩像素了。
		 *   · 节点最大也就 32px 左右，存张 4000×3000 的原图纯属拿内存换零收益。
		 * 尺寸**不限制，自动换算**：等比缩放塞进方框（contain），空出来的地方透明补齐，
		 * 所以竖图横图都不会被拉变形。
		 * @param file - 用户选的文件
		 * @param edge - 目标边长
		 * @returns PNG 的 base64（不带 `data:` 前缀）
		 */
		function shrink(file, edge) {
			return new Promise((resolve, reject) => {
				if (file.size > ICON_SOURCE_MAX) {
					reject(new Error(`图太大了（${Math.round(file.size / 1024 / 1024)}MB），换张 ${ICON_SOURCE_MAX / 1024 / 1024}MB 以内的`))
					return
				}
				const source = URL.createObjectURL(file)
				const image = new Image()
				image.onload = () => {
					URL.revokeObjectURL(source)
					try {
						const canvas = document.createElement('canvas')
						canvas.width = edge
						canvas.height = edge
						const pen = canvas.getContext('2d')
						const zoom = Math.min(edge / image.width, edge / image.height)
						const w = Math.max(1, Math.round(image.width * zoom))
						const hgt = Math.max(1, Math.round(image.height * zoom))
						pen.drawImage(image, Math.round((edge - w) / 2), Math.round((edge - hgt) / 2), w, hgt)
						resolve(canvas.toDataURL('image/png').slice('data:image/png;base64,'.length))
					} catch (error) {
						reject(error)
					}
				}
				image.onerror = () => {
					URL.revokeObjectURL(source)
					reject(new Error('这个文件浏览器读不出来，换个 png / jpg / svg 试试'))
				}
				image.src = source
			})
		}

		/**
		 * 把一张图传给 host 半存起来。
		 * @param file - 用户选的文件
		 * @returns 形状值 `img:<id>`
		 */
		async function upload(file) {
			const data = await shrink(file, ICON_EDGE)
			// 这里**故意不吞异常**：传图是用户按下去的动作，失败了要在卡片上说一句
			// （SettingsCard 的 write() 会把 message 显示出来），而不是悄悄没反应。
			const body = await postJson('/icon', { data })
			if (body === undefined || typeof body.id !== 'string') throw new Error('host 没给回图片 id')
			return PICTURE + body.id
		}

		// ===== diagnose.js =============================================

		/**
		 * 自诊断：在浏览器控制台敲 `__dshTree()`，把这一帧的真实状态倒出来。
		 *
		 * 【为什么值得留着】"某些点莫名变白""这条分支怎么不见了"这类症状，光看代码猜不出来，
		 * 而每猜错一轮都要重启一次 dsh。把当时的真实数据一次性打出来，通常一眼就能定位。
		 *
		 * 【为什么单独一个文件】它是**调试设施**，不是功能。塞在 Rail 里的时候，
		 * 一坨中文字段名夹在渲染逻辑中间，读渲染的人得先跳过它。
		 */

		/**
		 * 挂上 `window.__dshTree`。每帧覆盖一次，所以敲出来的永远是最新那一帧。
		 *
		 * ⚠️ 这里存的是**闭包**不是快照：敲下去那一刻才求值，拿到的是最后一次渲染的数据。
		 * @param facts - 这一帧的各路状态，见下面的字段名
		 */
		function installDiagnostics(facts) {
			if (typeof window === 'undefined') return
			window.__dshTree = () => {
				const { current, cwd, activeTurn, radiusText, view, scale, tuned, settings, picked, nodes, archived, sessionCount } = facts
				return {
					当前会话: current,
					工作目录: cwd,
					滑到第几轮: activeTurn,
					省略半径: radiusText,
					省掉几个: view.hidden,
					淡出几个: [...view.shown].filter((node) => view.dimOf.get(node) > 0).length,
					缩放: `${scale}%`,
					设置: `半径=${tuned.visibleRadius} 缩放=${tuned.nodeScale} 可写=${settings.writable} 状态=${settings.status} 模式=${settings.mode}`,
					分支: picked.map(
						(item) =>
							`${shortId(item.id)} ← ${item.parentId ? shortId(item.parentId) : '根'} 岔路点=${item.forkTurn} 自有轮=${(item.turns || [])
								.filter((entry) => !entry.inherited)
								.map((entry) => entry.turn)
								.join(',')}`,
					),
					节点: nodes
						.filter((node) => node.entry !== undefined)
						.map((node) => `#${node.no} ${shortId(node.session.id)}轮${node.entry.turn} ${node.active ? '蓝' : '白'} 列${node.column}深${node.depth}`),
					归档: [...archived].map(shortId),
					列表里有几条会话: sessionCount,
				}
			}
		}

		/**
		 * 会话 id 只取中间六位 —— 全写出来一行放不下三条分支，而这六位在一个 cwd 里够认人了。
		 * @param id - 会话 id
		 */
		function shortId(id) {
			return String(id).slice(8, 14)
		}

		// ===== hooks.js ================================================

		/**
		 * 副作用钩子：量聊天区、跟踪当前轮次、订阅宿主快照、拉大纲。
		 *
		 * 这里是插件与"宿主 DOM / 宿主服务"的全部接触面。宿主改了版式，先来这儿找。
		 */

		/**
		 * 藏掉宿主自带的轮次导轨（否则两条叠一起谁也看不清）。
		 * 类名带构建哈希，所以从它自己注入的 <style data-plugin-css> 里正则出前缀。
		 * @returns 卸载函数
		 */
		function hideNativeRail() {
			try {
				const source = document.querySelector('style[data-plugin-css*="TurnNavigator.module.css"]')
				if (source === null) return () => {}
				const matched = /\.([A-Za-z0-9]+)_slot\b/.exec(source.textContent || '')
				if (matched === null) return () => {}
				const tag = document.createElement('style')
				tag.dataset.dshTree = 'hide-native-rail'
				tag.textContent = `.${matched[1]}_slot{display:none !important}`
				document.head.appendChild(tag)
				return () => tag.remove()
			} catch {
				return () => {}
			}
		}

		/** 量聊天区滚动容器；量不到退回视口右缘。 */
		function useChatBox() {
			const [box, setBox] = react.useState(undefined)
			react.useEffect(() => {
				let raf = 0
				let observed
				let observer
				let goneAt = 0
				let graceTimer = 0
				const measure = () => {
					const el = document.querySelector('[data-conversation-scroll]')
					// ⚠️ 量不到**先别清空**。切会话时宿主会把聊天区卸了重挂，中间有几帧找不到容器；
					//    一清空导轨就掉到另一套几何、rowH 重算，整棵树跳一下再跳回来。
					//    但"一直找不到"是另一回事（用户开了设置页/全局面板），那时候得真的收起来。
					//    用 graceMs 区分这两种：短暂消失＝切会话，持续消失＝不在会话界面。
					if (el === null) {
						if (goneAt === 0) goneAt = Date.now()
						if (Date.now() - goneAt >= Z.graceMs) return setBox(undefined)
						clearTimeout(graceTimer)
						graceTimer = setTimeout(measure, Z.graceMs)
						return
					}
					goneAt = 0
					// ⚠️ 容器被换过就改盯新的：ResizeObserver 绑的是元素实例，旧元素卸载后它再也不会响，
					//    聊天区再变宽变高就只能等 800ms 的轮询兜底。
					if (observer !== undefined && el !== observed) {
						if (observed !== undefined) observer.unobserve(observed)
						observer.observe(el)
						observed = el
					}
					const rect = el.getBoundingClientRect()
					setBox((prev) =>
						prev && Math.abs(prev.top - rect.top) < 1 && Math.abs(prev.height - rect.height) < 1 && Math.abs(prev.right - rect.right) < 1
							? prev
							: { top: rect.top, height: rect.height, right: rect.right },
					)
				}
				const schedule = () => {
					cancelAnimationFrame(raf)
					raf = requestAnimationFrame(measure)
				}
				observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(schedule)
				measure()
				window.addEventListener('resize', schedule)
				const timer = setInterval(measure, 800)
				return () => {
					cancelAnimationFrame(raf)
					clearTimeout(graceTimer)
					if (observer) observer.disconnect()
					window.removeEventListener('resize', schedule)
					clearInterval(timer)
				}
			}, [])
			return box
		}

		/**
		 * 跟踪「你现在看到的是第几轮」。
		 * 取聊天区顶部往下 25% 的探针线，找最后一个顶边还在线以上的聊天行。
		 * scroll 不冒泡，所以在 document 上用捕获阶段监听。
		 */
		function useActiveTurn() {
			const [turn, setTurn] = react.useState(undefined)
			react.useEffect(() => {
				let raf = 0
				const measure = () => {
					const el = document.querySelector('[data-conversation-scroll]')
					if (el === null) return
					const box = el.getBoundingClientRect()
					const probe = box.top + Math.min(140, box.height * 0.25)
					let best
					for (const row of el.querySelectorAll('[data-chat-turn]')) {
						const value = Number(row.getAttribute('data-chat-turn'))
						if (!Number.isFinite(value)) continue
						const rect = row.getBoundingClientRect()
						if (rect.bottom < box.top) continue
						if (rect.top <= probe) best = value
						else {
							if (best === undefined) best = value
							break
						}
					}
					// ⚠️ 没量到任何一轮就保留上一次。切会话中间有几帧聊天行还没挂上，
					//    清成 undefined 的话 anchorNode 会退到“当前路径最深的点”，
					//    elide 的可视窗口跳到末端再跳回来 —— 又是一闪。
					if (best === undefined) return
					setTurn((previous) => (previous === best ? previous : best))
				}
				const schedule = () => {
					cancelAnimationFrame(raf)
					raf = requestAnimationFrame(measure)
				}
				measure()
				document.addEventListener('scroll', schedule, true)
				const timer = setInterval(measure, 400)
				return () => {
					cancelAnimationFrame(raf)
					document.removeEventListener('scroll', schedule, true)
					clearInterval(timer)
				}
			}, [])
			return turn
		}

		/** 订阅宿主 ObservableSnapshot。 */
		function useObservable(observable) {
			const valid = !!observable && typeof observable.getSnapshot === 'function' && typeof observable.subscribe === 'function'
			const [snapshot, setSnapshot] = react.useState(() => (valid ? observable.getSnapshot() : undefined))
			react.useEffect(() => {
				if (!valid) return undefined
				const update = () => setSnapshot(observable.getSnapshot())
				update()
				return observable.subscribe(update)
			}, [observable, valid])
			return snapshot
		}

		/**
		 * 拉大纲；拉取期间保留旧数据，图不会闪空。
		 *
		 * ⚠️ `nonce` 不能省。重拉的条件里只有 cwd 和会话列表，而**改树形（分组/分离）
		 *    不会动这两样** —— 没有它的话，分离要等到下一次发消息或切会话才顺带刷出来，
		 *    用起来就是"点了没反应，过几秒突然全生效"。
		 * @param cwd - 工作目录
		 * @param listState - 会话列表快照
		 * @param nonce - 手动催一次重拉
		 * @returns 大纲，还没到就是 undefined
		 */
		function useOutlines(cwd, listState, nonce) {
			const [data, setData] = react.useState(undefined)
			const [again, setAgain] = react.useState(0)
			const stamp = listState
				? `${(listState.ids || []).length}:${listState.current}:${(listState.ids || []).map((id) => (listState.byId[id] || {}).updatedAt).join(',')}`
				: ''
			react.useEffect(() => {
				if (!cwd) return undefined
				let alive = true
				const timer = setTimeout(() => {
					getJson('/outlines', { cwd })
						.then((body) => alive && setData(body))
						.catch((error) => warn('拉大纲失败，树停在上一帧', error))
				}, 120)
				return () => {
					alive = false
					clearTimeout(timer)
				}
			}, [cwd, stamp, nonce, again])

			// host 说"这条会话正在跑，这次没敢读它的撤回记录"（读旁车会打断那一轮，见 src/host/rewind.js）。
			// 撤回不写 dsh 日志，会话列表一点动静都没有，**不自己回来拉就永远等不到**：
			// 撤回完紧接着发的那一轮会一直画着撤回前的形状。跑完自然就读到了。
			react.useEffect(() => {
				const wait = rewindRetryDelay(data)
				if (wait === 0) return undefined
				const timer = setTimeout(() => setAgain((value) => value + 1), wait)
				return () => clearTimeout(timer)
			}, [data])
			return data
		}

		/**
		 * 这次答复里有没有"撤回记录没读到"的会话。
		 * @param outlines - /outlines 的响应体
		 * @returns 是否还欠着
		 */
		function isRewindPending(outlines) {
			return ((outlines && outlines.sessions) || []).some((item) => item.rewindPending === true)
		}

		/**
		 * 隔多久回来再拉一次。
		 *
		 * 抽出来是为了能测：藏在 useEffect 里的话，改成"从不重拉"一条断言都不会响，
		 * 而症状（撤回完那一轮的形状一直不更正）要人肉点半天才看得出来。
		 * @param outlines - /outlines 的响应体
		 * @returns 毫秒；0 = 不用再拉
		 */
		function rewindRetryDelay(outlines) {
			return isRewindPending(outlines) ? Z.rewindMs : 0
		}

		// ===== settings-model.js =======================================

		/**
		 * 设置项总表 + 设置 store。
		 *
		 * **加一项设置只动三个地方**：host 的 SETTINGS_SCHEMA、这里的 FIELDS、以及（外观类的）ROWS。
		 * 卡片和 store 都是按表渲染的，不用改。
		 */

		/** 省略半径的档位：5..30，最后一格是"不省略"。 */
		const STEPS = Array.from({ length: RADIUS.max - RADIUS.min + 1 }, (_, i) => RADIUS.min + i).concat([RADIUS.off])

		/** 缩放的档位：50%..250%，每档 10。 */
		const SCALES = Array.from({ length: (SCALE.max - SCALE.min) / SCALE.step + 1 }, (_, i) => SCALE.min + i * SCALE.step)

		/**
		 * 一档的人话。
		 * @param step - 档位值
		 */
		function stepText(step) {
			return step === RADIUS.off ? '不省略' : `${step} 步`
		}

		/**
		 * 缩放档位的人话。
		 * @param step - 百分比
		 */
		function scaleText(step) {
			return `${step}%`
		}

		const isHex = (value) => typeof value === 'string' && /^#[0-9a-fA-F]{6}$/.test(value)

		const isShape = (value) => typeof value === 'string' && shapeSpec(value).value === value

		/**
		 * 卡片上的外观分组：一个角色一行，**左边颜色右边形状**，不再一项占一行。
		 * 颜色和形状是同一个角色的两面，拆成两行既浪费竖直空间又要来回对照。
		 */
		const ROWS = [
			{ key: 'normal', label: '普通节点', hint: '不在当前路径上的节点。' },
			{ key: 'current', label: '当前路径', hint: '当前这条路径的节点、连线，以及"正看着这一轮"的实心填充，都跟着这个颜色走。' },
			{ key: 'compact', label: '压缩节点', hint: '被 /compact 压缩掉的那一轮。四个角色的形状各自独立，设成一样就分不出来了。' },
			{
				key: 'empty',
				label: '空节点',
				hint: '树根那个"新对话"占位，在它上面按 ＋ 可以在同一棵树里再开一条。边框永远是虚线 —— 那是"还没说话"的记号，不跟着配置走。',
			},
			// `key` 就是 shapes.js 里的角色名，所以改哪两个设置字段、要不要画虚线，
			// 一律从 ROLES 查，不在这儿重写一遍
		].map((row) =>
			Object.assign({}, row, {
				color: ROLES[row.key].color,
				shape: ROLES[row.key].shape,
				dashed: ROLES[row.key].dashed === true,
			}),
		)

		/**
		 * 设置项总表。卡片按表渲染、store 按表取值 —— 加一项只改这张表和 host 的 schema。
		 * `kind` 决定用哪种控件；`accept` 决定什么样的值算数（host 那边存的是任意 JSON）。
		 */
		const FIELDS = [
			{ field: 'visibleRadius', kind: 'range', label: '显示范围', steps: STEPS, text: stepText, fallback: RADIUS.fallback, accept: Number.isFinite,
				hint: '离你正在看的那一轮多少步以内的节点才画出来。父节点算 1 步，父节点的另一个孩子算 2 步。' },
			{ field: 'nodeScale', kind: 'range', label: '节点大小', steps: SCALES, text: scaleText, fallback: SCALE.fallback, accept: Number.isFinite,
				hint: '点、连线、列间距、命中区一起等比例缩放。树太高时行距仍会被自动压扁。' },
			// 外观那八项是**算出来的**：每个角色两项（颜色 + 形状），字段名从 ROLES 查。
			// 以前这八行是手写的，于是同一个字段名在 ROLES / FIELDS / ROWS 里各写一遍，
			// 加第五个角色要改三处还不报错 —— 漏掉哪一处都是"设置里改了没反应"。
			...ROWS.flatMap((row) => [
				{ field: row.color, kind: 'color', label: `${row.label}颜色`, fallback: THEME[row.color], accept: isHex, hint: '' },
				{ field: row.shape, kind: 'shape', label: `${row.label}形状`, fallback: THEME[row.shape], accept: isShape, hint: '' },
			]),
		]

		/**
		 * 半径的唯一来源。host 注册了 namespace 就跟着设置走，没有就用默认值。
		 * 快照形状和宿主的 ObservableSnapshot 一样，好直接喂给 useObservable。
		 *
		 * ⚠️ 别在 `writable === false` 时把 `set` 删掉：第一帧几乎必然是
		 *    `status:'loading'` + `writable:false`，删了就再也加不回来，滑杆永远是灰的。
		 *    可写与否交给快照逐帧说了算，别做成一次性的。
		 * @param ctx - 浏览器根 context
		 */
		function settingsStore(ctx) {
			let scope
			const blank = () => {
				const values = {}
				const user = {}
				for (const spec of FIELDS) {
					values[spec.field] = spec.fallback
					user[spec.field] = false
				}
				return { values, user, writable: false, status: undefined, mode: undefined }
			}
			let state = blank()
			const listeners = new Set()
			const need = () => (scope === undefined ? Promise.reject(new Error('设置服务还没就绪')) : undefined)
			const store = {
				getSnapshot: () => state,
				subscribe: (fn) => {
					listeners.add(fn)
					return () => listeners.delete(fn)
				},
				set: (field, next) => need() || scope.set(field, next),
				reset: (field) => need() || scope.unset(field),
			}
			const same = (a, b) =>
				a.writable === b.writable && a.status === b.status && a.mode === b.mode &&
				FIELDS.every((spec) => a.values[spec.field] === b.values[spec.field] && a.user[spec.field] === b.user[spec.field])
			try {
				ctx.inject(['settingsScope'], (scoped) => {
					scope = scoped.settingsScope.bind({ namespace: SETTINGS_NS })
					const pull = () => {
						const snapshot = scope.getSnapshot() || {}
						const from = snapshot.value !== null && typeof snapshot.value === 'object' ? snapshot.value : {}
						const raw = snapshot.user !== null && typeof snapshot.user === 'object' ? snapshot.user : {}
						const next = blank()
						next.writable = snapshot.writable === true
						next.status = snapshot.status
						next.mode = snapshot.mode
						for (const spec of FIELDS) {
							if (spec.accept(from[spec.field])) next.values[spec.field] = from[spec.field]
							next.user[spec.field] = spec.field in raw
						}
						if (same(next, state)) return
						state = next
						for (const fn of listeners) fn()
					}
					pull()
					// 订阅要挂在 fiber 的 effect 上 —— ctx.inject 的回调返回值不当 disposer 用
					scoped.effect(() => scope.subscribe(pull), 'dsh-tree: 设置订阅')
				})
			} catch (error) {
				warn('设置服务不可用，按默认值画', error)
			}
			return store
		}

		// ===== ui-detail.js ============================================

		/**
		 * 悬停详情卡，以及挂在它上面的「合并」清单。
		 */

		/** 就地重命名输入框。 */
		function InlineEdit(props) {
			const [draft, setDraft] = react.useState(props.initial)
			return h('input', {
				style: { flex: '1 1 auto', minWidth: 0, background: '#0d1117', color: '#fff', border: `1px solid ${C.blue}`, borderRadius: '4px', padding: '1px 5px', font: 'inherit', outline: 'none' },
				value: draft, autoFocus: true,
				onClick: (event) => event.stopPropagation(),
				onChange: (event) => setDraft(event.target.value),
				onBlur: () => props.onDone(draft.trim()),
				onKeyDown: (event) => {
					if (event.key === 'Enter') props.onDone(draft.trim())
					if (event.key === 'Escape') props.onDone(props.initial)
				},
			})
		}

		/**
		 * 详情条：鼠标停在某个点上时从旁边平移淡入。
		 *
		 * 向左滑出（导轨贴着聊天区右缘，右边没有空间）。常驻挂载，否则过渡播不出来。
		 * 自带 onMouseEnter 取消关闭计时，不然鼠标还没走到 ＋ 就消失了。
		 */
		function Detail(props) {
			const { node, y, railWidth, labels, hold, release } = props
			const [editing, setEditing] = react.useState(false)
			const [merging, setMerging] = react.useState(false)
			react.useEffect(() => {
				setEditing(false)
				setMerging(false)
			}, [node])

			const shown = node !== null
			const isEmpty = shown && node.kind === 'empty'
			const key = !shown ? '' : isEmpty ? 'root' : node.key
			const fallback = !shown ? '' : isEmpty ? node.session.title || '未命名对话' : node.entry.prompt || `第 ${node.entry.turn} 轮`
			const text = labels[key] || fallback

			const button = (glyph, title, action) =>
				h('span', {
					key: glyph, title,
					style: { flex: '0 0 auto', cursor: 'pointer', color: C.muted, padding: '0 4px', fontSize: '13px' },
					onClick: (event) => { event.stopPropagation(); action() },
				}, glyph)

			return h(
				'div',
				{
					style: {
						position: 'absolute', right: `${railWidth + 4}px`, top: `${y}px`,
						transform: `translateY(-50%) translateX(${shown ? 0 : 8}px)`,
						opacity: shown ? 1 : 0,
						transition: 'opacity .14s ease, transform .14s ease',
						pointerEvents: shown ? 'auto' : 'none',
						width: `${Z.card}px`, maxWidth: '60vw',
						display: 'flex', alignItems: 'center', gap: '6px',
						background: C.bg, border: `1px solid ${C.line}`, borderRadius: '7px',
						boxShadow: '0 6px 20px rgba(0,0,0,.45)', padding: '6px 8px',
						font: '12.5px/1.45 -apple-system,"Segoe UI","PingFang SC",sans-serif', color: C.text,
					},
					onMouseEnter: hold,
					onMouseLeave: release,
					onDoubleClick: () => setEditing(true),
				},
				shown
					? [
							h('span', {
								key: 'n',
								title: isEmpty ? '' : `会话内第 ${node.entry.turn} 轮`,
								style: { flex: '0 0 auto', color: C.muted, fontSize: '11px', fontVariantNumeric: 'tabular-nums' },
							}, isEmpty ? '对话' : `#${node.no}`),
							// 撤回过的那一轮还画在树上（答完了才留），但它已经不在对话里，
							// 不挂个牌子的话点开只会看到一条"怎么滚不过去"的旧提问。
							!shown || node.rewound !== true
								? null
								: h('span', {
										key: 'r', title: '这一轮已被撤回，不在对话里了',
										style: {
											flex: '0 0 auto', color: C.muted, fontSize: '10px', lineHeight: '14px',
											border: `1px solid ${C.line}`, borderRadius: '3px', padding: '0 3px',
										},
									}, '撤回'),
							editing
								? h(InlineEdit, { key: 'i', initial: text, onDone: (value) => { setEditing(false); props.onRename(key, value) } })
								: h('span', { key: 't', style: { flex: '1 1 auto', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontWeight: isEmpty ? 600 : 400 } }, text),
							branchAction(node) === 'none' ? null : button('＋', '从这之后新开分支', () => props.onFork(node)),
							// 剪缝上的「接回去」—— 分离一直是单向的，拆出去就回不来了
							!shown || node.cut !== true ? null : button('⇤', '把这条支线接回原来那棵树', () => props.onJoin(node)),
							props.detachable ? button('⇥', '把这条支线拆成独立的一棵树', () => props.onDetach(node)) : null,
							// 合并整棵对话。挂在树根那个空节点上：合并是**整棵树对整棵树**的，
							// 不是某个节点对某个节点，挂在中间任何一个节点上都会让人以为"接到这儿"。
							!isEmpty || (props.targets || []).length === 0
								? null
								: button(merging ? '×' : '⊕', merging ? '收起' : '把别的对话合并进这棵树', () => setMerging(!merging)),
						]
					: null,
				!shown || !merging ? null : h(MergeList, {
					key: 'merge',
					targets: props.targets || [],
					railWidth,
					onPick: (target) => {
						setMerging(false)
						props.onMerge(target)
					},
				}),
			)
		}

		/**
		 * 「把哪棵树合进来」的清单。
		 *
		 * 为什么不需要问"合到树里的哪个位置"：两棵树的节点互不相同（同一个问题重问一遍，
		 * 答案也不会一样），合完就是两条链并排挂在同一个空根下 —— 只要知道是**哪两棵树**，
		 * 结果就唯一确定了。所以这里只列树，不列节点。
		 *
		 * 列表是我们自己渲染的：宿主的会话列表既没有 `data-session-*`，也没有留给单行的 slot
		 * （只有 sidebar.brand / footer / settings / workspaces 那几个），拖不了它的行。
		 * 好在本 cwd 的全部对话本来就在 `/outlines` 的答复里，自己列就是了。
		 */
		function MergeList(props) {
			const { targets, railWidth, onPick } = props
			return h(
				'div',
				{
					style: {
						position: 'absolute', right: `${railWidth + 4}px`, top: '100%', marginTop: '4px',
						width: `${Z.card}px`, maxWidth: '60vw', maxHeight: '40vh', overflowY: 'auto',
						background: C.bg, border: `1px solid ${C.line}`, borderRadius: '7px',
						boxShadow: '0 6px 20px rgba(0,0,0,.45)', padding: '4px',
						font: '12.5px/1.45 -apple-system,"Segoe UI","PingFang SC",sans-serif', color: C.text,
					},
				},
				targets.map((target) => {
					// 不能合并的那几条**留在单子里**，灰掉并把原因写在右边。
					// 直接不显示的话，用户只会觉得"我那条对话怎么不见了"，反而更慌。
					const stop = target.blocked !== undefined && target.blocked !== ''
					return h('div', {
						key: target.tree,
						title: stop ? target.blocked : target.joined ? '拆回独立的一棵树' : '合并进当前这棵树',
						style: {
							display: 'flex', alignItems: 'center', gap: '6px',
							padding: '4px 6px', borderRadius: '5px',
							cursor: stop ? 'not-allowed' : 'pointer',
							opacity: stop ? 0.45 : 1,
						},
						onMouseEnter: (event) => { if (!stop) event.currentTarget.style.background = C.line },
						onMouseLeave: (event) => { event.currentTarget.style.background = 'transparent' },
						onClick: () => { if (!stop) onPick(target) },
					},
					h('span', { key: 'g', style: { flex: '0 0 auto', color: C.muted, fontSize: '12px' } }, stop ? '⏳' : target.joined ? '⊖' : '⊕'),
					h('span', { key: 't', style: { flex: '1 1 auto', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, target.title || '未命名对话'),
					h('span', { key: 'n', style: { flex: '0 0 auto', color: C.muted, fontSize: '11px', fontVariantNumeric: 'tabular-nums' } }, stop ? target.blocked : `${target.turns} 轮`))
				}),
			)
		}

		// ===== ui-settings.js ==========================================

		/**
		 * 设置 → 插件 → 插件配置 里的那张卡。
		 *
		 * 容器归我们自己画：宿主只铺一个 `<ul>` 再按 namespace 派发，所以根元素**必须是 `<li>`**。
		 */

		/**
		 * 宿主设置卡片的设计令牌，照抄 ui-settings-plugins 的 PluginCard / fields。
		 * 值全是 `--dsw-alias-*` 变量而不是写死的色号 —— 换主题时跟着一起变。
		 */
		const S = {
			card: (open, hover) => ({
				listStyle: 'none', borderWidth: '.5px', borderStyle: 'solid',
				borderColor: open || hover ? 'var(--dsw-alias-label-dimmed)' : 'var(--dsw-alias-border-l4)',
				background: open ? 'var(--dsw-alias-bg-layer-2)' : 'var(--dsw-alias-bg-layer-3)',
				borderRadius: '16px', transition: 'border-color .16s, background .16s',
			}),
			header: {
				appearance: 'none', width: '100%', font: 'inherit', color: 'inherit', textAlign: 'left',
				cursor: 'pointer', background: 'none', border: 0, borderRadius: '12px',
				display: 'flex', alignItems: 'center', gap: '12px', padding: '14px 16px',
			},
			headText: { display: 'flex', flexDirection: 'column', flex: 1, gap: '4px', minWidth: 0 },
			name: { color: 'var(--dsw-alias-label-primary)', fontSize: '15px', fontWeight: 600, lineHeight: 1.4 },
			description: { color: 'var(--dsw-alias-label-tertiary)', fontSize: '13px', lineHeight: 1.5 },
			chevron: (open) => ({ flex: 'none', color: 'var(--dsw-alias-label-tertiary)', transition: 'transform .16s', transform: open ? 'rotate(180deg)' : 'rotate(0deg)' }),
			body: { borderTop: '.5px solid var(--dsw-alias-border-l2)', margin: '0 16px', paddingBottom: '8px' },
			field: { display: 'flex', flexDirection: 'column', gap: '6px', padding: '12px 0' },
			fieldHead: { display: 'flex', alignItems: 'center', gap: '8px' },
			label: { flex: 1, minWidth: 0, color: 'var(--dsw-alias-label-primary)', fontSize: '13px', fontWeight: 500, lineHeight: 1.5 },
			value: { color: 'var(--dsw-alias-label-primary)', fontSize: '13px', fontVariantNumeric: 'tabular-nums' },
			tag: { border: '.5px solid var(--dsw-alias-border-l4)', borderRadius: '6px', padding: '0 6px', fontSize: '11px', lineHeight: '18px', color: 'var(--dsw-alias-label-secondary)' },
			reset: { font: 'inherit', color: 'var(--dsw-alias-label-secondary)', cursor: 'pointer', background: 'none', border: 'none', padding: 0, fontSize: '12px', lineHeight: 1.5 },
			range: (on) => ({ width: '100%', height: '34px', accentColor: 'var(--dsw-alias-brand-primary)', cursor: on ? 'pointer' : 'default' }),
			pair: { display: 'flex', alignItems: 'center', gap: '12px', flexWrap: 'wrap' },
			swatch: (on) => ({ flex: '0 0 56px', height: '26px', padding: 0, border: 'none', background: 'none', cursor: on ? 'pointer' : 'default' }),
			picks: { display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' },
			// 形状按钮：里面画的就是那个形状本身，所以按钮上不写任何字
			chip: (picked, on) => ({
				appearance: 'none', display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
				width: '28px', height: '28px', padding: 0, cursor: on ? 'pointer' : 'default', overflow: 'hidden',
				borderWidth: '.5px', borderStyle: 'solid',
				borderColor: picked ? 'var(--dsw-alias-brand-primary)' : 'var(--dsw-alias-border-l4)',
				background: picked ? 'var(--dsw-alias-bg-layer-2)' : 'none',
				borderRadius: '6px',
			}),
			own: (picked, on) => ({
				width: '58px', height: '26px', boxSizing: 'border-box', font: 'inherit', fontSize: '12px',
				textAlign: 'center', color: 'var(--dsw-alias-label-primary)', background: 'none',
				borderWidth: '.5px', borderStyle: 'solid',
				borderColor: picked ? 'var(--dsw-alias-brand-primary)' : 'var(--dsw-alias-border-l4)',
				borderRadius: '6px', cursor: on ? 'text' : 'default',
			}),
			hint: { color: 'var(--dsw-alias-label-tertiary)', margin: 0, fontSize: '12px', lineHeight: 1.5 },
			note: { color: 'var(--dsw-alias-label-tertiary)', margin: '12px 0 0', fontSize: '12px', lineHeight: 1.5 },
		}

		/** 和宿主同款的 14px 折角箭头（IconChevronDownOutline14）。 */
		function Chevron(props) {
			return h(
				'svg',
				{ width: 14, height: 14, viewBox: '0 0 14 14', fill: 'none', 'aria-hidden': true, style: S.chevron(props.open) },
				h('path', { d: 'M3.5 5.5 L7 9 L10.5 5.5', stroke: 'currentColor', strokeWidth: 1.25, strokeLinecap: 'round', strokeLinejoin: 'round' }),
			)
		}

		/**
		 * 设置 → 插件 → 插件配置 里的那张卡。
		 *
		 * 容器归我们自己画 —— 宿主的契约是"带前端的插件自己拥有自己的卡"，它只铺一个
		 * `<ul>` 再按 namespace 派发，所以这里**必须是 `<li>`**，样式也照抄 PluginCard：
		 * 收起时只有标题+说明+箭头，点开才露出控件。
		 * @param props.store - 半径 store
		 */
		function SettingsCard(props) {
			const store = props.store || {}
			const state = useObservable(store) || {}
			const [open, setOpen] = react.useState(false)
			const [hover, setHover] = react.useState(false)
			const [failed, setFailed] = react.useState('')

			const on = state.writable === true
			const values = state.values || {}
			const user = state.user || {}
			const write = (run) => {
				setFailed('')
				Promise.resolve()
					.then(run)
					.catch((error) => setFailed(String((error && error.message) || error)))
			}

			// 本地回显。写设置要绕 host 转一圈，拖色板时那一圈跟不上手 ——
			// 读数和预览会一直停在旧值上，看着就是"调完下面没跟着变"。
			// 所以先本地记一份立刻画上，等设置真的回到这个值再撤掉。
			const [draft, setDraft] = react.useState({})
			react.useEffect(() => {
				setDraft((now) => {
					const next = {}
					let dirty = false
					for (const field of Object.keys(now)) {
						if (values[field] === now[field]) dirty = true
						else next[field] = now[field]
					}
					return dirty ? next : now
				})
			}, [values])

			/** 取一项的当前值：优先本地回显，其次设置，存的认不得就用默认。 */
			const valueOf = (field) => {
				if (draft[field] !== undefined) return draft[field]
				const spec = FIELDS.find((one) => one.field === field)
				return spec.accept(values[field]) ? values[field] : spec.fallback
			}

			/**
			 * 改一项：立刻回显，再写进设置。写失败就把回显撤掉，别让界面撒谎。
			 * @param field - 字段名
			 * @param next - 新值
			 */
			const put = (field, next) => {
				setDraft((now) => Object.assign({}, now, { [field]: next }))
				write(() =>
					Promise.resolve(store.set(field, next)).catch((error) => {
						setDraft((now) => {
							const back = Object.assign({}, now)
							delete back[field]
							return back
						})
						throw error
					}),
				)
			}

			/**
			 * 还原一项：回显也一起清掉。
			 * @param fields - 字段名
			 */
			const clear = (fields) => {
				setDraft((now) => {
					const back = Object.assign({}, now)
					for (const field of fields) delete back[field]
					return back
				})
				write(() => Promise.all(fields.map((field) => store.reset(field))))
			}

			/** 标题那一行：名字 + 读数 + 已修改 / 重置。`fields` 里任意一项被改过就算改过。 */
			const head = (label, text, fields) => {
				const changed = fields.some((field) => user[field] === true)
				return h('div', { key: 'hd', style: S.fieldHead }, [
					h('label', { key: 'l', style: S.label }, label),
					h('span', { key: 'v', style: S.value }, text),
					changed ? h('span', { key: 'g', style: S.tag }, '已修改') : null,
					changed
						? h('button', {
								key: 'r', type: 'button', style: S.reset, disabled: !on,
								onClick: () => clear(fields),
							}, '重置')
						: null,
				])
			}

			/** 滑杆那两项（显示范围 / 节点大小），仍然一项一行。 */
			const row = (spec) => {
				const now = valueOf(spec.field)
				const at = Math.max(0, spec.steps.indexOf(now))
				return h('div', { key: spec.field, style: S.field }, [
					head(spec.label, spec.text(spec.steps[at]), [spec.field]),
					h('input', {
						key: 'i', type: 'range', min: 0, max: spec.steps.length - 1, step: 1, value: at,
						disabled: !on, style: S.range(on),
						onChange: (event) => put(spec.field, spec.steps[Number(event.target.value)]),
					}),
					spec.hint === '' ? null : h('p', { key: 'p', style: S.hint }, spec.hint),
				])
			}

			/**
			 * 形状选择器：按钮里**画出形状本身**，不写"圆形""菱形"这种字，
			 * 而且跟着这一行选的颜色走 —— 按钮上看到的就是节点将来的样子。
			 * 预设后面跟两格自定义：传图片，或者填一个字符。
			 */
			const shapes = (field, now, color, dashed) =>
				h('div', { key: 'sp', style: S.picks }, [
					...SHAPES.map((one) =>
						h('button', {
							key: one.value, type: 'button', disabled: !on, title: one.value,
							style: S.chip(now === one.value, on),
							onClick: () => put(field, one.value),
						}, preview(one.value, color, 13, dashed)),
					),
					// 传图：选完立刻在浏览器里缩成 64×64 的 PNG 再上传，见 shrink()
					h('label', {
						key: 'img',
						title: `传一张图当节点。png / jpg / webp / svg 都行，尺寸不限 —— 会自动等比缩进 ${ICON_EDGE}×${ICON_EDGE}`,
						style: S.chip(String(now).startsWith(PICTURE), on),
					}, [
						String(now).startsWith(PICTURE)
							? preview(now, color, 15, dashed)
							: h('span', { key: 'p', style: { fontSize: '13px', lineHeight: 1, color: 'var(--dsw-alias-label-secondary)' } }, '🖼'),
						h('input', {
							key: 'f', type: 'file', accept: 'image/*', disabled: !on,
							style: { display: 'none' },
							onChange: (event) => {
								const file = event.target.files && event.target.files[0]
								event.target.value = '' // 同一个文件再传一次也要触发
								if (file === undefined || file === null) return
								write(() => upload(file).then((value) => put(field, value)))
							},
						}),
					]),
					// 填字：emoji 也行
					h('input', {
						key: 'own', type: 'text', maxLength: 4, disabled: !on,
						value: String(now).startsWith(CUSTOM) ? String(now).slice(CUSTOM.length) : '',
						placeholder: '填字', title: '填一个字符当节点，emoji 也行',
						style: S.own(String(now).startsWith(CUSTOM), on),
						onChange: (event) => {
							const text = event.target.value.trim()
							if (text === '') clear([field])
							else put(field, CUSTOM + text)
						},
					}),
				])

			/** 一个角色一行：左边颜色，右边形状。 */
			const pair = (spot) => {
				const color = valueOf(spot.color)
				return h('div', { key: spot.key, style: S.field }, [
					head(spot.label, String(color).toUpperCase(), [spot.color, spot.shape]),
					h('div', { key: 'bd', style: S.pair }, [
						h('input', {
							key: 'c', type: 'color', value: color, disabled: !on, style: S.swatch(on),
							onChange: (event) => put(spot.color, event.target.value),
						}),
						shapes(spot.shape, valueOf(spot.shape), color, spot.dashed === true),
					]),
					h('p', { key: 'p', style: S.hint }, spot.hint),
				])
			}

			return h('li', {
				style: S.card(open, hover),
				onMouseEnter: () => setHover(true),
				onMouseLeave: () => setHover(false),
			}, [
				h('button', { key: 'h', type: 'button', style: S.header, 'aria-expanded': open, onClick: () => setOpen(!open) }, [
					h('span', { key: 't', style: S.headText }, [
						h('span', { key: 'n', style: S.name }, '对话树'),
						h('span', { key: 'd', style: S.description }, '聊天区旁边那棵分支树的显示范围、大小与配色'),
					]),
					h(Chevron, { key: 'c', open }),
				]),
				open
					? h('div', { key: 'b', style: S.body }, [
							...FIELDS.filter((spec) => spec.kind === 'range').map(row),
							...ROWS.map(pair),
							failed === '' ? null : h('p', { key: 'e', style: S.note, role: 'status' }, `保存失败：${failed}`),
							on ? null : h('p', { key: 'w', style: S.note, role: 'status' }, `设置暂时不可写（状态 ${state.status || '未连接'}，模式 ${state.mode || '未知'}）。树按默认值画。`),
						])
					: null,
			])
		}

		// ===== rail.js =================================================

		/**
		 * 树本体：把 graph + elide 的结果画成一条贴着聊天区右缘的导轨。
		 */

		/** 树本体。 */
		function Rail(props) {
			const api = (props && props.api) || {}
			const listState = useObservable(api.list)
			const workspaceState = useObservable(api.workspaces)
			const box = useChatBox()
			const activeTurn = useActiveTurn()
			const settings = useObservable(api.settings) || {}
			const tuned = settings.values || {}
			const radius = Number.isFinite(tuned.visibleRadius) ? tuned.visibleRadius : RADIUS.fallback
			// 主题：每个字段各自回退，缺一项不影响其他项
			const theme = {}
			for (const spec of FIELDS) if (spec.kind === 'color' || spec.kind === 'shape') theme[spec.field] = spec.accept(tuned[spec.field]) ? tuned[spec.field] : spec.fallback
			const scale = Number.isFinite(tuned.nodeScale) ? tuned.nodeScale : SCALE.fallback

			const current = listState && listState.current
			const cwd = current && listState.byId[current] ? listState.byId[current].cwd : undefined
			const [nonce, setNonce] = react.useState(0)
			const [echo, setEcho] = react.useState(undefined)
			const outlines = useOutlines(cwd, listState, nonce)
			// 服务端答复一到就让位给它；回显只用来填补这一两百毫秒
			react.useEffect(() => setEcho(undefined), [outlines])
			/**
			 * 改树形：先本地回显（点下去立刻见效），再催一次重拉对齐服务端。
			 * 重复点是安全的 —— host 那边 detached 是个集合，同一个节点加两次等于加一次。
			 * @param patch - `{session, group?, detach?}`
			 */
			const reshape = (patch) =>
				api.reshape(patch).then((next) => {
					if (next !== undefined) setEcho(next)
					setNonce((value) => value + 1)
				})

			const [hover, setHover] = react.useState(null)
			const [tick, setTick] = react.useState(0)
			const lastGraph = react.useRef(undefined) // 数据空窗期顶上去的那棵树，见下面 ⚠️
			const labels = react.useMemo(() => readLabels(), [tick])

			// 换悬停目标用 hover intent：卡片开着时，鼠标**停下来**才换目标，一直在动就什么都不抢。
			// 这样从点走到卡片上的 ＋ 全程安全 —— 赶路途中压过多少个点都无所谓。
			const restTimer = react.useRef(0)

			const closeTimer = react.useRef(0)
			const hold = react.useCallback(() => clearTimeout(closeTimer.current), [])
			const release = react.useCallback(() => {
				clearTimeout(closeTimer.current)
				closeTimer.current = setTimeout(() => setHover(null), 280)
			}, [])
			react.useEffect(() => () => clearTimeout(closeTimer.current), [])
			react.useEffect(() => hideNativeRail(), [])
			react.useEffect(() => () => clearTimeout(restTimer.current), [])

			// 导轨现在是全局常驻的（shell.overlay），所以必须自己判断"该不该露面"：
			// 量不到聊天区 = 用户不在会话界面（设置页/全局面板），收起来。
			// 组件本身不卸载，hover / box / 上一棵树都还在，切回来是瞬时的。
			if (!listState || !current || box === undefined) return null

			// 可见集 = 会话列表 减去 归档集（归档的会话仍留在 sessions.list 里，必须显式扣）
			const archived = new Set((workspaceState && workspaceState.archivedSessionIds) || [])
			const visible = new Set((listState.ids || []).filter((id) => !archived.has(id)))
			if (!visible.has(current)) visible.add(current)

			const shape = echo || (outlines && outlines.shape) || {}
			const picked = conversationOf(visibleTree((outlines && outlines.sessions) || [], visible), current, shape.groupOf)

			// ⚠️ 新分支会先出现在会话列表里、后出现在 /outlines 里（拉取有 120ms 防抖），
			//    这中间 picked 是空的。直接 return null 会让整条导轨**整个消失再冒出来**，
			//    比"颜色晚 100ms 更新"难看得多 —— 所以拿上一棵树顶着，数据到了自然换掉。
			let graph
			try {
				graph = picked.length > 0 ? buildGraph(picked, current, cutSet(shape.detached, picked)) : undefined
			} catch (error) {
				warn('建图失败，先拿上一棵顶着', error)
			}
			if (graph !== undefined) lastGraph.current = graph
			else graph = lastGraph.current
			if (graph === undefined) return null

			// 省略太远的节点。radius=0 时 elide 全留，下面这一整套退化成原来的画法。
			// 放在自诊断钩子前面，好让钩子能把"到底省了几个"一起倒出来。
			const view = elide(graph.nodes, anchorNode(graph.nodes, activeTurn), radius)
			const rowOfNode = (node) => view.rowOf.get(node.depth)

			// 自诊断钩子：症状出现时在浏览器控制台敲 __dshTree() 就能把当时的真实状态倒出来。
			// 加这个是因为"某些点莫名变白"这类问题光看代码猜不出来，
			// 而每猜错一轮都要 John 重启一次。
			installDiagnostics({
				current, cwd, activeTurn, view, scale, tuned, settings, picked, archived,
				radiusText: radius === RADIUS.off ? '不省略' : radius,
				nodes: graph.nodes,
				sessionCount: (listState.ids || []).length,
			})

			const { z, available, rowH, treeHeight, railWidth, dotSize, xOf, yOf } = railLayout(box, scale, view.rows, graph.maxColumn)

			const parts = []

			// 先铺线。跨列的折角**必须先横后竖**：反过来的话从节点 2 岔到 4 的竖线
			// 会一路压过节点 3 再拐弯，看着像"经过 3 转个弯到 4"。
			const line = (key, xFrom, xTo, yFrom, yTo, color, gapFrom, gapTo, alpha) => {
				const cut = segments(xFrom, xTo, yFrom, yTo, gapFrom, gapTo)
				for (const part of cut) {
					parts.push(h('span', {
						key: `${part.tag}${key}`,
						style: { position: 'absolute', left: `${part.left}px`, top: `${part.top}px`, width: `${part.width}px`, height: `${part.height}px`, background: color, opacity: alpha },
					}))
				}
			}

			// 鱼眼：越靠近半径边界的点画得越小越淡
			const eyeOf = (node) => fisheye(view.dimOf.get(node))
			const reachOf = (node) => reachFor(node.kind, node.active, dotSize, theme, eyeOf(node).scale)

			const edge = (node) => {
				// 两头都在才连。只剩一头的那条边整个不画 —— 鱼眼的收尾靠点自己淡掉，
				// 再拖一截"通向空处"的线出来反而是个新的硬边界。
				if (!view.shown.has(node) || !view.shown.has(node.parent)) return
				const color = node.active ? fade(theme.currentColor, 0.6) : C.line
				// 线按**淡的那一头**走：亮点连着淡点时，线跟着亮会显得那个淡点还没退场
				const alpha = Math.min(eyeOf(node).alpha, eyeOf(node.parent).alpha)
				line(node.key, xOf(node.parent.column), xOf(node.column), yOf(rowOfNode(node.parent)), yOf(rowOfNode(node)), color, reachOf(node.parent), reachOf(node), alpha)
			}
			for (const node of edgeOrder(graph.nodes)) edge(node)

			// 再画点
			for (const node of graph.nodes) {
				if (!view.shown.has(node)) continue
				const x = xOf(node.column)
				const y = yOf(rowOfNode(node))
				const isFocused = isFocusedNode(node, activeTurn)
				const isHover = hover !== null && hover.node === node
				const eye = eyeOf(node)
				const size = dotSizeOf(node.kind, dotSize, eye.scale)
				// 滑上去就把淡出撤掉，但**不改尺寸** —— size 决定 left/top，一变就整个点跳一下，
				// transition 只过渡 transform/opacity，拦不住这种位移。放大交给已有的 scale(1.4)。
				const alpha = isHover ? 1 : eye.alpha
				// ⚠️ 点上**不再**挂 onMouseEnter。换目标一律走容器那一个 mousemove 做 hover intent，
				//    否则赶路途中压过的每个点都会抢走卡片 —— ＋ 就永远够不着（DESIGN.md §6）。
				const go = () => (node.entry === undefined ? api.open(node.session.id) : api.jump(jumpTarget(node, current), node.entry.turn, node.entry.seq))
				// 三角这类多边形、以及自定义的字，方框画不出来，得往里放东西
				const shape = shapeOf(node.kind, node.active, theme)
				const skin = inkOf(node.kind, node.active, isFocused, theme)
				parts.push(h('span', {
					key: `d${node.key}`,
					style: Object.assign({ position: 'absolute', left: `${x - size / 2}px`, top: `${y - size / 2}px`, cursor: 'pointer', userSelect: 'none' }, dotStyle(node.kind, node.active, isHover, size, isFocused, theme, alpha)),
					onClick: go,
				}, dotInside(shape, size, skin, (1.5 * size) / Z.dot, dashedOf(node.kind))))
				// 透明加宽命中区：点很小，直接点很难中
				parts.push(h('span', {
					key: `hit${node.key}`,
					style: { position: 'absolute', left: `${x - z.hit / 2}px`, top: `${y - rowH / 2}px`, width: `${z.hit}px`, height: `${rowH}px`, cursor: 'pointer' },
					onClick: go,
				}))
			}

			// 能合并进来的 / 已经合进来的别的对话。整棵树对整棵树，所以这里按树列。
			const all = visibleTree((outlines && outlines.sessions) || [], visible)
			const targets = mergeTargets(all, current, shape.groupOf)
			const here = treeOfSession(all, shape.groupOf, current)

			// 鼠标能落在哪些点上 —— 交给容器的 mousemove 做命中测试（见下面 hover intent）。
			const seats = graph.nodes
				.filter((node) => view.shown.has(node))
				.map((node) => ({ x: xOf(node.column), y: yOf(rowOfNode(node)), node }))
			const top = box.top + Z.pad
			const right = Math.max(0, window.innerWidth - box.right) + Z.gap
			const height = available

			const shell = h(
				'div',
				{
					style: { position: 'fixed', top: `${top}px`, height: `${height}px`, right: `${right}px`, width: `${railWidth}px`, zIndex: 40, pointerEvents: 'none' },
					onMouseLeave: release,
				},
				// ⏳：这条会话正跑着，撤回记录这一轮读不了（读它会打断那一轮，见 src/host/rewind.js）。
				// 不说一声的话，撤回完紧接着发的那一轮树上画的还是撤回前的形状，看着就是"这插件又坏了"。
				// 放在导轨上沿那 16px 空当里，不压到任何一个点；小、淡、鼠标停上去才解释。
				!isRewindPending(outlines) ? null : h('span', {
					key: 'rewind-pending',
					title: '这条会话正在跑，暂时读不了它的撤回记录 —— 读那个文件会打断正在跑的这一轮。\n树上画的是上一次读到的状态，撤回过的轮次可能还画着。这一轮跑完会自动更正。',
					style: {
						position: 'absolute', top: '-13px', right: '0px',
						fontSize: '10px', lineHeight: '12px', color: C.muted, opacity: 0.55,
						pointerEvents: 'auto', cursor: 'help', userSelect: 'none',
					},
				}, '⏳'),
				h(
					'div',
					{
						style: { position: 'absolute', right: 0, top: `${Math.max(0, (height - treeHeight) / 2)}px`, width: `${railWidth}px`, height: `${treeHeight}px`, pointerEvents: 'auto' },
						// hover intent：整条导轨只有这一个 mousemove 在做命中。
						//   · 还没开卡片 → 碰到点就立刻开（要跟手）
						//   · 已经开着  → 每次移动都把计时器清掉；只有**停住** restMs 才换目标
						// 所以从点走到卡片上的 ＋ 全程不会被抢：只要手还在动，谁都抢不走。
						onMouseMove: (event) => {
							const rect = event.currentTarget.getBoundingClientRect()
							const at = nodeAt(seats, event.clientX - rect.left, event.clientY - rect.top, z.hit, rowH)
							hold()
							clearTimeout(restTimer.current)
							const want = hoverNext(hover === null ? null : hover.node, at)
							if (want === 'keep') return
							const seat = () => setHover({ node: at, y: yOf(rowOfNode(at)) })
							if (want === 'now') seat()
							else restTimer.current = setTimeout(seat, Z.restMs)
						},
					},
					parts,
					h(Detail, {
						node: hover ? hover.node : null,
						y: hover ? hover.y : 0,
						detachable: hover !== null && hover.node.canDetach === true,
						targets,
						// 合并：只要知道是哪两棵树就够了，不用指定接到哪个节点。
						// `group` 记在**被合并那棵树的树根会话**上，host 会顺带把指着它的人一起改指过来。
						onMerge: (target) => reshape(target.joined ? shapeOps.unmerge(target.root) : shapeOps.merge(target.root, here)),
						// 接回去：撤销一次分离。剪点本身就是被剪的那个节点，原样发回去即可。
						onJoin: (node) => reshape(shapeOps.heal(node.key)),
						onDetach: (node) => {
							const at = cutPointOf(node)
							if (at !== undefined) reshape(shapeOps.cut(at.key))
						},
						railWidth, labels, hold, release,
						onRename: (key, value) => { writeLabel(key, value); setTick((value2) => value2 + 1) },
						onFork: (node) => {
							const action = branchAction(node)
							if (action === 'none') return undefined
							if (action === 'fresh') return api.fresh(workspaceOf(workspaceState, node.session.id), node.session.cwd, treeOfSession(picked, shape.groupOf, current))
							if (action === 'open') return api.open(node.session.id)
							return api.fork(node.session.id, node.entry.seq)
						},
					}),
				),
			)
			return typeof document === 'undefined' ? null : portal(shell, document.body)
		}

		// ===== pure.js =================================================

		/**
		 * 离线测试的出口。
		 *
		 * 浏览器半是个 `__ModuleLoader__` bundle，node 里没法直接 import，所以测试是这么干的：
		 * 塞一个假的 loader 和假的 react 骗 factory 跑完，再从 `exports.__pure` 把函数拿出来
		 * （见 test-kit.mjs）—— **测的是真代码，不是复制品**。
		 *
		 * 【加了新纯函数怎么办】往这张表里加一行。不加也能跑，只是测不到；
		 * 而测不到的代码，改坏了没有任何一条断言会响。
		 *
		 * 【什么东西不该进这张表】碰 DOM / react / fetch 的。那些在 node 里跑不起来，
		 * 要测就得先把"算"从"画"里拆出来 —— 拆出来的那半才进这里。
		 */

		const __pure = {
			// 选树、归组、节点上能做什么
			visibleTree, conversationOf, treeOf, treeOfSession, indexOf, keyOf, ROOT_KEY, shapeOps,
			cutPointOf, cutSet, branchAction, mergeTargets, blockedWhy, jumpTarget, isFocusedNode, workspaceOf,
			// 图
			buildGraph, elide, fisheye, FADE, anchorNode,
			// 画
			dotStyle, inkOf, fade, shapeSpec, shapeOf, shapeBox, polyPoints, polyProps, roleOf, dashedOf, dotSizeOf,
			SHAPES, THEME, ROLES, CUSTOM, PICTURE, ICON_EDGE,
			// 几何
			reachFor, segments, edgeOrder, nodeAt, hoverNext, railLayout,
			// 撤回的重拉节奏
			isRewindPending, rewindRetryDelay,
			// 设置
			settingsStore, stepText, scaleText, scaleZ, STEPS, SCALES, RADIUS, SCALE, FIELDS, ROWS, Z,
		}

		// ===== apply.js ================================================

		/**
		 * 装配：宿主 API 的转调层 + 往 slot 上挂组件。
		 *
		 * 这是浏览器半唯一碰宿主服务（`ctx.sessions` / `ctx.slots` / `ctx.workspaces`）的地方，
		 * 别处一律只用下面这个 `api` 对象。插件自己不碰会话数据，全是转调。
		 */

		const inject = ['slots', 'sessions', 'workspaces']

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
		function apply(ctx) {
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

		exports.apply = apply
		exports.inject = inject
		// 纯函数出口，仅供离线测试（cordis 只读 apply/inject）
		exports.__pure = __pure
		return module.exports
	},
})
