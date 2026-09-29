/**
 * 副作用钩子：量聊天区、跟踪当前轮次、订阅宿主快照、拉大纲。
 *
 * 这里是插件与"宿主 DOM / 宿主服务"的全部接触面。宿主改了版式，先来这儿找。
 */
import { react } from './runtime.js'
import { Z } from './const.js'
import { getJson, warn } from './net.js'
import { adoptLabels } from './labels.js'

/**
 * 藏掉宿主自带的轮次导轨（否则两条叠一起谁也看不清）。
 * 类名带构建哈希，所以从它自己注入的 <style data-plugin-css> 里正则出前缀。
 * @returns 卸载函数
 */
export function hideNativeRail() {
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

/**
 * 视口变了就重量一次 —— 但盯的是**视觉视口**，不是 `window.resize`。
 *
 * ⚠️ 这条只在 iOS / iPadOS 上看得出来，而那正是我们够不着的机器：
 *    Safari 的地址栏会随滚动收起/展开，双指还能把页面整个放大。这两下都只动
 *    **visual viewport**，`window` 的 `resize` 一声不吭，`innerWidth` 也纹丝不动。
 *    导轨是 `position: fixed` + 按 `getBoundingClientRect()` 算出来的坐标，
 *    于是它会悬在原地不动，直到 800ms / 400ms 那个轮询兜底才跟上来 ——
 *    表现就是"手一松，树晚半拍才挪过去"。订上 visualViewport 就跟手了。
 *
 * 桌面浏览器上这两个事件基本不发，所以**对 Windows / macOS 没有任何影响**，
 * 纯粹是给触摸设备补的一条。老浏览器没有 visualViewport，返回空函数即可。
 * @param schedule - 重量一次（已经是 rAF 节流过的）
 * @returns 退订函数
 */
export function watchViewport(schedule) {
	const port = typeof window === 'undefined' ? undefined : window.visualViewport
	if (port === undefined || port === null || typeof port.addEventListener !== 'function') return () => {}
	port.addEventListener('resize', schedule)
	port.addEventListener('scroll', schedule)
	return () => {
		port.removeEventListener('resize', schedule)
		port.removeEventListener('scroll', schedule)
	}
}

/**
 * 聊天**正文栏**的右缘在哪儿。
 *
 * 宿主把正文排成一根定宽的居中栏（`.column{max-width:var(--dsh-chat-content-width);margin:0 auto}`），
 * 所以聊天区右缘和正文右缘之间有一条空当 —— 屏幕越宽越宽。导轨要落在那条空当里，
 * 就得先知道正文到哪儿为止，光有滚动容器的 `right` 是不够的。
 *
 * 量法是取所有聊天行里**最靠右的那条**：行本身是正文栏的 flex 子元素，
 * 撑满栏宽；万一有个宽代码块溢出去了，取 max 也能跟着让。
 *
 * ⚠️ 一行都量不到（空会话 / 刚切过去还没挂上）就返回 `undefined`，让调用方退回
 *    "贴着聊天区右缘"的老位置。**别返回 0 或者容器左缘** —— 那会让树一头扎进正文里。
 * @param el - 聊天区滚动容器
 * @returns 正文右缘的视口坐标；量不到就 undefined
 */
export function contentRightOf(el) {
	let most
	for (const row of el.querySelectorAll('[data-chat-turn]')) {
		const rect = row.getBoundingClientRect()
		if (rect.width < 1) continue
		if (most === undefined || rect.right > most) most = rect.right
	}
	return most
}

/** 导轨最外层那个 div 身上的记号。`isCovered` 靠它认出"这是我自己"。 */
export const RAIL_MARK = 'data-dsh-chat-tree-rail'

/**
 * 聊天区是不是被别的东西整个盖住了。
 *
 * 【为什么要有这条】导轨是 `position: fixed` 的全局浮层，它只认聊天容器的
 * `getBoundingClientRect()`。别的插件（`better-sidebar` 这类）把侧栏**盖**在聊天上面时，
 * 聊天容器还老老实实待在原地、尺寸一点没变 —— 于是屏幕上已经看不见一句对话了，
 * 却还有一棵树孤零零挂在那儿（John 报的就是这个）。
 *
 * 判法不认任何具体插件，只问一句"**这块地方现在谁在最上面**"：
 * 在聊天区里打几个点，`elementFromPoint` 回来的要么是聊天区自己（或它的子孙），
 * 要么是它的祖先（= 点落在空白处，上面没人）。**两样都不是**就说明有个兄弟子树压在上面。
 *
 * ⚠️ 必须**每个点都被盖住**才算盖住。只挑一个点的话，一个气泡提示、一个下拉菜单
 *    飘过去就会把整棵树闪掉。
 * @param el - 聊天区滚动容器
 * @param probe - `(x, y) => 那个位置最上面的元素`，一般就是 document.elementFromPoint
 * @returns 是否被盖住
 */
export function isCovered(el, probe) {
	const rect = el.getBoundingClientRect()
	if (rect.width < 1 || rect.height < 1) return true
	for (const fx of [0.35, 0.65]) {
		for (const fy of [0.3, 0.7]) {
			const hit = probe(rect.left + rect.width * fx, rect.top + rect.height * fy)
			if (hit === null || hit === undefined) continue // 点落到视口外了，这一枪不算数
			// 自己人不算遮挡：导轨可能正好压在探针上，那会来回闪
			if (typeof hit.closest === 'function' && hit.closest(`[${RAIL_MARK}]`) !== null) return false
			if (el.contains(hit) || hit.contains(el)) return false
		}
	}
	return true
}

/**
 * 量聊天区滚动容器；量不到退回视口右缘。
 *
 * 返回 `{top, height, right, contentRight}`。`contentRight` 是**正文栏**的右缘，
 * 导轨靠它算自己该落在空当的哪儿（见 geometry.js 的 railRight）。
 * 返回 `undefined` 表示"现在不该露面"：不在会话界面，或者聊天被别的插件整个盖住了。
 */
export function useChatBox() {
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
			// 聊天被别的插件的浮层整个盖住了（侧栏全屏那种）→ 这时候树该收起来，
			// 不然屏幕上一句对话都没有，却还挂着一棵树。判法见 isCovered，不认任何具体插件。
			if (typeof document.elementFromPoint === 'function' && isCovered(el, (x, y) => document.elementFromPoint(x, y))) {
				return setBox(undefined)
			}
			const rect = el.getBoundingClientRect()
			const content = contentRightOf(el)
			setBox((prev) =>
				prev &&
				Math.abs(prev.top - rect.top) < 1 &&
				Math.abs(prev.height - rect.height) < 1 &&
				Math.abs(prev.right - rect.right) < 1 &&
				// ⚠️ 正文右缘用 4px 的迟滞，不是 1px。聊天行的宽度会被滚动条、
				//    一张图加载完这类事顶来顶去差个一两像素 —— 按 1px 比的话，
				//    整棵树会跟着做肉眼可见的左右微抖。
				Math.abs((prev.contentRight === undefined ? -1e9 : prev.contentRight) - (content === undefined ? -1e9 : content)) < 4
					? prev
					: { top: rect.top, height: rect.height, right: rect.right, contentRight: content },
			)
		}
		const schedule = () => {
			cancelAnimationFrame(raf)
			raf = requestAnimationFrame(measure)
		}
		observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(schedule)
		measure()
		window.addEventListener('resize', schedule)
		const offViewport = watchViewport(schedule)
		const timer = setInterval(measure, 800)
		return () => {
			cancelAnimationFrame(raf)
			clearTimeout(graceTimer)
			if (observer) observer.disconnect()
			window.removeEventListener('resize', schedule)
			offViewport()
			clearInterval(timer)
		}
	}, [])
	return box
}

