/**
 * 树本体：把 graph + elide 的结果画成一条贴着聊天区右缘的导轨。
 */
import { h, portal, react } from './runtime.js'
import { C, SCALE, Z } from './const.js'
import { warn } from './net.js'
import { readFavColors, readFavIcons, readFavorites, readLabels, writeFavColor, writeFavIcon, writeFavorite, writeLabel } from './labels.js'
import { branchAction, conversationOf, cutPointOf, cutSet, forkBlockedWhy, isFocusedNode, jumpTarget, mergeTargets, shapeOps, treeOfSession, visibleTree, workspaceOf } from './tree.js'
import { buildGraph } from './graph.js'
import { installDiagnostics } from './diagnose.js'
import { anchorNode, elide, fisheye } from './elide.js'
import { dashedOf, dotInside, dotSizeOf, dotStyle, drawnWidth, fade, favShape, inkOf, shapeOf, starSkin } from './shapes.js'
import { cardAnchor, edgeOrder, hoverNext, nodeAt, railLayout, railRight, railRoom, reachFor, segments, trimRuns } from './geometry.js'
import { RAIL_MARK, STAR_ANIM_MS, hideNativeRail, installStarAnimation, isRewindPending, starAnimation, useActiveTurn, useChatBox, useObservable, useOutlines } from './hooks.js'
import { useColorScheme } from './theme.js'
import { TAPPABLE, overRail, tapNext, useHover } from './pointer.js'
import { themeFrom, visibleRange } from './settings-model.js'
import { Detail } from './ui-detail.js'

/** ⏳ 那句解释。title 和触摸设备上戳开的浮层是同一份，别让它们各写一遍。 */
export const REWIND_TIP = '这条会话正在跑，暂时读不了它的撤回记录 —— 读那个文件会打断正在跑的这一轮。\n树上画的是上一次读到的状态，撤回过的轮次可能还画着。这一轮跑完会自动更正。'

