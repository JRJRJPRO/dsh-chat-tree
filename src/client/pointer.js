/**
 * 这台设备**怎么指**：有没有悬停、点一下算什么、以及 WebKit 上那几条必须补的样式。
 *
 * 【为什么要有这个文件】整条导轨的交互原本只建立在 `mousemove` 上 ——
 * 鼠标滑到点上出卡片，卡片上再按 ＋ / ☆ / ⇥。这套在 Windows + Chrome 和
 * macOS + 触控板上都成立（触控板照样发 mousemove），但在 **iPad / iPhone
 * 以及带触摸屏的 Windows 本**上完全不成立：手指没有"滑过"这个状态，
 * 于是点一下节点＝直接跳走，卡片永远开不出来 —— 分支、收藏、改名、合并、
 * 分离这五件事一件也够不着，插件退化成一张只能点的静态图。
 *
 * 【思路】不去猜"是不是 iOS"（UA 嗅探在 iPad 上本来就分不清），
 * 而是问浏览器**这块屏能不能悬停**：`(hover: hover)`。
 * 能悬停 → 原样走 hover intent，一个字节的行为都不变；
 * 不能悬停 → 换成"点一下开卡片，再点一下才跳"（就是 iOS 自己对 :hover 的那套语义）。
 *
 * ⚠️ 别改成 `'ontouchstart' in window`：现在的 Chrome 桌面版也有这个属性，
 *    而 Surface 这类设备是**两种指针都有**，需要跟着用户当下用哪只手实时切换 ——
 *    matchMedia 会在切换时发 change 事件，这正是我们要的。
 */
import { react } from './runtime.js'

/** 判据：这块屏的主指针能不能悬停。 */
export const HOVER_QUERY = '(hover: hover)'

/**
 * 此刻能不能悬停。
 *
 * 查不出来（老浏览器、node 里跑测试）一律当**能** —— 宁可退回原来那套鼠标交互，
 * 也不要在桌面上误判成触摸，把"滑过出卡片"改成"要点两下"。
 * @returns 能悬停返回 true
 */
export function hasHover() {
	if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return true
	try {
		return window.matchMedia(HOVER_QUERY).matches
	} catch {
		return true
	}
}

/**
 * 跟着设备走的"能不能悬停"。二合一本子上插拔键盘、iPad 接妙控板都会实时切换。
 * @returns 能悬停返回 true
 */
export function useHover() {
	const [able, setAble] = react.useState(hasHover)
	react.useEffect(() => {
		if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return undefined
		let media
		try {
			media = window.matchMedia(HOVER_QUERY)
		} catch {
			return undefined
		}
		const check = () => setAble((was) => (was === media.matches ? was : media.matches))
		check()
		// ⚠️ Safari 13 及更早只有 addListener，没有 addEventListener。
		//    直接调 addEventListener 会抛，整个 Rail 跟着白屏。
		if (typeof media.addEventListener === 'function') {
			media.addEventListener('change', check)
			return () => media.removeEventListener('change', check)
		}
		if (typeof media.addListener === 'function') {
			media.addListener(check)
			return () => media.removeListener(check)
		}
		return undefined
	}, [])
	return able
}

/**
 * 触摸设备上，点一下某个节点该干嘛。
 *
 * 这是 `hoverNext` 的触摸版孪生：那边回答"鼠标压着谁的时候换不换卡片"，
 * 这边回答"手指戳下去是开卡片还是真跳过去"。
 *
 * ⚠️ 必须是**两下**。一下就跳的话卡片没有任何机会出现（原来的毛病）；
 *    而一下只开卡片、永远不跳，又会让"点节点＝滚到那一轮"这个最常用的动作
 *    平白多一步。所以：第一下把卡片开在这个点上（顺便把 ＋ ☆ 送到手边），
 *    第二下**戳同一个点**才跳 —— 和 iOS 自己处理 :hover 菜单的规矩一致，
 *    不用教。
 * @param hovered - 卡片现在停在哪个点；null = 卡片没开
 * @param node - 手指戳的那个点
 * @returns 'go' 真的跳过去 / 'open' 先把卡片开出来
 */
