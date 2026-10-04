/**
 * 树本体：把 graph + elide 的结果画成一条贴着聊天区右缘的导轨。
 */
import { h, portal, react } from './runtime.js'
import { C, SCALE, Z } from './const.js'
import { warn } from './net.js'
import { readFavColors, readFavIcons, readFavorites, readLabels, writeFavColor, writeFavIcon, writeFavorite, writeLabel } from './labels.js'
import { branchAction, conversationOf, currentOf, cutPointOf, cutSet, escapeFrom, forkBlockedWhy, forkCutSeq, isFocusedNode, isRootKey, jumpTarget, mergeTargets, shapeOps, treeOfSession, visibleTree, withStatus, workspaceOf } from './tree.js'
import { buildGraph } from './graph.js'
import { installDiagnostics } from './diagnose.js'
import { anchorNode, elide, fisheye } from './elide.js'
import { GLYPH_RADIUS, dashedOf, dotInside, dotSizeOf, dotStyle, drawnWidth, fade, favShape, glyphSpanFor, inkOf, shapeHeight, shapeOf, starSkin } from './shapes.js'
import { boxShift, cardAnchor, edgeOrder, hoverNext, nodeAt, railLayout, railRight, railRoom, reachFor, rowSlots, segments, shrinkToLane, trimRuns } from './geometry.js'
import { RAIL_MARK, STAR_ANIM_MS, hideNativeRail, installStarAnimation, nextReadBoundary, readAnimation, readPhase, starAnimation, unpinActiveTurn, useActiveTurn, useChatBox, useObservable, useOutlines } from './hooks.js'
import { useColorScheme } from './theme.js'
import { foldReport, useSidebarFold } from './sidebar.js'
import { TAPPABLE, overRail, tapNext, useHover } from './pointer.js'
import { themeFrom, visibleRange } from './settings-model.js'
import { Detail } from './ui-detail.js'

