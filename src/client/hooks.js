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
 * 跟踪「你现在看到的是第几轮」。
 * 取聊天区顶部往下 25% 的探针线，找最后一个顶边还在线以上的聊天行。
 * scroll 不冒泡，所以在 document 上用捕获阶段监听。
 */
export function useActiveTurn() {
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
		const offViewport = watchViewport(schedule)
		const timer = setInterval(measure, 400)
		return () => {
			cancelAnimationFrame(raf)
			document.removeEventListener('scroll', schedule, true)
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
			'100%{transform:scale(1) rotate(0);opacity:1}}'
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