/** 树本体。 */
export function Rail(props) {
	const api = (props && props.api) || {}
	const listState = useObservable(api.list)
	const workspaceState = useObservable(api.workspaces)
	const box = useChatBox()
	const activeTurn = useActiveTurn()
	const settings = useObservable(api.settings) || {}
	const dark = useColorScheme()
	// 这块屏能不能悬停。能 → 原样走 hover intent；不能（iPad / iPhone / 触摸屏本）
	// → 换成"点一下开卡片，再点一下才跳"。判据和切换时机见 pointer.js。
	const canHover = useHover()
	const tuned = settings.values || {}
	// 画多大一片：量法（按层数 / 按步数）+ 上限，兜底也在里面，见 visibleRange
	const range = visibleRange(tuned)
	// 主题：每个字段各自回退，缺一项不影响其他项
	// 没改过的颜色跟着配色方案 + 明暗走，改过的钉死（见 themeFrom）
	const theme = themeFrom(tuned, settings.user, dark)
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
	// 收藏清单和改名共用一个 `tick`：两者都存在 localStorage，都只在用户点了之后才变，
	// 各自开一个计数器只会让"点了收藏，名字也跟着重读一遍"这种无害的事看起来像 bug。
	const favorites = react.useMemo(() => readFavorites(), [tick])
	// 每个收藏点自己挑的图标（没挑过的不在里面，画默认的五角星）。
	// 跟着同一个 `tick` 重读，理由同上。
	const favIcons = react.useMemo(() => readFavIcons(), [tick])
	// 每个收藏点自己挑的颜色（没改过的不在里面，画默认的那个黄）。同一个 `tick`，理由同上。
	const favColors = react.useMemo(() => readFavColors(), [tick])
	// 刚被点的那颗星，用来播一次性动画（见 hooks.js 的 starAnimation）
	const [flash, setFlash] = react.useState(null)

	// 换悬停目标用 hover intent：卡片开着时，鼠标**停下来**才换目标，一直在动就什么都不抢。
	// 这样从点走到卡片上的 ＋ 全程安全 —— 赶路途中压过多少个点都无所谓。
	const restTimer = react.useRef(0)

	const closeTimer = react.useRef(0)
	// 鼠标此刻真正在哪。关卡片前拿它复核一次 —— 见下面 release 那段。
	const pointer = react.useRef(null)
	// 导轨最外层。触摸设备判"戳到外面了吗"和上面那次复核都要用它。
	const shellRef = react.useRef(null)
	// 卡片自己说"现在锁住"（名字改了还没定夺）。锁住期间**既不关也不换点** ——
	// 手一滑划过别的点就把刚敲的名字吞掉，是最气人的那种 bug。
	// 用 ref 不用 state：release 是个 useCallback([])，state 会让它一直拿到旧值。
	const locked = react.useRef(false)
	// 同理：release 是个 useCallback([])，直接闭包 canHover 会永远拿到第一帧那个值。
	const hoverable = react.useRef(true)
	hoverable.current = canHover
	const onLock = react.useCallback((value) => { locked.current = value === true }, [])
	// 「按住」= 别关卡片，**也别换目标**。
	//
	// ⚠️ restTimer 这一下是后补的，别删。卡片如今贴着点放（见 cardAnchor），会压在
	//    导轨的横向范围里；而卡片是**导轨那个 div 的子元素**，它上面的 mousemove 会
	//    冒泡到下面那个 hover intent。鼠标从点走向卡片的最后一下 mousemove 已经把
	//    restTimer 按 restMs 起了表，指针随后进了卡片就再没有 mousemove 来撤它 ——
	//    表照响，hover 换到别的点，**卡片从指针底下挪走**，这一下就点到了底下那个点。
	//    John 报的原话是"鼠标已经在卡片上了，结果点到了卡片下的另一个结点，永远点不到卡片"。
	//    卡片那边还配了一条 onMouseMove 阻止冒泡，两条缺一不可：那条管住"进去之后"，
	//    这条管住"进去之前已经起了的表"。
	const hold = react.useCallback(() => {
		clearTimeout(closeTimer.current)
		clearTimeout(restTimer.current)
	}, [])
	const release = react.useCallback(() => {
		if (locked.current) return
		// ⚠️ 触摸设备上这条**整个不能跑**。手指没有"移开"这个状态，可 iOS 在别处一戳
		//    会补发一串合成鼠标事件（含 mouseleave），计时器一旦起来，卡片会在手指
		//    还没够到 ＋ 的时候自己关掉。那边的关法是下面那个"戳到导轨外面去"。
		if (!hoverable.current) return
		clearTimeout(closeTimer.current)
		// ⚠️ 到点了**先复核鼠标到底在不在导轨上**，别一见 mouseleave 就关。
		//
		//    症状（John 报的）：卡片展开着，点一下"取消收藏"，卡片自己收起来了，有时还不收。
		//    原因：那一下会改版式 —— 收藏图标那排整个消失、导轨宽度也跟着变，
		//    而卡片是 translateY(-50%) 竖直居中的，变矮就意味着**内容在鼠标底下挪走了**。
		//    鼠标一动没动，浏览器照样派一个 mouseleave 过来，老写法当场起表、280ms 后关掉。
		//    这一类"自己点自己引发的布局跳动"在改图标、改颜色、拆支线时全都会发生。
		//
		//    复核要等到计时器到点再做：点击那一帧版式还没落定，当场量到的是旧的。
		//    还在导轨上就**接着等**（自己续一次表）—— 这样鼠标真走的时候照样关得掉，
		//    不会因为漏了一次 mouseleave 就永远挂在那儿。
		const tick = () => {
			if (locked.current) return
			if (overRail(shellRef.current, pointer.current)) {
				closeTimer.current = setTimeout(tick, 280)
				return
			}
			setHover(null)
		}
		closeTimer.current = setTimeout(tick, 280)
	}, [])
	// 只记鼠标位置，不做别的。被动监听，整页一个。
	react.useEffect(() => {
		if (typeof document === 'undefined') return undefined
		const track = (event) => { pointer.current = { x: event.clientX, y: event.clientY } }
		document.addEventListener('mousemove', track, { passive: true, capture: true })
		return () => document.removeEventListener('mousemove', track, true)
	}, [])
	react.useEffect(() => () => clearTimeout(closeTimer.current), [])
	react.useEffect(() => hideNativeRail(), [])
	react.useEffect(() => installStarAnimation(), [])
	// 动画只播一次：播完把标记摘掉，否则这颗星每重画一次就重播一次
	react.useEffect(() => {
		if (flash === null) return undefined
		const timer = setTimeout(() => setFlash(null), STAR_ANIM_MS)
		return () => clearTimeout(timer)
	}, [flash])
	react.useEffect(() => () => clearTimeout(restTimer.current), [])

	// 触摸设备上卡片怎么关：戳导轨以外的任何地方。
	// （鼠标那边靠 onMouseLeave + 280ms 计时器，手指上没有对应的东西。）
	// 锁住时不关 —— 名字改了还没定夺，和 release 一个规矩。
	react.useEffect(() => {
		if (canHover || typeof document === 'undefined') return undefined
		const away = (event) => {
			if (locked.current) return
			const shell = shellRef.current
			if (shell && typeof shell.contains === 'function' && shell.contains(event.target)) return
			clearTimeout(closeTimer.current)
			setHover(null)
		}
		// 捕获阶段：卡片里的按钮会 stopPropagation，冒泡阶段收不到。
		document.addEventListener('pointerdown', away, true)
		return () => document.removeEventListener('pointerdown', away, true)
	}, [canHover])
	// ⏳ 的说明在 title 里，而 title 在触摸设备上永远不会出现 —— 戳一下摊开。
	const [tip, setTip] = react.useState(false)

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

	// 省略太远的节点。上限 = 0 时 elide 全留，下面这一整套退化成原来的画法。
	// 放在自诊断钩子前面，好让钩子能把"到底省了几个"一起倒出来。
	const view = elide(graph.nodes, anchorNode(graph.nodes, activeTurn), range.limit, range.mode)
	const rowOfNode = (node) => view.rowOf.get(node.depth)

	// 自诊断钩子：症状出现时在浏览器控制台敲 __dshTree() 就能把当时的真实状态倒出来。
	// 加这个是因为"某些点莫名变白"这类问题光看代码猜不出来，
	// 而每猜错一轮都要 John 重启一次。
	installDiagnostics({
		current, cwd, activeTurn, view, scale, tuned, settings, picked, archived,
		radiusText: `${range.text}（${range.spec.label}）`,
		nodes: graph.nodes,
		sessionCount: (listState.ids || []).length,
	})

	// 这棵树上画出来最宽的那个形状占多少像素 —— 列距按它留（见 railLayout）。
	// ⚠️ 扫的是**整棵树**，不是这一屏画出来的那几个。只扫可见的话，一颗星星滚进
	//    省略窗口、又滚出去，导轨就会跟着变宽变窄 —— 和 maxColumn 用整棵树是同一条理由。
	// ⚠️ 鱼眼的缩放不算进来：它只会把点画小，撑宽列的永远是没被淡化的那个。
	const widestOf = (size) => {
		let most = 0
		for (const node of graph.nodes) {
			const star = favorites.has(node.key) ? favShape(favIcons[node.key]) : undefined
			const shape = star === undefined ? shapeOf(node.kind, node.active, theme) : star
			most = Math.max(most, drawnWidth(shape, dotSizeOf(node.kind, size, 1)))
		}
		return most
	}
	const { z, available, rowH, treeHeight, railWidth, lane, dotSize, xOf, yOf } = railLayout(box, scale, view.rows, graph.maxColumn, widestOf, railRoom(box))
	// 命中区宽度。列被宽形状撑开时得跟着撑，否则两列之间会裂出一条点不中的缝。
	// 反过来列距比 Z.hit 窄时**不收窄** —— 命中区互相重叠是故意的（点太小，靠 nodeAt 取最近的那个）。
	const hitW = Math.max(z.hit, lane)

	const parts = []

	// 先铺线。跨列的折角**必须先横后竖**：反过来的话从节点 2 岔到 4 的竖线
	// 会一路压过节点 3 再拐弯，看着像"经过 3 转个弯到 4"。
	const bar = (part, key) => h('span', {
		key,
		style: { position: 'absolute', left: `${part.left}px`, top: `${part.top}px`, width: `${part.width}px`, height: `${part.height}px`, background: part.color, opacity: part.alpha },
	})
	// ⚠️ 横段**先攒着**，等所有边都算完再交给 trimRuns 去重。
	//    同一个父节点的几个孩子，横段是一组同心嵌套的线段，靠父节点那一截会被画 N 遍 ——
	//    每层各带一个 opacity，叠出来就比别处黑，看着就是"横线一会粗一会细还上下起伏"
	//    （John 报的）。竖段各在各的列上，不会撞，直接画。
	const runs = []
	const line = (key, xFrom, xTo, yFrom, yTo, color, gapFrom, gapTo, alpha, active) => {
		const cut = segments(xFrom, xTo, yFrom, yTo, gapFrom, gapTo)
		for (const part of cut) {
			const piece = Object.assign({ key, color, alpha, active }, part)
			if (part.tag === 'hz') runs.push(piece)
			else parts.push(bar(piece, `${part.tag}${key}`))
		}
	}

	// 鱼眼：越靠近半径边界的点画得越小越淡
	const eyeOf = (node) => fisheye(view.dimOf.get(node))
	// 收藏的图标可换，所以让位量得按**它实际挑的那个形状**算，不能一律按五角星。
	// 挑了个十字（1.11 倍）却按星星（1.67 倍）让位，连线会在点外面凭空断一截。
	const starOf = (node) => (favorites.has(node.key) ? favShape(favIcons[node.key]) : false)
	const reachOf = (node) => reachFor(node.kind, node.active, dotSize, theme, eyeOf(node).scale, starOf(node))

	const edge = (node) => {
		// 两头都在才连。只剩一头的那条边整个不画 —— 鱼眼的收尾靠点自己淡掉，
		// 再拖一截"通向空处"的线出来反而是个新的硬边界。
		if (!view.shown.has(node) || !view.shown.has(node.parent)) return
		const color = node.active ? fade(theme.currentColor, 0.6) : C.line
		// 线按**淡的那一头**走：亮点连着淡点时，线跟着亮会显得那个淡点还没退场
		const alpha = Math.min(eyeOf(node).alpha, eyeOf(node.parent).alpha)
		line(node.key, xOf(node.parent.column), xOf(node.column), yOf(rowOfNode(node.parent)), yOf(rowOfNode(node)), color, reachOf(node.parent), reachOf(node), alpha, node.active === true)
	}
	for (const node of edgeOrder(graph.nodes)) edge(node)
	// 去重之后再画。出来的横段互不重叠，所以 DOM 先后不再影响观感。
	for (const run of trimRuns(runs)) parts.push(bar(run, `hz${run.key}~${run.part}`))

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
		const jump = () => (node.entry === undefined ? api.open(node.session.id) : api.jump(jumpTarget(node, current), node.entry.turn, node.entry.seq))
		// 能悬停的机器上点一下就跳，和原来一模一样。手指上要两下：第一下把卡片开在
		// 这个点上（＋ / ☆ / 改名这些只在卡片里，不先开出来就永远够不着），
		// 第二下戳同一个点才真的跳过去 —— 规矩见 pointer.js 的 tapNext。
		const go = () => {
			if (canHover || tapNext(hover === null ? null : hover.node, node) === 'go') return jump()
			clearTimeout(restTimer.current)
			clearTimeout(closeTimer.current)
			setHover({ node, y })
			return undefined
		}
		// 收藏过的点整个换成黄色五角星。收藏和"角色"（普通/当前/压缩/空）正交，
		// 所以这里是**盖在上面**的一层：形状和颜色都让给 star，别的一概不动。
		const star = favorites.has(node.key) ? starSkin(isFocused, dark, favIcons[node.key], favColors[node.key], theme) : undefined
		// 三角这类多边形、以及自定义的字，方框画不出来，得往里放东西
		const shape = star === undefined ? shapeOf(node.kind, node.active, theme) : star.shape
		const skin = star === undefined ? inkOf(node.kind, node.active, isFocused, theme, dark) : star
		parts.push(h('span', {
			key: `d${node.key}`,
			style: Object.assign(
				{ position: 'absolute', left: `${x - size / 2}px`, top: `${y - size / 2}px`, cursor: 'pointer' },
				TAPPABLE,
				dotStyle(node.kind, node.active, isHover, size, isFocused, theme, alpha, star, dark),
				// ⚠️ 这个键**每一帧都要在**（哪怕是 'none'）。只在播动画那一帧才加的话，
				//    下一帧 React 会把它当"属性没了"清空，而清空和赋 none 的时机差一帧，
				//    星星会抖一下（DESIGN.md §5 那条"key 集合必须恒定"的同一个坑）。
				{ animation: starAnimation(flash, node.key) },
			),
			onClick: go,
		}, dotInside(shape, size, skin, (1.5 * size) / Z.dot, star === undefined && dashedOf(node.kind))))
		// 透明加宽命中区：点很小，直接点很难中
		parts.push(h('span', {
			key: `hit${node.key}`,
			style: Object.assign({ position: 'absolute', left: `${x - hitW / 2}px`, top: `${y - rowH / 2}px`, width: `${hitW}px`, height: `${rowH}px`, cursor: 'pointer' }, TAPPABLE),
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
	// 贴着聊天区右缘。空间不够是靠上面压列距解决的（railRoom），不是靠挪位置。
	const right = railRight(box, railWidth, window.innerWidth)
	const height = available

	const shell = h(
		'div',
		{
			// 这个记号只有一个用处：`isCovered` 打探针时认出"压在上面的是我自己"，
			// 否则导轨一压到探针上就会把自己判成被遮挡，然后来回闪。
			// ⚠️ 这个 ref **一定要挂上**。触摸设备上「戳到导轨外面去才关卡片」那条靠它认边界，
			//    ref 为 null 时那个判断整条落空，等于戳哪儿都算外面 —— 卡片上的 ＋ 永远按不出结果。
			ref: shellRef,
			[RAIL_MARK]: '1',
			style: { position: 'fixed', top: `${top}px`, height: `${height}px`, right: `${right}px`, width: `${railWidth}px`, zIndex: 40, pointerEvents: 'none' },
			onMouseLeave: release,
		},
		// ⏳：这条会话正跑着，撤回记录这一轮读不了（读它会打断那一轮，见 src/host/rewind.js）。
		// 不说一声的话，撤回完紧接着发的那一轮树上画的还是撤回前的形状，看着就是"这插件又坏了"。
		// 放在导轨上沿那 16px 空当里，不压到任何一个点；小、淡、鼠标停上去才解释。
		!isRewindPending(outlines) ? null : h('span', {
			key: 'rewind-pending',
			title: REWIND_TIP,
			style: Object.assign({
				position: 'absolute', top: '-13px', right: '0px',
				fontSize: '10px', lineHeight: '12px', color: C.muted,
				pointerEvents: 'auto', cursor: 'help',
			}, TAPPABLE),
			// ⚠️ 这行字只写在 title 里，而 **title 在触摸设备上永远不会出现** ——
			//    手指上没有"停在上面"这个状态。于是 iPad 用户看到的就是一个不明所以的
			//    ⏳ 加一棵画着旧形状的树，正是这条提示要避免的那种"这插件又坏了"。
			//    能悬停的机器上不挂 onClick：那边 title 已经够了，多一个点开的浮层只会碍事。
			onClick: canHover ? undefined : () => setTip((was) => !was),
		}, [
			// ⚠️ 那 0.55 的透明度只能压在这个字上，**不能留在外面那层**：
			//    opacity 对子元素是连乘的，压在外层的话戳开的说明也跟着半透明，
			//    小字加半透明，正是这条提示最不该长成的样子。
			h('span', { key: 'g', style: { opacity: 0.55 } }, '⏳'),
			!tip || canHover ? null : h('div', {
				key: 'tip',
				style: {
					position: 'absolute', top: '16px', right: '0px', width: `${Z.card}px`, maxWidth: '70vw',
					background: C.card, color: C.text, border: `1px solid ${C.line}`, borderRadius: '7px',
					boxShadow: '0 6px 20px rgba(0,0,0,.45)', padding: '6px 8px',
					font: '11.5px/1.5 -apple-system,"Segoe UI","PingFang SC",sans-serif',
					whiteSpace: 'pre-wrap', opacity: 1, zIndex: 1,
				},
			}, REWIND_TIP),
		]),
		h(
			'div',
			{
				style: { position: 'absolute', right: 0, top: `${Math.max(0, (height - treeHeight) / 2)}px`, width: `${railWidth}px`, height: `${treeHeight}px`, pointerEvents: 'auto' },
				// hover intent：整条导轨只有这一个 mousemove 在做命中。
				//   · 还没开卡片 → 碰到点就立刻开（要跟手）
				//   · 已经开着  → 每次移动都把计时器清掉；只有**停住** restMs 才换目标
				// 所以从点走到卡片上的 ＋ 全程不会被抢：只要手还在动，谁都抢不走。
				onMouseMove: (event) => {
					// ⚠️ 触摸设备上这个 handler 必须整个歇着。iOS 为了兼容老页面，会在每次
					//    点击**之前合成一个 mousemove**；它会当场把卡片开在被戳的那个点上，
					//    紧接着的 click 一看"卡片已经停在我身上"就直接跳走了 ——
					//    两下点的规矩当场作废，等于什么都没改。
					if (!canHover) return
					// 卡片锁住时谁都别想换点，但计时器还是要按住（不然它自己会关）
					if (locked.current) return hold()
					const rect = event.currentTarget.getBoundingClientRect()
					const at = nodeAt(seats, event.clientX - rect.left, event.clientY - rect.top, hitW, rowH)
					hold()   // 连"换目标"的表一起撤（见上面 hold 的注释）
					const want = hoverNext(hover === null ? null : hover.node, at)
					if (want === 'keep') return
					// ⚠️ x 也要记：详情卡锚在**这个点**上，不是锚在整条导轨的左缘（见 cardAnchor）
					const seat = () => setHover({ node: at, x: xOf(at.column), y: yOf(rowOfNode(at)) })
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
				// 卡片贴着那个点放，不贴整棵树的左边 —— 岔路一多，主干那列的卡片会被甩出去老远
				anchor: hover ? cardAnchor(railWidth, hover.x, hitW) : railWidth + 4,
				railWidth, labels, hold, release, onLock,
				favorites, favIcons, favColors,
				// 卡片上那颗 ☆ 用**这个点自己的**颜色，不是全局那个黄 ——
				// 不然改完颜色，树上变了、卡片上没变，看着像没生效。
				starInk: starSkin(false, dark, undefined, hover === null ? undefined : favColors[hover.node.key], theme).ink,
				// 色板里「恢复默认」那一格画的就是它 —— 不给的话那一格是个看不出颜色的空圈
				defaultInk: starSkin(false, dark, undefined, undefined, theme).ink,
				onRename: (key, value) => { writeLabel(key, value); setTick((value2) => value2 + 1) },
				onFavorite: (key, on) => {
					writeFavorite(key, on)
					setFlash({ key, on })
					setTick((value2) => value2 + 1)
				},
				onFavIcon: (key, want) => {
					writeFavIcon(key, want)
					setTick((value2) => value2 + 1)
				},
				onFavColor: (key, want) => {
					writeFavColor(key, want)
					setTick((value2) => value2 + 1)
				},
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