export function tapNext(hovered, node) {
	return hovered === node && hovered !== null && hovered !== undefined ? 'go' : 'open'
}

/**
 * 任何能点的东西都该带上这两条 —— **连带文字一起的面板也能用**。
 *
 * · `touchAction: 'manipulation'` —— 关掉双击缩放。**重点不是缩放**：
 *   Safari 为了等"你是不是还要点第二下"，会把 click 压后约 300ms 才派发，
 *   于是每个按钮手感都发黏。顺带它让卡片上的"双击展开"真的能用 ——
 *   否则那两下被浏览器当成缩放手势吃掉，`dblclick` 根本不发。
 * · `WebkitTapHighlightColor` —— iOS 默认给可点元素盖一层灰方块，
 *   盖在 11px 的小圆点上就是糊的一坨。
 */
export const NO_ZOOM = {
	touchAction: 'manipulation',
	WebkitTapHighlightColor: 'transparent',
}

/**
 * 纯按钮／纯图形用这一套：`NO_ZOOM` 再加上"别让手指选中它"。
 *
 * ⚠️ **别往含 `<input>` 的容器上招呼**。iOS 上祖先的 `-webkit-user-select: none`
 *    会连输入框里的文字一起变得选不中，改名框就没法放光标、没法全选重打了。
 *    所以卡片外壳只用 `NO_ZOOM`，这一套只给按钮和节点本身。
 *
 * · `WebkitTouchCallout` —— 长按不再弹"拷贝 / 共享"那张系统菜单。
 *   导轨上手指难免多停一会儿，弹一次就把卡片挤没了。
 * · `WebkitUserSelect` —— Safari 16.4 之前不认不带前缀的 `userSelect`，
 *   而 **React 的内联样式不会自动补前缀**。不补的话，手指在导轨上一划
 *   就选中一片文字，还会弹出两个选择手柄。
 */
export const TAPPABLE = Object.assign({
	WebkitTouchCallout: 'none',
	WebkitUserSelect: 'none',
	userSelect: 'none',
}, NO_ZOOM)

/**
 * 鼠标此刻到底在不在导轨（含浮在旁边的详情卡）上面。
 *
 * 【为什么不能只信 mouseleave】卡片里点一下会改版式 —— 收藏图标那排消失、导轨变宽变窄、
 * 卡片竖直居中所以变矮就等于内容在鼠标底下挪走。鼠标一动没动，浏览器照样派一个
 * `mouseleave` 过来。只信它的话，点一下"取消收藏"卡片就自己收了（John 报的）。
 *
 * 判法是**回到现场问一句**：这个坐标上最上面的那个元素，还是不是导轨的子孙。
 * 用 DOM 包含关系而不是矩形：卡片浮在导轨框的左边、几何上在框外，但它是导轨的子孙。
 *
 * ⚠️ 还没收到过 mousemove（`at` 是 null）时返回 `false` —— 也就是"该关就关"。
 *    反过来会让卡片在鼠标从没进过页面时永远关不掉。
 * @param shell - 导轨最外层元素
 * @param at - 最近一次鼠标位置 `{x, y}`，没有就是 null
 * @param probe - `(x, y) => 那个位置最上面的元素`，缺省用 document.elementFromPoint
 * @returns 鼠标还在导轨上吗
 */
export function overRail(shell, at, probe) {
	if (shell === null || shell === undefined) return false
	if (at === null || at === undefined) return false
	const pick = typeof probe === 'function'
		? probe
		: typeof document !== 'undefined' && typeof document.elementFromPoint === 'function'
			? (x, y) => document.elementFromPoint(x, y)
			: undefined
	if (pick === undefined) return false
	const hit = pick(at.x, at.y)
	if (hit === null || hit === undefined) return false
	return typeof shell.contains === 'function' && shell.contains(hit)
}
