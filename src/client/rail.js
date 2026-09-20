/**
 * 树本体：把 graph + elide 的结果画成一条贴着聊天区右缘的导轨。
 */
import { h, portal, react } from './runtime.js'
import { C, RADIUS, SCALE, Z } from './const.js'
import { warn } from './net.js'
import { readLabels, writeLabel } from './labels.js'
import { branchAction, conversationOf, cutPointOf, cutSet, forkBlockedWhy, isFocusedNode, jumpTarget, mergeTargets, shapeOps, treeOfSession, visibleTree, workspaceOf } from './tree.js'
import { buildGraph } from './graph.js'
import { installDiagnostics } from './diagnose.js'
import { anchorNode, elide, fisheye } from './elide.js'
import { dashedOf, dotInside, dotSizeOf, dotStyle, fade, inkOf, shapeOf } from './shapes.js'
import { edgeOrder, hoverNext, nodeAt, railLayout, reachFor, segments } from './geometry.js'
import { hideNativeRail, isRewindPending, useActiveTurn, useChatBox, useObservable, useOutlines } from './hooks.js'
import { FIELDS } from './settings-model.js'
import { Detail } from './ui-detail.js'

/** 树本体。 */
export function Rail(props) {
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
					// 按钮那边已经灰掉了，这里再挡一次：键盘、脚本、以后加的别的入口都走这条路
					if (forkBlockedWhy(node) !== '') return undefined
					if (action === 'fresh') return api.fresh(workspaceOf(workspaceState, node.session.id), node.session.cwd, treeOfSession(picked, shape.groupOf, current))
					if (action === 'open') return api.open(node.session.id)
					return api.fork(node.session.id, node.entry.seq)
				},
			}),
		),
	)
	return typeof document === 'undefined' ? null : portal(shell, document.body)
}
