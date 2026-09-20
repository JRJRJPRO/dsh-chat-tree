/**
 * dsh-tree 浏览器半：贴着聊天区右缘的对话树。
 *
 * 数据流：host 的 /outlines 给「每个分支的自有轮次」→ 扣掉归档 → 只留当前那棵树
 * → buildGraph 摊成节点算出 (column, depth) → 绝对定位画点和折线。
 *
 * 三条规矩（改之前先看 DESIGN.md §5）：
 *   · y = 树深度，不是行号 —— 同一岔路分出去的两条支线，第一个节点同高度。
 *   · x = 列，**与"当前在哪条分支"无关** —— 切分支只换颜色，图的形状不动。
 *   · 太远的节点省略掉（elide），剪断处画「⋯」；半径设为 0 就退回"永远画全"。
 *
 * 高亮两条判据，别混：
 *   边框蓝 ⟺ 节点在当前会话的对话里；填充蓝 ⟺ 边框已蓝 且 轮次 == 现在滑到的那一轮。
 */

window.__ModuleLoader__.load({
	id: 'dsh-tree',
	factory: (require) => {
		// ===== 第 1 步：模块壳子 =====
		var module = { exports: {} }
		var exports = module.exports
		Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

		const react = require('react')
		const reactDom = require('react-dom')
		const h = react.createElement
		const portal = reactDom.createPortal

		// ===== 第 2 步：标签存储（MVP 妥协：localStorage，换浏览器就没了） =====

		/** 设置命名空间。host 半用同名 namespace 注册 schema，两边必须一致。 */
		const SETTINGS_NS = 'dsh-tree'

		/** 省略半径。0 = 不省略；滑杆位置就是 [5..30, 0]。 */
		const RADIUS = { min: 5, max: 30, fallback: 10, off: 0 }

		/** 节点缩放，百分比。 */
		const SCALE = { min: 50, max: 250, step: 10, fallback: 100 }

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

		// ===== 第 3 步：过滤 / 选树 / buildGraph =====

		/**
		 * 按可见集过滤，并把"父亲被归档"的孤儿重接到最近的可见祖先。
		 *
		 * 小例子：A ← B ← C，B 被归档 → 剩 {A, C}，C 沿原链上溯到 A → 重接成 A ← C。
		 * 树仍是一棵，而不是裂成两棵。
		 * @param all - host 返回的全部分支（含已归档）
		 * @param visible - 可见 sessionId 集合
		 */
		function visibleTree(all, visible) {
			const byId = new Map(all.map((item) => [item.id, item]))
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
			const byId = new Map(sessions.map((item) => [item.id, item]))
			const mine = treeOf(byId, groupOf, currentId)
			if (mine === undefined) return []
			return sessions.filter((item) => treeOf(byId, groupOf, item.id) === mine)
		}

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
			const byId = new Map(sessions.map((item) => [item.id, item]))
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

			const root = { key: 'root', kind: 'empty', session: ordered[0], entry: undefined, parent: undefined, children: [], depth: 0 }
			let nodes = [root]
			const nodeOf = new Map()
			const attachOf = new Map() // 会话 → 它挂在哪个节点下

			// ① 连节点 + ② 算 depth
			for (const session of ordered) {
				let anchor = root
				if (session.parentId !== undefined && byId.has(session.parentId)) {
					const hit = nodeOf.get(`${session.parentId}:${session.forkTurn}`)
					// forkTurn 落在父分支的继承段里（爷爷辈岔出来的）→ 退到父分支自己的挂载点
					anchor = hit || attachOf.get(session.parentId) || root
				}
				attachOf.set(session.id, anchor)

				let previous = anchor
				for (const entry of ownTurns(session)) {
					const node = {
						key: `${session.id}:${entry.turn}`, kind: entry.compact ? 'compact' : 'normal',
						session, entry, parent: previous, children: [], depth: previous.depth + 1,
					}
					previous.children.push(node)
					nodes.push(node)
					nodeOf.set(node.key, node)
					previous = node
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
				ownerOf.set(node, cutAt.has(node.key) ? node : ownerOf.get(node.parent))
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
				const preferred = kids.find((kid) => kid.session.id === node.session.id) || kids[0]
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
				node.active = node.entry === undefined ? true : node.entry.turn <= (limitOf.has(node.session.id) ? limitOf.get(node.session.id) : -1)
				// 能不能分离：一路往上只要有哪个祖先有多个孩子就能。
				// 父在前子在后遍历，所以这里可以直接吃父亲算好的结果 —— O(1)，
				// 不用点击时再回溯，也不会因为别处新增/分离而过期。
				node.canDetach = node.parent !== undefined && (node.parent.children.length > 1 || node.parent.canDetach === true)
				maxDepth = Math.max(maxDepth, node.depth)
				maxColumn = Math.max(maxColumn, node.column || 0)
			}
			return { nodes, maxDepth, maxColumn }
		}

		/**
		 * 按「离你正在看的那一轮多远」把太远的节点省略掉。
		 *
		 * 距离是树上的无向步数：父节点 1 步，父节点的另一个孩子 2 步（上一步再下一步）。
		 * 藏掉的行不留空档 —— depth 重新压实成连续的 row，否则省略了也腾不出地方。
		 *
		 * 小例子（线性 1..20，站在 10，半径 3）：
		 *   显示 7 8 9 [10] 11 12 13，上下各一个「⋯」。
		 *
		 * @param nodes - buildGraph 出来的全部节点
		 * @param anchor - 从哪个节点量距离
		 * @param radius - 保留半径；<=0 表示不省略
		 * @returns {shown, rowOf, rows, bandTop, bandBottom, hidden}
		 */
		function elide(nodes, anchor, radius) {
			const shown = new Set()
			if (!(radius > 0) || anchor === undefined) {
				for (const node of nodes) shown.add(node)
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
				for (const node of step.keys()) shown.add(node)
			}

			const depths = [...new Set([...shown].map((node) => node.depth))].sort((left, right) => left - right)
			const rowOf = new Map(depths.map((depth, index) => [depth, index]))

			// 省略号画在"树被剪断的地方"：留下来的节点丢了父亲 → 它这一列上方有省略号；
			// 留下来的节点丢了孩子 → 那个孩子所在的列下方有省略号（岔路被砍掉也看得见）。
			const bandTop = new Set()
			const bandBottom = new Set()
			for (const node of shown) {
				if (node.parent !== undefined && !shown.has(node.parent)) bandTop.add(node.column)
				for (const kid of node.children) if (!shown.has(kid)) bandBottom.add(kid.column)
			}
			return { shown, rowOf, rows: depths.length, bandTop, bandBottom, hidden: nodes.length - shown.size }
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
				if (first !== undefined) out.add(`${item}:${first.turn}`)
			}
			return out
		}


		/**
		 * 在某个节点上按 ＋ 该干什么。
		 * **叶子节点不 fork**：后面什么都没有，复制一份只会多出一条内容重复的会话。
		 * @param node - 被点的节点
		 * @returns 'none' 什么都不该做 | 'fresh' 开新对话 | 'open' 就在本会话接着问 | 'fork' 真的开岔路
		 */
		function branchAction(node) {
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
		 *    左边每一列（列距 14px < 命中区 18px），沿途每个点都会抢走卡片，
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

		// ===== 第 4 步：尺寸与形态 =====

		// hit = 命中区宽度，同时也是导轨右侧留给第 0 列的宽度（圆心在 hit/2 处）。
		// 以前 18 和 9 是散在渲染里的魔数，收进来才能跟着缩放一起动。
		const Z = { row: 20, rowMin: 7, dot: 9, dotMin: 6, dotPad: 5, lane: 14, hit: 18, ell: 14, pad: 16, card: 270, gap: 20, restMs: 140, graceMs: 600 }

		/**
		 * 按百分比缩放尺寸。**只缩几何量** —— `restMs` 是时间、`card` 是文字卡片宽度，
		 * 跟着点一起放大只会挡住聊天区，所以都不动。
		 *
		 * 小例子（percent=150）：dot 9→13.5、lane 14→21、hit 18→27，
		 * 于是点变大、列变宽、命中区同比变宽，图整体等比例放大。
		 *
		 * @param percent - 百分比，100 = 原样
		 * @returns 新的尺寸表；`scaleZ(100)` 必须与 Z 逐字段相等
		 */
		function scaleZ(percent) {
			const k = Number.isFinite(percent) && percent > 0 ? percent / 100 : 1
			const out = Object.assign({}, Z)
			for (const key of ['row', 'rowMin', 'dot', 'dotMin', 'dotPad', 'lane', 'hit', 'ell']) out[key] = Z[key] * k
			return out
		}
		const C = {
			line: '#30363d', lineActive: 'rgba(88,166,255,.6)',
			dim: '#6e7681', dimActive: 'rgba(88,166,255,.9)',
			muted: '#8b949e', text: '#c9d1d9',
			blue: '#58a6ff', orange: '#ffa657', bg: '#161b22',
		}

		/**
		 * 节点样式。四种形态：普通 / 当前 / 压缩 / 空。
		 * 边框 ← 在不在当前路径上（滚动不影响）；填充 ← 现在看着哪一轮（只影响这个）。
		 * @param kind - 形态
		 * @param active - 是否在当前路径上
		 * @param hover - 鼠标是否停在它上面
		 * @param size - 直径
		 */
		function dotStyle(kind, active, hover, size, focused) {
			// ⚠️ 所有分支必须返回**相同的 key 集合**，边框只用 longhand，不许写 `border` 简写。
			//    React 会把"上一帧有、这一帧没有"的属性置空，简写和 longhand 混用时
			//    切回普通态会掉成白边框 —— 滑过一个点白一个（DESIGN.md §5）。
			//
			// ⚠️ 形状归 `kind`，状态归 `active`/`focused`，两者**正交**。
			//    以前是 `kind = focused ? 'current' : node.kind`，压缩节点一滑到就变回蓝圆点 ——
			//    "一眼看出是压缩节点"恰好在最该看清的时候失效。别再把状态塞回 kind 里。
			// 描边和外发光都按直径同比例走，否则点放大后边框细得看不见。
			const k = size / Z.dot
			const diamond = kind === 'compact'
			const accent = diamond ? C.orange : C.blue
			return {
				width: `${size}px`, height: `${size}px`,
				// 压缩节点画成菱形（转 45°、几乎不倒角），小尺寸下也和圆点一眼分得开
				borderRadius: diamond ? `${1.5 * k}px` : '50%',
				borderWidth: `${1.5 * k}px`,
				borderStyle: kind === 'empty' ? 'dashed' : 'solid',
				borderColor: focused ? accent : diamond ? C.orange : kind === 'empty' && !active ? '#7d8590' : active ? C.dimActive : C.dim,
				// 路径上的点垫一层淡填充：只靠描边在小尺寸下看着像白的
				background: focused ? accent : diamond ? 'rgba(255,166,87,.3)' : active ? 'rgba(88,166,255,.18)' : C.bg,
				boxShadow: focused ? `0 0 0 ${3 * k}px ${diamond ? 'rgba(255,166,87,.22)' : 'rgba(88,166,255,.22)'}` : 'none',
				boxSizing: 'border-box',
				opacity: focused || active ? 1 : 0.4,
				transition: 'transform .12s ease, opacity .12s ease',
				transform: `${hover ? 'scale(1.4)' : 'scale(1)'}${diamond ? ' rotate(45deg)' : ''}`,
			}
		}

		// ===== 第 5 步：副作用钩子 =====

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
			const stamp = listState
				? `${(listState.ids || []).length}:${listState.current}:${(listState.ids || []).map((id) => (listState.byId[id] || {}).updatedAt).join(',')}`
				: ''
			react.useEffect(() => {
				if (!cwd) return undefined
				let alive = true
				const timer = setTimeout(() => {
					fetch(`/plugins/dsh-tree/outlines?cwd=${encodeURIComponent(cwd)}`, { credentials: 'same-origin' })
						.then((response) => (response.ok ? response.json() : Promise.reject(new Error(String(response.status)))))
						.then((body) => alive && setData(body))
						.catch((error) => console.warn('[dsh-tree] outlines fetch failed', error))
				}, 120)
				return () => {
					alive = false
					clearTimeout(timer)
				}
			}, [cwd, stamp, nonce])
			return data
		}

		// ===== 第 6 步：组件 =====

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
			react.useEffect(() => setEditing(false), [node])

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
							editing
								? h(InlineEdit, { key: 'i', initial: text, onDone: (value) => { setEditing(false); props.onRename(key, value) } })
								: h('span', { key: 't', style: { flex: '1 1 auto', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontWeight: isEmpty ? 600 : 400 } }, text),
							branchAction(node) === 'none' ? null : button('＋', '从这之后新开分支', () => props.onFork(node)),
							props.detachable ? button('⇥', '把这条支线拆成独立的一棵树', () => props.onDetach(node)) : null,
						]
					: null,
			)
		}

		/** 省略半径的档位：5..30，最后一格是"不省略"。 */
		const STEPS = Array.from({ length: RADIUS.max - RADIUS.min + 1 }, (_, i) => RADIUS.min + i).concat([RADIUS.off])

		/** 缩放的档位：50%..250%，每档 10。 */
		const SCALES = Array.from({ length: (SCALE.max - SCALE.min) / SCALE.step + 1 }, (_, i) => SCALE.min + i * SCALE.step)

		/**
		 * 一档的人话。
		 * @param step - 档位值
		 */
		function stepText(step) {
			return step === RADIUS.off ? '不省略' : `${step} 步以内`
		}

		/**
		 * 缩放档位的人话。
		 * @param step - 百分比
		 */
		function scaleText(step) {
			return `${step}%`
		}

		/**
		 * 卡片上的两行设置。加新设置项就往这儿加一条，卡片和 store 都不用改。
		 * `field` 必须和 host 半 SETTINGS_SCHEMA 里的字段名一致。
		 */
		const FIELDS = [
			{ field: 'visibleRadius', label: '显示范围', steps: STEPS, text: stepText, fallback: RADIUS.fallback,
				hint: '离你正在看的那一轮多少步以内的节点才画出来。父节点算 1 步，父节点的另一个孩子算 2 步。' },
			{ field: 'nodeScale', label: '节点大小', steps: SCALES, text: scaleText, fallback: SCALE.fallback,
				hint: '点、连线、列间距、命中区一起等比例缩放。树太高时行距仍会被自动压扁。' },
		]

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

			const row = (spec) => {
				const now = Number.isFinite(values[spec.field]) ? values[spec.field] : spec.fallback
				const at = Math.max(0, spec.steps.indexOf(now))
				const changed = user[spec.field] === true
				return h('div', { key: spec.field, style: S.field }, [
					h('div', { key: 'hd', style: S.fieldHead }, [
						h('label', { key: 'l', style: S.label }, spec.label),
						h('span', { key: 'v', style: S.value }, spec.text(spec.steps[at])),
						changed ? h('span', { key: 'g', style: S.tag }, '已修改') : null,
						changed ? h('button', { key: 'r', type: 'button', style: S.reset, disabled: !on, onClick: () => write(() => store.reset(spec.field)) }, '重置') : null,
					]),
					h('input', {
						key: 'i', type: 'range', min: 0, max: spec.steps.length - 1, step: 1, value: at,
						disabled: !on, style: S.range(on),
						onChange: (event) => {
							const picked = spec.steps[Number(event.target.value)]
							write(() => store.set(spec.field, picked))
						},
					}),
					h('p', { key: 'p', style: S.hint }, spec.hint),
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
						h('span', { key: 'd', style: S.description }, '聊天区旁边那棵分支树的显示范围与大小'),
					]),
					h(Chevron, { key: 'c', open }),
				]),
				open
					? h('div', { key: 'b', style: S.body }, [
							...FIELDS.map(row),
							failed === '' ? null : h('p', { key: 'e', style: S.note, role: 'status' }, `保存失败：${failed}`),
							on ? null : h('p', { key: 'w', style: S.note, role: 'status' }, `设置暂时不可写（状态 ${state.status || '未连接'}，模式 ${state.mode || '未知'}）。树按默认值画。`),
						])
					: null,
			])
		}

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
							if (Number.isFinite(from[spec.field])) next.values[spec.field] = from[spec.field]
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
				console.warn('[dsh-tree] 设置服务不可用，按默认值画', error)
			}
			return store
		}

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
				console.warn('[dsh-tree] buildGraph failed', error)
			}
			if (graph !== undefined) lastGraph.current = graph
			else graph = lastGraph.current
			if (graph === undefined) return null

			// 自诊断钩子：症状出现时在浏览器控制台敲 __dshTree() 就能把当时的真实状态倒出来。
			// 加这个是因为"某些点莫名变白"这类问题光看代码猜不出来，
			// 而每猜错一轮都要 John 重启一次。
			if (typeof window !== 'undefined') {
				window.__dshTree = () => ({
					当前会话: current,
					工作目录: cwd,
					滑到第几轮: activeTurn,
					省略半径: radius === RADIUS.off ? '不省略' : radius,
					缩放: `${scale}%`,
					设置: `半径=${tuned.visibleRadius} 缩放=${tuned.nodeScale} 可写=${settings.writable} 状态=${settings.status} 模式=${settings.mode}`,
					分支: picked.map((item) => `${item.id.slice(8, 14)} ← ${item.parentId ? item.parentId.slice(8, 14) : '根'} 岔路点=${item.forkTurn} 自有轮=${(item.turns || []).filter((t) => !t.inherited).map((t) => t.turn).join(',')}`),
					节点: graph.nodes
						.filter((node) => node.entry !== undefined)
						.map((node) => `#${node.no} ${node.session.id.slice(8, 14)}轮${node.entry.turn} ${node.active ? '蓝' : '白'} 列${node.column}深${node.depth}`),
					归档: [...archived].map((id) => id.slice(8, 14)),
					列表里有几条会话: (listState.ids || []).length,
				})
			}

			// 省略太远的节点。radius=0 时 elide 全留，下面这一整套退化成原来的画法。
			const view = elide(graph.nodes, anchorNode(graph.nodes, activeTurn), radius)
			const padTop = view.bandTop.size > 0 ? 1 : 0
			const padBottom = view.bandBottom.size > 0 ? 1 : 0
			const rowOfNode = (node) => view.rowOf.get(node.depth) + padTop

			// 放不下就压行高（下限 rowMin）
			const z = scaleZ(scale)
			const available = box.height - z.pad * 2 // box 必定有值：上面已经 return 过了
			const rows = view.rows + padTop + padBottom
			const rowH = Math.max(z.rowMin, Math.min(z.row, available / rows))
			const treeHeight = rows * rowH
			// 列宽用 graph.maxColumn 而不是可见列 —— 省略随滚动变化，导轨宽度不该跟着跳
			const railWidth = z.hit + graph.maxColumn * z.lane
			const xOf = (column) => railWidth - z.hit / 2 - column * z.lane
			const yOf = (row) => row * rowH + rowH / 2
			const dotSize = Math.max(z.dotMin, Math.min(z.dot, rowH - z.dotPad))

			const parts = []

			// 先铺线。跨列的折角**必须先横后竖**：反过来的话从节点 2 岔到 4 的竖线
			// 会一路压过节点 3 再拐弯，看着像"经过 3 转个弯到 4"。
			const line = (key, xFrom, xTo, yFrom, yTo, color) => {
				if (xTo !== xFrom) {
					parts.push(h('span', {
						key: `hz${key}`,
						style: { position: 'absolute', left: `${Math.min(xTo, xFrom)}px`, top: `${yFrom}px`, width: `${Math.abs(xFrom - xTo)}px`, height: '1px', background: color },
					}))
				}
				parts.push(h('span', {
					key: `v${key}`,
					style: { position: 'absolute', left: `${xTo}px`, top: `${Math.min(yFrom, yTo)}px`, width: '1px', height: `${Math.abs(yTo - yFrom)}px`, background: color },
				}))
			}

			const edge = (node) => {
				const color = node.active ? C.lineActive : C.line
				const mine = view.shown.has(node)
				const theirs = view.shown.has(node.parent)
				// 两头都在 → 正常连；只剩一头 → 接到省略号那一行，别让树看着断开
				if (mine && theirs) line(node.key, xOf(node.parent.column), xOf(node.column), yOf(rowOfNode(node.parent)), yOf(rowOfNode(node)), color)
				else if (mine && padTop > 0) line(node.key, xOf(node.column), xOf(node.column), yOf(0), yOf(rowOfNode(node)), color)
				else if (theirs && padBottom > 0) line(node.key, xOf(node.parent.column), xOf(node.column), yOf(rowOfNode(node.parent)), yOf(rows - 1), color)
			}
			for (const node of edgeOrder(graph.nodes)) edge(node)

			// 省略号
			for (const [column, row] of [...[...view.bandTop].map((c) => [c, 0]), ...[...view.bandBottom].map((c) => [c, rows - 1])]) {
				parts.push(h('span', {
					key: `e${row}:${column}`,
					title: `还有 ${view.hidden} 个节点被省略（设置里可以调范围）`,
					style: {
						position: 'absolute', left: `${xOf(column) - z.ell / 2}px`, top: `${yOf(row) - z.ell / 2}px`,
						width: `${z.ell}px`, height: `${z.ell}px`, lineHeight: `${z.ell}px`, textAlign: 'center',
						color: C.dim, fontSize: `${(z.ell * 12) / Z.ell}px`, letterSpacing: '0.5px', userSelect: 'none',
					},
				}, '⋯'))
			}

			// 再画点
			for (const node of graph.nodes) {
				if (!view.shown.has(node)) continue
				const x = xOf(node.column)
				const y = yOf(rowOfNode(node))
				const isFocused = isFocusedNode(node, activeTurn)
				const isHover = hover !== null && hover.node === node
				const size = node.kind === 'empty' ? dotSize + 2 : dotSize
				// ⚠️ 点上**不再**挂 onMouseEnter。换目标一律走容器那一个 mousemove 做 hover intent，
				//    否则赶路途中压过的每个点都会抢走卡片 —— ＋ 就永远够不着（DESIGN.md §6）。
				const go = () => (node.entry === undefined ? api.open(node.session.id) : api.jump(jumpTarget(node, current), node.entry.turn, node.entry.seq))
				parts.push(h('span', {
					key: `d${node.key}`,
					style: Object.assign({ position: 'absolute', left: `${x - size / 2}px`, top: `${y - size / 2}px`, cursor: 'pointer' }, dotStyle(node.kind, node.active, isHover, size, isFocused)),
					onClick: go,
				}))
				// 透明加宽命中区：点很小，直接点很难中
				parts.push(h('span', {
					key: `hit${node.key}`,
					style: { position: 'absolute', left: `${x - z.hit / 2}px`, top: `${y - rowH / 2}px`, width: `${z.hit}px`, height: `${rowH}px`, cursor: 'pointer' },
					onClick: go,
				}))
			}

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
						onDetach: (node) => {
							const at = cutPointOf(node)
							if (at !== undefined) reshape({ session: at.key, detach: true })
						},
						railWidth, labels, hold, release,
						onRename: (key, value) => { writeLabel(key, value); setTick((value2) => value2 + 1) },
						onFork: (node) => {
							const action = branchAction(node)
							if (action === 'none') return undefined
							if (action === 'fresh') return api.fresh(workspaceOf(workspaceState, node.session.id), node.session.cwd, treeOf(new Map(picked.map((item) => [item.id, item])), shape.groupOf, current))
							if (action === 'open') return api.open(node.session.id)
							return api.fork(node.session.id, node.entry.seq)
						},
					}),
				),
			)
			return typeof document === 'undefined' ? null : portal(shell, document.body)
		}

		// ===== 第 7 步：apply =====

		const inject = ['slots', 'sessions', 'workspaces']

		/**
		 * 插件体。所有写操作都是转调宿主 API。
		 * @param ctx - 浏览器根 context
		 */
		function apply(ctx) {
			const api = {
				list: ctx.sessions.list,
				workspaces: ctx.workspaces.list,
				open: (id) => {
					try {
						ctx.sessions.open(id)
					} catch (error) {
						console.warn('[dsh-tree] open failed', error)
					}
				},
				jump: async (id, turn, seq) => {
					try {
						ctx.sessions.open(id)
						const binding = ctx.sessions.binding(id)
						if (binding && binding.session && typeof binding.session.loadThrough === 'function') {
							await binding.session.loadThrough(seq)
						}
						await new Promise((resolve) => setTimeout(resolve, 60))
						const row = document.querySelector(`[data-chat-turn="${turn}"]`)
						if (row && typeof row.scrollIntoView === 'function') row.scrollIntoView({ block: 'start', behavior: 'smooth' })
					} catch (error) {
						console.warn('[dsh-tree] jump failed', error)
					}
				},
				/**
				 * 在某一轮之后开岔路。**故意只有一行有效逻辑** —— 原生 fork 的两个缺陷
				 * 由 host 半在 `agent/created` 里接管，在这儿补会被原生分支按钮绕过。
				 */
				fork: async (id, atSeq) => {
					try {
						ctx.sessions.open(await ctx.sessions.fork({ sessionId: id, atSeq, increaseTitle: true }))
					} catch (error) {
						console.warn('[dsh-tree] fork failed', error)
					}
				},
				// ⚠️ 新会话归到哪个工作区看的是 `workspaceId`，**不是 cwd**：侧栏按
				//    workspace.sessionIds 这张显式成员表分组，只传 cwd 建出来的会话谁都不认领，
				//    于是掉进"未分组"。宿主自己的新建按钮就是 create({ workspaceId })。
				//    查不到归属时才退回 cwd（至少工作目录是对的）。
				fresh: (workspaceId, cwd, tree) => {
					ctx.sessions
						.create(workspaceId ? { workspaceId } : cwd ? { cwd } : {})
						.then(async (id) => {
							// 登记进当前这棵树 —— 这是"空节点底下能有好几条对话"的唯一来源。
							// dsh 不给新建会话任何父子关系，不自己记就永远各自成树。
							if (tree) await api.reshape({ session: id, group: tree })
							return ctx.sessions.open(id)
						})
						.catch((error) => console.warn('[dsh-tree] create failed', error))
				},
				/**
				 * 改树形关系（登记分组 / 分离）。写 host 半的 shape.json。
				 * @param patch - `{session, group?, detach?}`
				 */
				reshape: (patch) =>
					fetch('/plugins/dsh-tree/shape', {
						method: 'POST',
						credentials: 'same-origin',
						headers: { 'content-type': 'application/json' },
						body: JSON.stringify(patch),
					})
						.then((response) => (response.ok ? response.json() : Promise.reject(new Error(String(response.status)))))
						.catch((error) => console.warn('[dsh-tree] reshape failed', error)),
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
				console.warn('[dsh-tree] 设置卡片注册失败', error)
			}
		}

		exports.apply = apply
		exports.inject = inject
		// 纯函数出口，仅供离线测试（cordis 只读 apply/inject）
		exports.__pure = { visibleTree, conversationOf, treeOf, cutPointOf, cutSet, buildGraph, branchAction, jumpTarget, isFocusedNode, edgeOrder, nodeAt, hoverNext, workspaceOf, dotStyle, elide, anchorNode, settingsStore, stepText, scaleText, scaleZ, STEPS, SCALES, RADIUS, SCALE, FIELDS, Z }
		return module.exports
	},
})