/**
 * 「你现在看到的是第几轮」怎么挑。**纯函数**，好把边界情形离线钉住。
 *
 * 两条规矩：
 *   1. 取聊天区顶部往下 25%（最多 140px）的探针线，找最后一个顶边还在线以上的聊天行；
 *      线以上一个都没有就拿第一个露头的。
 *   2. **末尾那一轮整个都在屏幕里，就是它。** 不加这条的话，最后一轮只要比探针线以下那段短，
 *      就永远轮不到它 —— 滚到底了树上还亮着倒数第二个点（John 报的：线性 1-2-3-4，
 *      4 很短，滑到底树上停在 3）。只对末尾那轮开这个口子：中间的轮次滚过去自然会碰到探针线。
 *      整段对话都装得下一屏时，这条让它恒指最新一轮 —— 反正没得滚，最新的那轮就是注意力所在；
 *      点了树上别的点想看哪轮就钉哪轮（见 pinActiveTurn）。
 * @param rows - 聊天行，按 DOM 顺序：`{turn, top, bottom}`
 * @param box - 聊天区：`{top, bottom}`
 * @returns 轮次号；一行都没有就 undefined
 */
export function pickActiveTurn(rows, box) {
	const probe = box.top + Math.min(140, (box.bottom - box.top) * 0.25)
	let best
	let tail
	for (const row of rows || []) {
		if (!row || !Number.isFinite(row.turn)) continue
		tail = row
		if (row.bottom < box.top) continue // 整行都滚过去了
		if (row.top <= probe) best = row.turn // 顶边还在线以上：候选，后面的会盖掉前面的
		else if (best === undefined) best = row.turn // 线以上一个都没有：拿第一个露头的
	}
	if (tail !== undefined && tail.bottom > box.top && tail.top < box.bottom && tail.bottom <= box.bottom + 2) best = tail.turn
	return best
}