/** 树本体。 */
export function Rail(props) {
	const api = (props && props.api) || {}
	const rawList = useObservable(api.list)
	// 0.2 宿主把"在跑 / 跑完未读"挪到了一张单独的状态表；并回列表项，下面全按老形状读（tree.js 的 withStatus）
	const statuses = useObservable(api.status)
	const listState = react.useMemo(() => withStatus(rawList, statuses), [rawList, statuses])
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
	const theme = themeFrom(tuned, settings.user)
	const scale = Number.isFinite(tuned.nodeScale) ? tuned.nodeScale : SCALE.fallback

	// 0.1.5 直接给 current，0.2 要从列表项的 retainedBy 里找（tree.js 的 currentOf）
	const current = currentOf(listState)
	const cwd = current && listState.byId[current] ? listState.byId[current].cwd : undefined
	// 点击跳转钉住的那一轮只在本会话里有意义：换了会话就解钉。
	// （jump 自己也会换会话：它是 open 之后隔了 loadThrough + 60ms 才钉，这条效果早就跑完了，不会把它解掉。）
	react.useEffect(() => unpinActiveTurn(), [current])
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
	// 标注随 tick（本地改了）和 outlines（宿主那份到了）刷新
	const labels = react.useMemo(() => readLabels(), [tick, outlines])
	// 收藏清单和改名共用一个 `tick`：两者都存在 localStorage，都只在用户点了之后才变，
	// 各自开一个计数器只会让"点了收藏，名字也跟着重读一遍"这种无害的事看起来像 bug。
	const favorites = react.useMemo(() => readFavorites(), [tick, outlines])
	// 每个收藏点自己挑的图标（没挑过的不在里面，画默认的五角星）。
	// 跟着同一个 `tick` 重读，理由同上。
	const favIcons = react.useMemo(() => readFavIcons(), [tick, outlines])
	// 每个收藏点自己挑的颜色（没改过的不在里面，画默认的那个黄）。同一个 `tick`，理由同上。
	const favColors = react.useMemo(() => readFavColors(), [tick, outlines])
	// 刚被点的那颗星，用来播一次性动画（见 hooks.js 的 starAnimation）
	const [flash, setFlash] = react.useState(null)
	// 未读节点读过之后的三段式（hooks.js 的 readPhase）：上一帧哪些点是未读、哪些点什么时候变成了读过。
	// 都是 ref：这是"这一帧和上一帧比"的账，不该触发重画；到点重画由下面那个定时器管。
	const wasUnread = react.useRef(new Set())
	const readAt = react.useRef(new Map())
	const [readTick, setReadTick] = react.useState(0)
	// 到下一个段落边界就重画一次（hold → fade → melt → done）。每次渲染都重算一遍
	// 离边界还有多久，所以别的原因引起的重画不会把节奏打乱。
	react.useEffect(() => {
		const wait = nextReadBoundary(readAt.current, Date.now())
		if (wait === undefined) return undefined
		const timer = setTimeout(() => setReadTick((value) => value + 1), wait)
		return () => clearTimeout(timer)
	})

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

	// 左侧会话列表按对话树折叠（sidebar.js）。放在下面那个早退**之前**：
	// 不在会话界面（设置页 / 全局面板）时左边的列表照样在，照样要折。
	// shape 用 Rail 手里的（改树形的回显也在里面）；还没开任何会话时它是 undefined，钩子自己拉。
	useSidebarFold(listState, echo || (outlines && outlines.shape) || undefined, tuned.sidebarFold !== false, (workspaceState && workspaceState.archivedSessionIds) || [])

	// 导轨现在是全局常驻的（shell.overlay），所以必须自己判断"该不该露面"：
	// 量不到聊天区 = 用户不在会话界面（设置页/全局面板），收起来。
	// 组件本身不卸载，hover / box / 上一棵树都还在，切回来是瞬时的。
	if (!listState || !current || box === undefined) return null

	// 可见集 = 会话列表 减去 归档集（归档的会话仍留在 sessions.list 里，必须显式扣）
	const archived = new Set((workspaceState && workspaceState.archivedSessionIds) || [])
	const visible = new Set((listState.ids || []).filter((id) => !archived.has(id)))
	if (!visible.has(current)) visible.add(current)

	const shape = echo || (outlines && outlines.shape) || {}
	// ⚠️ 手里这份大纲是不是**这个目录**的。切到别的目录后、新数据到之前，`outlines` 还是上一个
	//    目录的（useOutlines 拉取期间保留旧数据，图才不闪空）——那份里当然找不到当前会话，
	//    不能拿它当"当前会话没有轮次"，更不能拿它建图。
	const fresh = outlines !== undefined && outlines.cwd === cwd
	const picked = fresh ? conversationOf(visibleTree(outlines.sessions || [], visible), current, shape.groupOf) : []

	// ⚠️ 新分支会先出现在会话列表里、后出现在 /outlines 里（拉取有 120ms 防抖），
	//    这中间 picked 是空的。直接 return null 会让整条导轨**整个消失再冒出来**，
	//    比"颜色晚 100ms 更新"难看得多 —— 所以拿上一棵树顶着，数据到了自然换掉。
	//    但只许拿**同一个目录**的上一棵顶：切到别的目录（另一组对话）还顶着旧树，就是
	//    John 报的"完全是另一组对话了，树还显示着原来的那颗"。而且拉取**出了错**也不许顶 ——
	//    顶着的话错误被整棵旧树盖住，看起来像树卡住了，其实是 host 那边一直在报错。
	// 「跑完了你没在看」是宿主会话列表上的事（completed），大纲里没有 —— 建图前抄一份过去，
	// graph.js 据此把那条分支的最后一轮标成未读（绿点）。
	// 「在跑」host 的大纲里有一份（collect.js），但 0.2 宿主的实时状态在会话列表那张表上（withStatus 并进去的）——
	// 两边取或，开岔路要不要拦、删除要不要带 stopActivity 看的都是它。
	const marked = picked.map((item) => Object.assign({}, item, {
		completed: (listState.byId[item.id] || {}).completed === true,
		running: item.running === true || (listState.byId[item.id] || {}).running === true,
	}))
	let graph
	try {
		graph = picked.length > 0 ? buildGraph(marked, current, cutSet(shape.detached, picked), shape.adopted, treeOfSession(picked, shape.groupOf, current)) : undefined
	} catch (error) {
		warn('建图失败，先拿上一棵顶着', error)
	}
	const failed = outlines !== undefined && outlines.error !== undefined
	if (graph !== undefined) lastGraph.current = { cwd, graph }
	else if (!failed && lastGraph.current !== undefined && lastGraph.current.cwd === cwd) graph = lastGraph.current.graph
	// 一棵树都没有、而且宿主那边报了错 → 说一声，别整条导轨静悄悄消失
	if (graph === undefined) {
		if (!failed) return null
		return h('div', {
			style: { position: 'fixed', right: '14px', top: `${box.top + Z.pad}px`, zIndex: 40, maxWidth: '220px', pointerEvents: 'none',
				font: '11px/1.5 -apple-system,"Segoe UI","PingFang SC",sans-serif', color: C.muted, whiteSpace: 'pre-wrap' },
		}, `对话树拉不到数据：${outlines.error}`)
	}

	// 【未读 → 读过】和上一帧比：上一帧还是 unread、这一帧成了 normal 的点，记下时刻。
	// 之后 READ_HOLD_MS 内照旧画成未读，再播一段"要变了"，最后颜色化成普通（见 hooks.js）。
	{
		const now = Date.now()
		const seen = new Set()
		for (const node of graph.nodes) {
			if (node.kind === 'unread') seen.add(node.key)
			else if (node.kind === 'normal' && wasUnread.current.has(node.key) && !readAt.current.has(node.key)) readAt.current.set(node.key, now)
		}
		wasUnread.current = seen
	}
	const phaseOf = (node) => (readAt.current.has(node.key) ? readPhase(readAt.current.get(node.key), Date.now()) : 'done')
	/** 这一帧该按什么角色画：读过没多久的仍按未读画。**画点的每一处都得用它**，别直接读 node.kind。 */
	const kindOf = (node) => {
		const phase = phaseOf(node)
		return phase === 'hold' || phase === 'fade' ? 'unread' : node.kind
	}
	void readTick // 只为让到点的那次 setReadTick 触发重画；值本身不用

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
		sidebar: foldReport,
	})

	// 这棵树上画出来最宽的那个形状占多少像素 —— 列距按它留（见 railLayout）。
	// ⚠️ 扫的是**整棵树**，不是这一屏画出来的那几个。只扫可见的话，一颗星星滚进
	//    省略窗口、又滚出去，导轨就会跟着变宽变窄 —— 和 maxColumn 用整棵树是同一条理由。
	// ⚠️ 鱼眼的缩放不算进来：它只会把点画小，撑宽列的永远是没被淡化的那个。
	const widestOf = (size) => {
		let most = 0
		for (const node of graph.nodes) {
			const star = favorites.has(node.key) ? favShape(favIcons[node.key]) : undefined
			const shape = star === undefined ? shapeOf(kindOf(node), node.active, theme) : star
			most = Math.max(most, drawnWidth(shape, dotSizeOf(kindOf(node), size, 1)))
		}
		return most
	}
	const room = railRoom(box)
	const { z, available, rowH, treeHeight, railWidth, lane, dotSize, xOf, yOf } = railLayout(box, scale, view.rows, graph.maxColumn, widestOf, room)
	// 列距被压过之后（横向放不下，见 railLayout 的 `room`），带框的字**按压完的列距重截**：
	// 框不许比列距宽，字装不下就少画几个加省略号。不这么做的话相邻两列的字框会叠在一起
	// （youli42 报的 issue #1）。布局那边（widestOf）仍按全宽算，空间够了列距自然会撑回去。
	// ⚠️ 这只是**不在这一屏上的字框**的退路；画出来的字框按下面 slotOf 给的那一行的空位截（T2）。
	const spanAt = (size) => glyphSpanFor(lane, z.laneGap, size)
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
	const line = (key, xFrom, xTo, yFrom, yTo, color, gapFrom, gapTo, alpha, active, sideFrom) => {
		const cut = segments(xFrom, xTo, yFrom, yTo, gapFrom, gapTo, sideFrom)
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
	// 极端压缩：列距压到比最窄的框 / 星星还窄时（railLayout 的下限只管圆点分得开），把整个
	// 形状**等比缩小**到塞得进列距，最小缩到一个普通圆点那么大 —— 这时它和圆点一样只剩
	// 两像素缝，但不再叠上隔壁列（issue #1 的极端情形）。没压时恒为 1，见 shrinkToLane。
	/** 这个点按什么形状画（`span` 只影响自定义字截到多宽）。 */
	const shapeAt = (node, span) => (favorites.has(node.key) ? favShape(favIcons[node.key], span) : shapeOf(kindOf(node), node.active, theme, span))
	/** 这一帧画多大（鱼眼缩过的直径）。 */
	const sizeOf = (node) => dotSizeOf(kindOf(node), dotSize, eyeOf(node).scale)

	// ===== 自定义字按"这一行"的空位摊开（BACKLOG T2，规则见 geometry.js 的 rowSlots）=====
	// 老规则按列距一刀切：列距一压，每个字框都只剩"列距 − 间隙"，2~4 个字全成「…」。
	// 这里把每一行当一条线段分给这一行上的节点：字框能向空着的格子借地方，
	// 但不压到同一行的邻居（圆点 / 星星原样留住自己那块）、不压到别人的岔路拐角。
	// 左边最远借到 railRoom 的边上（树没占满那条空当时，最左那列能往导轨外面借一点）。
	const slotOf = new Map()
	{
		const rows = new Map()
		const itemOf = new Map()
		for (const node of graph.nodes) {
			if (!view.shown.has(node)) continue
			const size = sizeOf(node)
			const base = shapeAt(node)
			const item = base.glyph !== undefined
				// 字框的核心：线从框的平边进出、不戳在圆角上
				? { glyph: true, x: xOf(node.column), core: shapeHeight(base, size) * GLYPH_RADIUS + 1, want: drawnWidth(base, size) }
				: { glyph: false, x: xOf(node.column), core: (drawnWidth(base, size) * shrinkToLane(drawnWidth(base, size), lane, z.laneGap, dotSize)) / 2 }
			item.coreL = item.core
			item.coreR = item.core
			if (item.want === undefined) item.want = 2 * item.core
			itemOf.set(node, item)
			const row = rowOfNode(node)
			if (!rows.has(row)) rows.set(row, [])
			rows.get(row).push(node)
		}
		// 自己的岔路拐角并进自己的核心：自己的框可以盖住它（线从框底下出去），邻居借不过来
		for (const node of graph.nodes) {
			const item = itemOf.get(node.parent)
			if (item === undefined || !itemOf.has(node) || node.column === node.parent.column) continue
			const corner = xOf(node.column)
			if (corner < item.x) item.coreL = Math.max(item.coreL, item.x - corner + 0.5)
			else item.coreR = Math.max(item.coreR, corner - item.x + 0.5)
		}
		const lo = Math.min(0, railWidth - room)
		for (const list of rows.values()) {
			if (!list.some((node) => itemOf.get(node).glyph)) continue // 这一行没有字框，一切照旧
			const slots = rowSlots(list.map((node) => itemOf.get(node)), lo, railWidth, z.laneGap)
			list.forEach((node, at) => {
				if (itemOf.get(node).glyph) slotOf.set(node, slots[at])
			})
		}
	}
	/** 字最多摊几倍宽：画在这一屏上的字框按它那一行的空位算，别的退回按列距算。 */
	const spanFor = (node, size) => {
		const slot = slotOf.get(node)
		return slot === undefined ? spanAt(size) : glyphSpanFor(slot.left + slot.right, 0, size)
	}
	const fitOf = (node, size) => {
		const wide = drawnWidth(shapeAt(node, spanFor(node, size)), size)
		const slot = slotOf.get(node)
		return slot === undefined ? shrinkToLane(wide, lane, z.laneGap, dotSize) : shrinkToLane(wide, slot.left + slot.right, 0, dotSize)
	}
	/** 字框画出来多宽、相对圆心往哪边挪了多少（不是字框 → undefined）。连线的横段要从框边起。 */
	const boxOf = (node) => {
		const slot = slotOf.get(node)
		if (slot === undefined) return undefined
		const size = sizeOf(node)
		const width = drawnWidth(shapeAt(node, spanFor(node, size)), size) * fitOf(node, size)
		return { width, shift: boxShift(width, slot.left, slot.right) }
	}
	const reachOf = (node) => {
		const eye = eyeOf(node)
		// 缩小过的形状，连线也要多连一截过去 —— 缩放走 `grow` 那个口子，和鱼眼是同一回事
		return reachFor(kindOf(node), node.active, dotSize, theme, eye.scale * fitOf(node, sizeOf(node)), starOf(node))
	}

	const edge = (node) => {
		// 两头都在才连。只剩一头的那条边整个不画 —— 鱼眼的收尾靠点自己淡掉，
		// 再拖一截"通向空处"的线出来反而是个新的硬边界。
		if (!view.shown.has(node) || !view.shown.has(node.parent)) return
		const color = node.active ? fade(theme.currentColor, 0.6) : C.line
		// 线按**淡的那一头**走：亮点连着淡点时，线跟着亮会显得那个淡点还没退场
		const alpha = Math.min(eyeOf(node).alpha, eyeOf(node.parent).alpha)
		const xFrom = xOf(node.parent.column)
		const xTo = xOf(node.column)
		// 父节点是个摊开的字框：横段从框朝孩子那一侧的边起（不然线从字中间穿过去）
		const owner = boxOf(node.parent)
		const side = owner === undefined ? undefined : owner.width / 2 + (xTo < xFrom ? -owner.shift : owner.shift) + 1
		line(node.key, xFrom, xTo, yOf(rowOfNode(node.parent)), yOf(rowOfNode(node)), color, reachOf(node.parent), reachOf(node), alpha, node.active === true, side)
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
		const size = dotSizeOf(kindOf(node), dotSize, eye.scale)
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
		const star = favorites.has(node.key) ? starSkin(isFocused, favIcons[node.key], favColors[node.key], theme, spanFor(node, size)) : undefined
		// 三角这类多边形、以及自定义的字，方框画不出来，得往里放东西
		const drawnShape = star === undefined ? shapeOf(kindOf(node), node.active, theme, spanFor(node, size)) : star.shape
		// 字框在自己那块地盘里可能不居中（贴着导轨右缘、或者邻居那边挤）：挪多少交给 glyphBoxStyle
		const placed = boxOf(node)
		const shape = placed === undefined || placed.shift === 0 ? drawnShape : Object.assign({}, drawnShape, { shift: placed.shift })
		const skin = star === undefined ? inkOf(kindOf(node), node.active, isFocused, theme) : star
		// 列距压到比这个形状还窄时等比缩小（见上面 fitOf）；没压时 drawn === size
		const drawn = size * fitOf(node, size)
		parts.push(h('span', {
			key: `d${node.key}`,
			style: Object.assign(
				{ position: 'absolute', left: `${x - drawn / 2}px`, top: `${y - drawn / 2}px`, cursor: 'pointer' },
				TAPPABLE,
				dotStyle(kindOf(node), node.active, isHover, drawn, isFocused, theme, alpha, star),
				// ⚠️ 这个键**每一帧都要在**（哪怕是 'none'）。只在播动画那一帧才加的话，
				//    下一帧 React 会把它当"属性没了"清空，而清空和赋 none 的时机差一帧，
				//    星星会抖一下（DESIGN.md §5 那条"key 集合必须恒定"的同一个坑）。
				//    收藏那一下的动画优先；没有的话看"读过之后要变了"那一段（readAnimation）。
				{ animation: starAnimation(flash, node.key) !== 'none' ? starAnimation(flash, node.key) : readAnimation(phaseOf(node), shape.poly !== undefined || shape.glyph !== undefined || shape.image !== undefined, shape.spin === true) },
				// melt 那一段：配色已经是普通的了，但让颜色化过去，别硬切。`transition` 本来就在 dotStyle 里，只是换值，key 集合不变。
				phaseOf(node) === 'melt' ? { transition: 'border-color .4s ease, background .4s ease, color .4s ease, transform .12s ease, opacity .12s ease' } : {},
			),
			onClick: go,
		}, dotInside(shape, drawn, skin, (1.5 * drawn) / Z.dot, star === undefined && dashedOf(kindOf(node)))))
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
		// 会话跑着时撤回记录读不了（见 src/host/rewind.js），树先按上一次读到的画，
		// 跑完自动重拉更正（hooks.js 的 rewindRetryDelay）。以前这里挂一个 ⏳ 提示，已去掉。
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
				// 删除 = 归档整条支线（tree.js 的 deletePlan）。宿主没有归档服务就不给按钮。
				canDelete: api.canArchive === true,
				// 名单里有正在看的这条时**先切走**：宿主的当前会话一归档主视图就空了（escapeFrom 挑去处）。
				// 然后一条条归档（失败只告警），最后清掉悬停、催一次重拉。树上消失靠的是归档集
				// （archivedSessionIds）跟着宿主变，不用自己回显。
				onDelete: async (node, plan) => {
					if (!plan || plan.blocked !== undefined || !Array.isArray(plan.sessions)) return undefined
					if (plan.sessions.includes(current)) {
						const to = escapeFrom(node, plan, (listState.ids || []).filter((id) => !archived.has(id)))
						if (to !== undefined) await api.open(to)
					}
					await api.archive(plan.sessions, { stopActivity: plan.running === true })
					clearTimeout(closeTimer.current)
					setHover(null)
					setNonce((value) => value + 1)
					return undefined
				},
				// 卡片贴着那个点放，不贴整棵树的左边 —— 岔路一多，主干那列的卡片会被甩出去老远
				anchor: hover ? cardAnchor(railWidth, hover.x, hitW) : railWidth + 4,
				railWidth, labels, hold, release, onLock,
				favorites, favIcons, favColors,
				// 卡片上那颗 ☆ 用**这个点自己的**颜色，不是全局那个黄 ——
				// 不然改完颜色，树上变了、卡片上没变，看着像没生效。
				starInk: starSkin(false, undefined, hover === null ? undefined : favColors[hover.node.key], theme).ink,
				// 色板里「恢复默认」那一格画的就是它 —— 不给的话那一格是个看不出颜色的空圈
				defaultInk: starSkin(false, undefined, undefined, theme).ink,
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
					// 站在拆出去的树上、点的又是**前缀**上的节点（它仍属旧会话）：新会话按血缘会
					// 掉回旧树，得认领到这棵（issue #4，见 graph.js 的【认领】）。
					// 点的是子树里的节点就不用：它的父亲本来就在这棵树里。
					const claim = !isRootKey(graph.owner) && node.tree !== graph.owner ? shapeOps.adopt : undefined
					if (action === 'fresh') {
						// 新对话没有血缘，得登记进当前这棵树（merge）；站在拆出去的树上还要认领（adopt）
						return api.fresh(workspaceOf(workspaceState, node.session.id), node.session.cwd, (id) => {
							const patch = Object.assign({}, here ? shapeOps.merge(id, here) : {}, claim ? claim(id, graph.owner) : {})
							return patch.session === undefined ? undefined : reshape(patch)
						})
					}
					// ⚠️ 切点传这一轮的 turn/end，不是 turn/start（forkCutSeq 的说明）：0.2 宿主按精确切点抄，
					//    传 turn/start 新分支就只剩一个空壳轮，模型从上一轮接着记。
					return api.fork(node.session.id, forkCutSeq(node.entry), claim ? (id) => reshape(claim(id, graph.owner)) : undefined)
				},
			}),
		),
	)
	return typeof document === 'undefined' ? null : portal(shell, document.body)
}