// ===== 点击跳转之后"钉住"那一轮 =====
//
// 跳转把那一轮的提问滚到屏幕顶上。但末尾几轮都短的时候滚不到那么远（容器到底了），
// 于是屏幕上同时露着 3 和 4：按上面第 2 条会判成 4，可你明明点的是 3。
// 所以点过之后先**钉住**你点的那轮，直到你自己再滚动：
//   · 钉上之后先等滚动停稳（平滑滚动要几百毫秒），记下那一行当时在屏幕上的位置；
//   · 之后这一行的位置挪了超过 PIN_SLACK 像素 = 你自己滚了，解钉，回到按位置算。
// 记的是**那一行在屏幕上的位置**而不是 scrollTop：不用管到底是哪个元素在滚，
// 而且底下正在流式输出、往下长内容时那一行不动，钉着不松 —— 宿主要是自动滚到底了它才松。
// 切会话也解钉（rail.js 里 current 一变就叫 unpinActiveTurn）。

/** 钉住之后，多少毫秒没有 scroll 事件算"停稳了"。 */
export const PIN_SETTLE_MS = 250

/** 停稳之后，那一行在屏幕上挪了几像素以上算"用户自己滚了"。 */
export const PIN_SLACK = 3

/** 现在钉着的：`{turn, settled}`，`settled` 是停稳时那一行的 top（还没停稳是 undefined）。 */
let pinned

const pinWatchers = new Set()

/**
 * 钉住某一轮。`api.jump` 滚过去之后调。
 * @param turn - 轮次号
 */
export function pinActiveTurn(turn) {
	if (!Number.isFinite(turn)) return
	pinned = { turn, settled: undefined }
	for (const fn of pinWatchers) fn()
}

/** 解钉。切会话时调；用户自己滚了由 useActiveTurn 自己解。 */
export function unpinActiveTurn() {
	if (pinned === undefined) return
	pinned = undefined
	for (const fn of pinWatchers) fn()
}

/**
 * 现在钉着哪一轮（自诊断用）。
 * @returns 轮次号；没钉就 undefined
 */
export function pinnedTurn() {
	return pinned === undefined ? undefined : pinned.turn
}

/**
 * 停稳了：记下那一行现在的位置。**纯函数**。
 * @param pin - 现在钉着的
 * @param top - 那一行现在的 top
 * @returns 记好位置的钉
 */
export function settlePin(pin, top) {
	if (pin === undefined) return undefined
	return { turn: pin.turn, settled: Number.isFinite(top) ? top : undefined }
}

/**
 * 那一行挪到了 `top`，钉还钉不钉得住。**纯函数**。
 * @param pin - 现在钉着的
 * @param top - 那一行现在的 top
 * @param slack - 容许挪几像素
 * @returns 还钉着就原样返回；该解了就 undefined
 */
export function nudgePin(pin, top, slack) {
	if (pin === undefined) return undefined
	if (pin.settled === undefined || !Number.isFinite(top)) return pin // 还没停稳，不算用户动的
	return Math.abs(top - pin.settled) > slack ? undefined : pin
}

/**
 * 跟踪「你现在看到的是第几轮」。挑法见 pickActiveTurn，点击之后的钉住见上面那段。
 * scroll 不冒泡，所以在 document 上用捕获阶段监听。
 */
export function useActiveTurn() {
	const [turn, setTurn] = react.useState(undefined)
	react.useEffect(() => {
		let raf = 0
		let settleTimer = 0
		/** 量一遍聊天行：`{turn, top, bottom}`，按 DOM 顺序。量不到容器就 undefined。 */
		const scan = () => {
			const el = document.querySelector('[data-conversation-scroll]')
			if (el === null) return undefined
			const box = el.getBoundingClientRect()
			const rows = []
			for (const row of el.querySelectorAll('[data-chat-turn]')) {
				const rect = row.getBoundingClientRect()
				rows.push({ turn: Number(row.getAttribute('data-chat-turn')), top: rect.top, bottom: rect.bottom })
			}
			return { rows, box: { top: box.top, bottom: box.bottom } }
		}
		const measure = () => {
			const seen = scan()
			if (seen === undefined) return
			if (pinned !== undefined) {
				const row = seen.rows.find((one) => one.turn === pinned.turn)
				if (row !== undefined) pinned = nudgePin(pinned, row.top, PIN_SLACK)
			}
			const best = pinned !== undefined ? pinned.turn : pickActiveTurn(seen.rows, seen.box)
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
		// 钉上之后等滚动停稳再记位置；每来一个 scroll 事件就重新等
		const settle = () => {
			clearTimeout(settleTimer)
			if (pinned === undefined || pinned.settled !== undefined) return
			settleTimer = setTimeout(() => {
				const seen = scan()
				const row = seen === undefined ? undefined : seen.rows.find((one) => one.turn === (pinned || {}).turn)
				if (pinned !== undefined && pinned.settled === undefined && row !== undefined) pinned = settlePin(pinned, row.top)
			}, PIN_SETTLE_MS)
		}
		const onScroll = () => {
			settle()
			schedule()
		}
		const onPin = () => {
			settle()
			schedule()
		}
		pinWatchers.add(onPin)
		measure()
		document.addEventListener('scroll', onScroll, true)
		const offViewport = watchViewport(schedule)
		const timer = setInterval(measure, 400)
		return () => {
			pinWatchers.delete(onPin)
			cancelAnimationFrame(raf)
			clearTimeout(settleTimer)
			document.removeEventListener('scroll', onScroll, true)
			offViewport()
			clearInterval(timer)
		}
	}, [])
	return turn
}

/** 订阅宿主 ObservableSnapshot。 */
export function useObservable(observable) {
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
export function useOutlines(cwd, listState, nonce) {
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
				.then((body) => {
					if (!alive) return
					adoptLabels(body && body.labels) // 标注以宿主为准，本地只是缓存
					setData(body)
				})
				.catch((error) => {
					warn('拉大纲失败，树停在上一帧', error)
					// 拉不到也要让界面知道为什么：以前这里静悄悄，整条树直接消失
					if (alive) setData((previous) => Object.assign({}, previous || { sessions: [] }, { error: String((error && error.message) || error) }))
				})
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
export function isRewindPending(outlines) {
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
export function rewindRetryDelay(outlines) {
	return isRewindPending(outlines) ? Z.rewindMs : 0
}

// ===== 收藏那一下的动画 =====
//
// 为什么非得用 `@keyframes` 而不是 transition：收藏会把这个点**整个换一种形状**
//（圆 → 五角星），而 transition 只能在同一个属性的两个值之间过渡，换形状那一下
// 是个瞬变，补不出任何动画。所以用一次性的关键帧：形状瞬间换掉，星星自己转出来。
//
// ⚠️ 动画期间 `transform` 归关键帧管，inline 那个 `scale(1.4)`（悬停）和
//    `rotate(45deg)`（菱形）会被压住 340ms。只影响**刚被点的那一个点**，
//    播完立刻交还，比为了这 0.34 秒把 transform 拆成 CSS 变量划算。

/** 动画播多久（毫秒）。Rail 用它决定什么时候把动画标记摘掉。 */
export const STAR_ANIM_MS = 340

/** 关键帧的名字。收藏和取消各一条 —— 取消那下要"缩回去"，不是把收藏倒放。 */
export const STAR_ANIM = { on: 'dsh-chat-tree-star-on', off: 'dsh-chat-tree-star-off' }

/**
 * 把那两条关键帧塞进页面。整页只需要一份，Rail 挂载时调一次。
 * @returns 卸载函数
 */
export function installStarAnimation() {
	try {
		if (document.querySelector('style[data-dsh-chat-tree="star-anim"]') !== null) return () => {}
		const tag = document.createElement('style')
		tag.dataset.dshTree = 'star-anim'
		tag.textContent =
			`@keyframes ${STAR_ANIM.on}{` +
			'0%{transform:scale(.3) rotate(-150deg);opacity:.15}' +
			'55%{transform:scale(1.5) rotate(10deg);opacity:1}' +
			'100%{transform:scale(1) rotate(0)}}' +
			`@keyframes ${STAR_ANIM.off}{` +
			'0%{transform:scale(1.45) rotate(0);opacity:.9}' +
			'45%{transform:scale(.75) rotate(-18deg);opacity:.5}' +
			'100%{transform:scale(1) rotate(0);opacity:1}}' +
			// 未读读过之后的"要变了"：鼓一下 + 一圈同色的涟漪散开（box-shadow 不写颜色就是 currentColor，
			// 跟用户配的未读色走）。菱形要保住 45° 的旋转；多边形 / 字 / 图片没有方框，只鼓不散圈。
			`@keyframes ${READ_ANIM.ring}{` +
			'0%{transform:scale(1);box-shadow:0 0 0 0 currentColor}' +
			'35%{transform:scale(1.3)}' +
			'100%{transform:scale(1);box-shadow:0 0 0 9px transparent}}' +
			`@keyframes ${READ_ANIM.spin}{` +
			'0%{transform:scale(1) rotate(45deg);box-shadow:0 0 0 0 currentColor}' +
			'35%{transform:scale(1.3) rotate(45deg)}' +
			'100%{transform:scale(1) rotate(45deg);box-shadow:0 0 0 9px transparent}}' +
			`@keyframes ${READ_ANIM.flat}{` +
			'0%{transform:scale(1)}' +
			'35%{transform:scale(1.3)}' +
			'100%{transform:scale(1)}}'
		document.head.appendChild(tag)
		return () => tag.remove()
	} catch {
		return () => {}
	}
}

/**
 * 这一帧某个点该挂什么 `animation`。
 *
 * 抽成纯函数是为了能测：藏在渲染里的话，改成"永远 none"一条断言都不会响，
 * 而症状（点了收藏，星星直接蹦出来没有动画）只有人眼盯着才看得出来。
 * @param flash - `{key, on}`，刚被点的那个点；没有就是 null
 * @param key - 当前这个点的 key
 * @returns CSS 的 `animation` 值
 */
export function starAnimation(flash, key) {
	if (flash === null || flash === undefined || flash.key !== key) return 'none'
	return `${flash.on ? STAR_ANIM.on : STAR_ANIM.off} ${STAR_ANIM_MS}ms cubic-bezier(.34,1.4,.64,1)`
}

// ===== 未读节点读过之后：先不动、再提示、再变普通 =====
//
// 宿主一打开那条会话就清掉 completed，节点按理当场变回普通 —— 但那样用户根本
// 意识不到"我刚才看的就是那个新节点"（John 提的）。所以分三段：
//   hold  先原样绿着（READ_HOLD_MS）：让人看清"哦，我在看的就是它"；
//   fade  鼓一下、散一圈涟漪（READ_FADE_MS）："这个点要变普通了哦"；
//   melt  换成普通配色，但颜色用 transition 化过去（READ_MELT_MS），不是硬切；
//   done  彻底和别的普通节点一样，记录也删掉。
// 时刻由 Rail 自己记（谁从 unread 变成了 normal、什么时候），不落盘 —— 刷新页面就没了，
// 而刷新之后本来也没什么"刚读过"可言。

/** 读过之后先原样绿着多久。 */
export const READ_HOLD_MS = 1200

/** "要变了"的提示动画播多久。 */
export const READ_FADE_MS = 800

/** 换成普通配色之后颜色化过去要多久。 */
export const READ_MELT_MS = 400

/** 三套关键帧：圆/方/菱形 → 鼓一下 + 散圈；菱形另配一套保住 45°；多边形/字/图片只鼓不散圈。 */
export const READ_ANIM = { ring: 'dsh-chat-tree-read', spin: 'dsh-chat-tree-read-spin', flat: 'dsh-chat-tree-read-flat' }

/**
 * 读过之后走到哪一段了。**纯函数**。
 * @param since - 变成"读过"的时刻（ms）
 * @param now - 现在
 * @returns 'hold' | 'fade' | 'melt' | 'done'
 */
export function readPhase(since, now) {
	const gone = now - since
	if (!Number.isFinite(gone) || gone < 0) return 'done'
	if (gone < READ_HOLD_MS) return 'hold'
	if (gone < READ_HOLD_MS + READ_FADE_MS) return 'fade'
	if (gone < READ_HOLD_MS + READ_FADE_MS + READ_MELT_MS) return 'melt'
	return 'done'
}

/**
 * 这一段该挂什么 `animation`。只有 fade 那一段有动画。
 * @param phase - `readPhase` 的结果
 * @param flat - 这个形状没有方框（多边形 / 字 / 图片），散圈会散成方的，所以只鼓不散
 * @param spin - 这个形状是转了 45° 画的（菱形），关键帧里要保住
 * @returns CSS 的 `animation` 值
 */
export function readAnimation(phase, flat, spin) {
	if (phase !== 'fade') return 'none'
	const name = flat ? READ_ANIM.flat : spin ? READ_ANIM.spin : READ_ANIM.ring
	return `${name} ${READ_FADE_MS}ms cubic-bezier(.34,1.3,.64,1)`
}

/**
 * 离下一次该重画还有多久：所有"读过"记录里最近的那个段落边界。**纯函数**，顺手把 done 的删掉。
 * @param readAt - key → 变成"读过"的时刻
 * @param now - 现在
 * @returns 毫秒；没有待播的就 undefined
 */
export function nextReadBoundary(readAt, now) {
	let soonest
	for (const [key, since] of readAt) {
		const gone = now - since
		if (!Number.isFinite(gone) || gone >= READ_HOLD_MS + READ_FADE_MS + READ_MELT_MS) {
			readAt.delete(key)
			continue
		}
		for (const edge of [READ_HOLD_MS, READ_HOLD_MS + READ_FADE_MS, READ_HOLD_MS + READ_FADE_MS + READ_MELT_MS]) {
			if (edge > gone) {
				const wait = edge - gone
				if (soonest === undefined || wait < soonest) soonest = wait
				break
			}
		}
	}
	return soonest
}
