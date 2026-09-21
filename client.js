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

		// hit = 命中区宽度，同时也是导轨右侧留给第 0 列的**下限**（圆心在这条宽度的一半处）。
		// 以前 18 和 9 是散在渲染里的魔数，收进来才能跟着缩放一起动。
		//
		// laneGap = 相邻两列的图形之间**至少**要留多少空白。
		// ⚠️ `lane` 只是列距的下限，不是列距本身。列距真正由「这棵树上画得最宽的那个形状」
		//    说了算（见 geometry.js 的 railLayout）：收藏的五角星是 1.67 倍，11px 的点画出来
		//    18.4px，塞进 17px 的列里左右两个点就贴上了 —— John 报的就是这条。
		/**
		 * 基准尺寸。滑杆上的 100% 指的就是这张表。
		 *
		 * 前八项（`scaleZ` 会缩的那些）是**老基准的 1.2 倍再取整** —— 原来要调到 120%
		 * 才顺眼，那就把 120% 挪成默认的 100%。取整是为了 1px 描边落在整像素上不发虚，
		 * 代价是各项相对老基准差 ±2% 以内。
		 * 老基准：row 20 / rowMin 7 / dot 9 / dotMin 6 / dotPad 5 / lane 14 / hit 18
		 */
		const Z = { row: 24, rowMin: 8, dot: 11, dotMin: 7, dotPad: 6, lane: 17, hit: 22, laneGap: 5, pad: 16, card: 270, gap: 20, restMs: 140, graceMs: 600, rewindMs: 2000 }

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
			for (const key of ['row', 'rowMin', 'dot', 'dotMin', 'dotPad', 'lane', 'hit', 'laneGap']) out[key] = Z[key] * k
			return out
		}

		// ===== 中性色：一律用宿主的主题变量，别写死 =====
		//
		// ⚠️ 这里曾经全是写死的深色（`bg: '#161b22'` 之类）。暗色模式下正好和页面同色，
		//    普通节点看着就是个"空心圈"；**换到亮色模式就露馅了** —— 同一个深色填充糊在
		//    白底上，成了一个深色实心点，而那圈灰描边反倒看不见了（John 报的就是这条）。
		//
		// 宿主用 `body[data-ds-dark-theme]` 切换一整套 `--dsw-alias-*` 变量（见
		// dsh-client-ui-theme）。直接引用这些变量，**明暗切换不需要我们写一行 JS**，
		// 用户改宿主主题的那一刻就跟着变了。
		//
		// 只有"角色色"（普通/当前/压缩/空节点）还是真实色值 —— 它们要参与 `rgba()` 运算
		// （垫色、外发光），而 CSS 变量算不了。那几个在 shapes.js 的 PALETTE 里，分明暗两版。
		const C = {
			/** 连线、卡片描边 */
			line: 'var(--dsw-alias-border-l3)',
			/** 次要文字：轮次号、⏳、清单里的「N 轮」 */
			muted: 'var(--dsw-alias-label-tertiary)',
			/** 正文 */
			text: 'var(--dsw-alias-label-primary)',
			/** 卡片底色 */
			card: 'var(--dsw-alias-bg-layer-2)',
			/** 输入框底色 */
			input: 'var(--dsw-alias-bg-base)',
			/** 清单里一行被鼠标压住时的底色 */
			hover: 'var(--dsw-alias-interactive-bg-hover)',
			/** 强调色（改名输入框的边框） */
			accent: 'var(--dsw-alias-link)',
			/**
			 * 节点"不垫色"时的填充 —— 就是页面底色。
			 * 不能用 `transparent`：那样连线会从半透明的点中间穿过去。
			 */
			bg: 'var(--dsw-alias-bg-layer-1)',
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
		 * 走不走 `remote-web-ui` 的 `/remote` 通道。
		 *
		 * 【为什么需要这个】host 半的三条路由现在问宿主的 `connection` 要判决，
		 * 那道闸是 **loopback-only** 的：Host 不是 127.0.0.1 / localhost 就直接 403。
		 * 手机在局域网里开的页面，Host 是局域网 IP —— 直连必然被拒。
		 *
		 * 宿主给这种情况留的路是 `remote-web-ui` 的 `/remote` 前缀：它做完配对校验，
		 * 再以 127.0.0.1 把请求重发进来，于是围栏自然过。那是个**通用前缀转发**
		 * （`/remote/<任意路径>`），不限于它自己那几条路由，我们直接借用即可 ——
		 * 不碰它任何内部 API。
		 *
		 * ⚠️ 不能改成"一上来就走 /remote"：桌面端（127.0.0.1）压根没装 remote-web-ui 时
		 *    那个前缀是 404。所以是**先直连，被拒了才换路，换成了就记住**。
		 */
		const REMOTE_PREFIX = '/remote'

		/** 已经确认要走 /remote 了吗。一旦为真就不再试直连。 */
		let viaRemote = false

		/**
		 * 现在该用哪个前缀。
		 *
		 * 给**不走 fetch 的东西**用 —— CSS `url(...)` 里的节点图片就是（`shapes.js` 的 `iconUrl`）。
		 * 那类请求没有重试的机会，只能沿用 `send()` 已经试出来的结论。
		 * 时序上够用：图片是在 `/outlines` 回来之后才画的，那时 `viaRemote` 已经定了。
		 * @returns '' 或 '/remote'
		 */
		function apiPrefix() {
			return viaRemote ? REMOTE_PREFIX : ''
		}

		/**
		 * `remote-web-ui` 的免 cookie 设备凭据。
		 *
		 * 它自己的 fetch 补丁只给**被它改写过**的请求加这个头，而 `/plugins/...` 不在它的
		 * 改写名单里 —— 我们自己拼的 `/remote/...` 因此拿不到。cookie 那条路通常够用
		 * （同源请求自带），这里是补上无痕模式/跨标签页那种只有 sessionStorage 的情形。
		 * 取不到就算了，配对校验自会说话。
		 * @returns 设备 id，没有就是 undefined
		 */
		function deviceId() {
			try {
				return globalThis.sessionStorage?.getItem('dsh-remote-device') || undefined
			} catch {
				return undefined
			}
		}

		/**
		 * 发一次请求；直连被围栏拒掉就改走 `/remote` 再试一次。
		 *
		 * 只对 401 / 403 重试 —— 那两个码才是"围栏说不行"。404 / 500 是别的毛病，
		 * 换条路也一样。重试只发生一次，成了就把 `viaRemote` 钉住，之后不再多跑一个来回。
		 * @param path - `API` 之后那一段
		 * @param init - fetch 的第二个参数
		 * @returns fetch 的答复
		 */
		async function send(path, init) {
			const device = deviceId()
			const go = (prefix) =>
				fetch(`${prefix}${API}${path}`, {
					...init,
					credentials: 'same-origin',
					headers: {
						...(init && init.headers),
						...(prefix !== '' && device !== undefined ? { 'x-dsh-remote-device': device } : {}),
					},
				})
			if (viaRemote) return go(REMOTE_PREFIX)
			const direct = await go('')
			if (direct.status !== 401 && direct.status !== 403) return direct
			const relayed = await go(REMOTE_PREFIX)
			if (relayed.ok) viaRemote = true
			// 换路也不行：把**直连**那份答复还回去。它的错误信息说的是真正的原因
			// （"没有登录凭据"），而 /remote 的 404 只会让人以为是路由写错了。
			return relayed.ok ? relayed : direct
		}

		/**
		 * GET 一个 JSON。
		 * @param path - `API` 之后那一段，比如 `/outlines`
		 * @param params - 查询串，值会自己 encode
		 * @returns 解析好的 body
		 */
		async function getJson(path, params) {
			const query = new URLSearchParams(params || {}).toString()
			return unwrap(await send(`${path}${query === '' ? '' : `?${query}`}`))
		}

		/**
		 * POST 一个 JSON。
		 * @param path - `API` 之后那一段，比如 `/shape`
		 * @param body - 会被 JSON.stringify 的东西
		 * @returns 解析好的 body
		 */
		async function postJson(path, body) {
			return unwrap(
				await send(path, {
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify(body),
				}),
			)
		}

		// ===== theme.js ================================================

		/**
		 * 现在是亮色还是暗色。
		 *
		 * 宿主（dsh-client-ui-theme）把暗色标在 **`body[data-ds-dark-theme]`** 上，
		 * 一整套 `--dsw-alias-*` 变量跟着换。中性色我们直接引用那些变量，所以**不需要**
		 * 知道明暗；但**角色色**（普通/当前/压缩/空节点）要参与 `rgba()` 运算，
		 * CSS 变量算不了，只能自己按明暗挑一套真实色值 —— 这个文件就为这件事存在。
		 *
		 * ⚠️ 别改成 `matchMedia('(prefers-color-scheme: dark)')`：宿主的主题是**可以手动
		 *    指定**的（设置里选浅色/深色/跟随系统），跟系统偏好不一定一致。以 body 上那个
		 *    属性为准才是宿主说了算。
		 */

		/** 宿主标记暗色的那个属性。 */
		const DARK_ATTRIBUTE = 'data-ds-dark-theme'

		/**
		 * 此刻是不是暗色。
		 * @returns 是否暗色；在 node 里（离线测试）恒为 true，走默认那套
		 */
		function isDark() {
			if (typeof document === 'undefined' || document.body === null || document.body === undefined) return true
			if (typeof document.body.hasAttribute !== 'function') return true
			return document.body.hasAttribute(DARK_ATTRIBUTE)
		}

		/**
		 * 跟着宿主主题走。用户在设置里切明暗时**立刻**重画，不用刷新页面。
		 * @returns 是否暗色
		 */
		function useColorScheme() {
			const [dark, setDark] = react.useState(isDark)
			react.useEffect(() => {
				if (typeof MutationObserver === 'undefined' || typeof document === 'undefined' || !document.body) return undefined
				const check = () => setDark((was) => (was === isDark() ? was : isDark()))
				const observer = new MutationObserver(check)
				observer.observe(document.body, { attributes: true, attributeFilter: [DARK_ATTRIBUTE] })
				check()
				return () => observer.disconnect()
			}, [])
			return dark
		}

		// ===== pointer.js ==============================================

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

		/** 判据：这块屏的主指针能不能悬停。 */
		const HOVER_QUERY = '(hover: hover)'

		/**
		 * 此刻能不能悬停。
		 *
		 * 查不出来（老浏览器、node 里跑测试）一律当**能** —— 宁可退回原来那套鼠标交互，
		 * 也不要在桌面上误判成触摸，把"滑过出卡片"改成"要点两下"。
		 * @returns 能悬停返回 true
		 */
		function hasHover() {
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
		function useHover() {
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
		function tapNext(hovered, node) {
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
		const NO_ZOOM = {
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
		const TAPPABLE = Object.assign({
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
		function overRail(shell, at, probe) {
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

		// ===== labels.js ===============================================

		/**
		 * 节点上的用户标注：**改名**和**收藏**。两件事都存 localStorage。
		 *
		 * ⚠️ **这是个半成品**：换浏览器就没了，也进不了手机。真正的落点应该是 host 半的
		 * `shape.json` 旁边（那儿已经有 `$DSH_HOME/plugins/dsh-tree/`），接口保持成
		 * `readLabels()/writeLabel()` + `readFavorites()/writeFavorite()` 这几个函数，
		 * 就是为了那天只改这一个文件。
		 *
		 * 两者的键都是**节点 key**（`<sessionId>:<turn>`，树根是 `root`，见 tree.js），
		 * 所以改名和收藏天然对齐到同一个点上。
		 */

		const LS_KEY = 'dsh-tree.labels'

		/** 收藏清单存哪。和改名分开存：改名是一张字典，收藏是一个集合，混在一起迟早要判类型。 */
		const FAVORITES_KEY = 'dsh-tree.favorites'

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

		// ===== 收藏 =====
		//
		// 存盘格式是个**字符串数组**（不是 `{key: true}`）：它本来就是个集合，
		// 存成字典的话早晚有人写出 `favorites[key] === false` 这种"取消收藏"的假动作，
		// 于是清单里躺满了取消过的键。数组里没有就是没有。

		/**
		 * 收藏清单。
		 * @returns 节点 key 的集合
		 */
		function readFavorites() {
			try {
				const raw = JSON.parse(localStorage.getItem(FAVORITES_KEY) || '[]')
				return new Set(Array.isArray(raw) ? raw.filter((item) => typeof item === 'string' && item.length > 0) : [])
			} catch {
				return new Set()
			}
		}

		/**
		 * 加一个 / 去一个之后的清单。**纯函数**，不碰 localStorage ——
		 * 存盘那一下没法在 node 里测，集合算术可以。
		 * @param current - 现在的集合
		 * @param key - 节点 key
		 * @param on - true 收藏、false 取消
		 * @returns 新集合（不改原来那个）
		 */
		function nextFavorites(current, key, on) {
			const next = new Set(current || [])
			if (typeof key !== 'string' || key.length === 0) return next
			if (on) next.add(key)
			else next.delete(key)
			return next
		}

		/**
		 * 收藏 / 取消收藏并存盘。
		 * @param key - 节点 key
		 * @param on - true 收藏、false 取消
		 * @returns 新集合
		 */
		function writeFavorite(key, on) {
			const next = nextFavorites(readFavorites(), key, on)
			try {
				localStorage.setItem(FAVORITES_KEY, JSON.stringify([...next]))
			} catch {
				/* 存不下就算了 */
			}
			return next
		}

		// ===== 收藏用哪个图标 =====
		//
		// 和收藏清单**分开存**，理由和当初把收藏从 labels 里拆出来一样：
		// 清单是个集合，图标是张字典，混在一起迟早要判类型。
		// 而且取消收藏时**故意不删图标** —— 取消再收藏回来，还是上次那个图标，
		// 不用重挑一遍。一个字符串的代价，换掉一次"我刚才选的呢"。

		/** 收藏图标存哪。值是形状值：预设 id / `char:<字>` / `img:<id>`。 */
		const FAVICONS_KEY = 'dsh-tree.favicons'

		/**
		 * 每个收藏点自己挑的图标。
		 * @returns {Record<string,string>} 节点 key → 形状值；没挑过的不在里面
		 */
		function readFavIcons() {
			try {
				const raw = JSON.parse(localStorage.getItem(FAVICONS_KEY) || '{}')
				if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return {}
				const out = {}
				for (const [key, value] of Object.entries(raw)) {
					if (typeof value === 'string' && value.length > 0) out[key] = value
				}
				return out
			} catch {
				return {}
			}
		}

		/**
		 * 挑一个 / 恢复默认之后的字典。**纯函数**，不碰 localStorage。
		 * @param current - 现在的字典
		 * @param key - 节点 key
		 * @param value - 形状值；空串 / `star` = 恢复默认，直接把这一条删掉
		 * @returns 新字典（不改原来那个）
		 */
		function nextFavIcons(current, key, value) {
			const next = Object.assign({}, current || {})
			if (typeof key !== 'string' || key.length === 0) return next
			const want = typeof value === 'string' ? value.trim() : ''
			// ⚠️ 恢复默认是**删掉这一条**，不是存一个 'star'。存进去的话，哪天默认记号
			//    换了样子，所有"没改过"的点会被这条陈年记录钉在旧样子上。
			if (want === '' || want === 'star') delete next[key]
			else next[key] = want
			return next
		}

		/**
		 * 挑图标并存盘。
		 * @param key - 节点 key
		 * @param value - 形状值；空串 = 恢复默认
		 * @returns 新字典
		 */
		function writeFavIcon(key, value) {
			const next = nextFavIcons(readFavIcons(), key, value)
			try {
				localStorage.setItem(FAVICONS_KEY, JSON.stringify(next))
			} catch {
				/* 存不下就算了 */
			}
			return next
		}

		// ===== 收藏用什么颜色 =====
		//
		// ⚠️ 这条推翻了原来"收藏恒为那个黄"的硬规矩。当初的理由是"颜色一旦可配，
		//    '哪个是收藏'这件一眼能扫出来的事就失效了"，现在仍然成立 —— 所以
		//    **默认还是那个黄**，这里存的只是用户显式改过的那几个。没改过的不在字典里。
		//
		// 和图标分开存，理由和图标当初从收藏清单里拆出来一样：一张字典存一件事。
		// 取消收藏同样**不删颜色**，收藏回来还是上次那个。

		/** 收藏颜色存哪。值是 `#rrggbb`。 */
		const FAVCOLORS_KEY = 'dsh-tree.favcolors'

		/** 认不认这个颜色。只收六位十六进制 —— 它要直接进 CSS，认宽了等于开个注入口子。 */
		function isColor(value) {
			return typeof value === 'string' && /^#[0-9a-fA-F]{6}$/.test(value)
		}

		/**
		 * 每个收藏点自己挑的颜色。
		 * @returns {Record<string,string>} 节点 key → `#rrggbb`；没改过的不在里面
		 */
		function readFavColors() {
			try {
				const raw = JSON.parse(localStorage.getItem(FAVCOLORS_KEY) || '{}')
				if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return {}
				const out = {}
				for (const [key, value] of Object.entries(raw)) {
					if (isColor(value)) out[key] = value.toLowerCase()
				}
				return out
			} catch {
				return {}
			}
		}

		/**
		 * 改一个 / 恢复默认之后的字典。**纯函数**，不碰 localStorage。
		 * @param current - 现在的字典
		 * @param key - 节点 key
		 * @param value - `#rrggbb`；空串 / 认不得的值 = 恢复默认，把这一条删掉
		 * @returns 新字典（不改原来那个）
		 */
		function nextFavColors(current, key, value) {
			const next = Object.assign({}, current || {})
			if (typeof key !== 'string' || key.length === 0) return next
			// ⚠️ 恢复默认是**删掉这一条**，不是存一个黄色。存进去的话，哪天默认色换了，
			//    所有"没改过"的点会被这条陈年记录钉在旧颜色上（和 nextFavIcons 同一条）。
			if (!isColor(value)) delete next[key]
			else next[key] = value.toLowerCase()
			return next
		}

		/**
		 * 挑颜色并存盘。
		 * @param key - 节点 key
		 * @param value - `#rrggbb`；空串 = 恢复默认
		 * @returns 新字典
		 */
		function writeFavColor(key, value) {
			const next = nextFavColors(readFavColors(), key, value)
			try {
				localStorage.setItem(FAVCOLORS_KEY, JSON.stringify(next))
			} catch {
				/* 存不下就算了 */
			}
			return next
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
		 * 这个 ＋ 现在为什么按不了。**按不了就说清楚，别开出一条看着正常其实失忆的分支。**
		 *
		 * 只有一种情况：从一条**托管给外部引擎**（claude 这类）的会话上真的开岔路，
		 * 而它正在跑。新分支要继承上下文就得读它的记录，而读那个文件会打断它正在跑的那一轮
		 * （见 src/host/rewind.js 顶上的说明）—— 所以我们不读，也就接不上。
		 *
		 * 为什么不是"照开，只是没上下文"：那条分支看起来和别的一模一样，你发现不了它失忆，
		 * 直到它答得驴唇不对马嘴。为什么不是"先开着、等跑完再补"：那几秒里你看到的仍然是
		 * 一条看着正常的分支，而且你会以为卡住了去瞎点。
		 *
		 * 另外三种动作都不需要读它的记录，所以一律不拦：
		 *   · `open` —— 就在本会话接着问，没有新会话；
		 *   · `fresh` —— 空节点上开一条全新对话，本来就没有上下文可继承；
		 *   · 普通 provider —— 对话原文就在 dsh 日志里，原生 fork 抄过去就够了。
		 * @param node - 被点的节点
		 * @returns 原因；能开就是空串
		 */
		function forkBlockedWhy(node) {
			if (branchAction(node) !== 'fork') return ''
			if (node.session.claude !== true || node.session.running !== true) return ''
			return '这条对话正在运行，现在读它的记录会打断那一轮，所以开不了分支 —— 跑完再开'
		}

		/**
		 * 这个节点是不是一条分支的头一个自有轮次。
		 *
		 * 「没继承到上下文」这件事是**整条分支**的属性，但挂在每个节点上会刷屏，
		 * 挂在岔路口那一个上最贴合"从这儿往后它就不记得前面了"。
		 * @param node - 节点
		 * @returns 是不是分支头
		 */
		function isBranchHead(node) {
			if (node.entry === undefined) return false
			const first = (node.session.turns || []).find((entry) => !entry.inherited)
			return first !== undefined && first.turn === node.entry.turn
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
			//    必须排在剪边**之后**：剪掉的子树不该再占着列宽。
			//
			// 【为什么不是"来一条新分支就发一个新列号"】那是最早的写法：深度优先走一遍，
			// 遇到岔路就 `nextColumn += 1`，发出去的号永不回收。它保证了一件要紧的事 ——
			// **一棵子树占一段连续的列**，于是连线永远不会从别的节点头顶压过去。
			// 但它从不回收，所以深处才出现的分支会先占掉小列号，把浅处那条挤到更外面，
			// 中间空出一整列。John 报的就是这个：
			//
			//     主干 1-2-3-4，5 从 1 岔出；然后在 3 后面再开一个 6
			//       col2 col1 col0            col1 col0
			//   d1     ·    ·    1        d1     ·    1
			//   d2     5    ·    2   →    d2     5    2     ← 5 不该被挤出去，
			//   d3     ·    ·    3        d3     ·    3        col1 那个洞底下还横穿着
			//   d4     ·    6    4        d4     6    4        一条 3→6 的线，很难看
			//
			// 【换成什么】Reingold–Tilford 那套**紧凑树**（tidy tree，1981 年那篇，
			// d3.tree / graphviz 用的都是它的后裔）。换掉的只是"往外挪多少"这一步：
			// 每棵子树先各自排好，再让兄弟子树**按轮廓**互相贴紧 —— 一条只有一行的短支线，
			// 可以整个嵌进旁边那棵子树空着的那几行里，而不是白占一整列。
			//
			// ⚠️ 试过 git 提交图那套泳道复用（`git log --graph` / GitKraken）。洞是没了，
			//    但它是给 **DAG** 用的，允许连线交叉；我们这儿有一条"连线不许压过任何节点"的
			//    硬约束（test.mjs 断言 5b），压测里它当场画出从别人头顶压过去的横线。
			//    树就该用树的算法。

			/**
			 * 一棵子树的**轮廓**：行 → 这一行用到的最外侧那一列（相对子树根那一列）。
			 *
			 * 这就是 Reingold–Tilford 紧凑树的核心数据。有了它，兄弟子树才能"贴着彼此的
			 * 凹凸互相嵌进去"，而不是各占一整段互不相让的列。
			 */
			const outline = (node) => {
				const edge = new Map([[node.depth, 0]])
				const kids = node.children.slice().sort((left, right) => (left.session.createdAt || 0) - (right.session.createdAt || 0))
				if (kids.length === 0) return edge
				// ⚠️ 撤回掉的那一轮虽然也是"本会话的延续"，但它是条废弃支线，
				//    让它占住主列的话，还活着的下一轮反而被挤到旁边去了。
				const same = (kid) => kid.session.id === node.session.id
				const trunk = kids.find((kid) => same(kid) && kid.rewound !== true) || kids.find(same) || kids[0]

				const shape = new Map()
				for (const kid of kids) shape.set(kid, outline(kid))
				const paste = (from, shift) => {
					for (const [row, at] of from) edge.set(row, Math.max(edge.get(row) ?? -1, at + shift))
				}

				trunk.column = 0 // 延续那条继承本列，主干天然是直线
				paste(shape.get(trunk), 0)
				for (const kid of kids) {
					if (kid === trunk) continue
					// 挪到刚好躲开已经放好的那些兄弟：它子树用到的每一行都要让开，
					// **外加父节点那一行** —— 拐进来的那一下会占住那一格（先横后竖）。
					let shift = (edge.get(node.depth) ?? -1) + 1
					for (const [row] of shape.get(kid)) shift = Math.max(shift, (edge.get(row) ?? -1) + 1)
					kid.column = Math.max(shift, 1) // 岔路只许往外长，不许压回主干那一列
					paste(shape.get(kid), kid.column)
					edge.set(node.depth, Math.max(edge.get(node.depth) ?? -1, kid.column)) // 拐弯那一格也占着
				}
				return edge
			}
			outline(root)

			// 上面算的是**相对父亲**的列，从根往下累加成绝对列
			root.column = 0
			const settle = (node) => {
				for (const kid of node.children) {
					kid.column += node.column
					settle(kid)
				}
			}
			settle(root)

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

		/** 上传的图落在 host 半，这是取它的路径（前缀另算，见 `iconUrl`）。 */
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
		 * 自定义字最多几个字符（按**码点**数，emoji 算一个）。
		 *
		 * ⚠️ 这个数是**输入框和渲染共用**的唯一一份。以前输入框写 `maxLength: 4`、
		 *    `shapeSpec` 只认 2 个，于是打到第 3 个字时框里明明有字、树上的图标却悄悄
		 *    退回了默认 —— "能输入，但不生效"是最难查的那种（John 报的就是这条）。
		 */
		const GLYPH_MAX = 5

		/**
		 * 字最多摊到点的几倍宽（**只算字，不含外面那圈框**）。
		 *
		 * 封顶是因为列距按画出来最宽的形状留（见 geometry.js 的 railLayout）：
		 * 不封的话，某一个节点挂个 5 字标签，**整棵树**的列距都会被它撑开。
		 */
		const GLYPH_SPAN = 3

		/**
		 * 字左右两边各留多少空，单位是点直径的倍数（也就是一个方块字的宽）。
		 *
		 * ⚠️ 这是个**定值**，不是比例 —— 这正是"框看起来统一"的全部来源：
		 *    不管框里是一个汉字、一个字母还是三个字，边上那圈空白一样宽。
		 *
		 * 两边加起来正好一个字符宽。**没做成"每边整整一个字符"**：高度这边被行高卡死
		 * （见 `GLYPH_PAD_Y`），横向再翻一倍的话，单字节点就成了一颗三倍宽的扁药丸，
		 * 横竖比例很难看。嫌窄就把这个数调大，别的全自动跟着走。
		 */
		const GLYPH_PAD_X = 0.5

		/**
		 * 字上下两边各留多少空。
		 *
		 * ⚠️ 比左右小，是因为竖向**被行高卡死**：一行只有 `Z.row`（24）那么高，
		 *    节点和连到下一行的那截线在里面分。给到这个数，节点连框一共 1.7 倍点直径 ——
		 *    正好和五角星（`grow` ≈ 1.67）一样高，也就是说树上早就有这么大的节点了，
		 *    行距不会被它撑到一个新的量级，只是线短了一截。
		 */
		const GLYPH_PAD_Y = 0.35

		/** 带框的字竖向占点直径的几倍。所有带框的字**高度一律相同**，一排看过去才齐。 */
		const GLYPH_BOX = 1 + 2 * GLYPH_PAD_Y

		/**
		 * 框的圆角占框高的几分之几。
		 *
		 * ⚠️ 别跟着描边宽度走。那样算出来的圆角在默认尺寸下只有 3px，放在一个十几像素
		 *    的框上几乎看不出是圆的 —— 远看就是个方框。跟着框高走才能一直圆得明显。
		 */
		const GLYPH_RADIUS = 0.3

		/**
		 * 一个码点横向占几个 em。
		 *
		 * 【为什么要分宽窄】以前一律按汉字算（一个码点 = 一个 em）。没有框的时候看不出来，
		 * 加了框之后立刻露馅：`A` 实际只有半个 em 宽，框却按一个 em 画，于是字两边空出一大片，
		 * 整个框又窄又长；而汉字的框就是贴着的。**同样是一个字，框的松紧差一倍** —— John
		 * 报的"有的空白特别多、不统一"就是这条。
		 *
		 * 判据只分两档，够用了：CJK / 全角 / emoji 这些是**方块字**，一个 em；
		 * 拉丁字母、数字、半角标点是**窄字**，按 0.6 em 算（常见无衬线字体里大写字母约
		 * 0.67、小写约 0.55、数字 0.56，取中间偏上，宁可框略松也不要字糊出去）。
		 * @param code - 码点
		 * @returns em 数
		 */
		function emWidth(code) {
			if (code === undefined) return 0
			// ASCII 可打印字符 + 拉丁扩展 + 音标：窄
			if (code >= 0x20 && code <= 0x2ff) return 0.6
			// 希腊 / 西里尔：也是窄字
			if (code >= 0x370 && code <= 0x4ff) return 0.6
			// 半角片假名 / 半角符号
			if (code >= 0xff61 && code <= 0xffdc) return 0.6
			// 其余（CJK、假名、全角、emoji、各种符号）一律按方块字算
			return 1
		}

		/**
		 * 一串字横向一共占几个 em。
		 * @param glyph - 那几个字
		 * @returns em 数；空串按 1 算（别把除法炸掉）
		 *
		 * ⚠️ 别写成 `Math.max(sum, 1)`。那样一个 `A` 会被当成一个汉字那么宽，
		 *    这个函数存在的唯一理由当场作废。兜底只该兜**空串**。
		 */
		function glyphEm(glyph) {
			let sum = 0
			for (const ch of String(glyph)) sum += emWidth(ch.codePointAt(0))
			return sum > 0 ? sum : 1
		}

		/**
		 * 这几个字该用多大的字号。
		 *
		 * 先按点的直径给满，**只有摊不下的时候才缩** —— 缩的判据是 `GLYPH_SPAN` 那个封顶，
		 * 所以一个字母和一个汉字用的是同一个字号（它俩只是占宽不同），不会出现"字母显得小一号"。
		 *
		 * 小例子（点直径 10，封顶 3 倍）：
		 *   `甲` → em 1，字号 10；`甲乙丙` → em 3，字号 10（正好顶到封顶）；
		 *   `一二三四五` → em 5，字号 10×3/5 = 6；
		 *   `Hello` → em 3，字号 10（五个字母才占三个汉字宽，不用缩）。
		 * @param glyph - 那几个字
		 * @param size - 点的直径
		 * @returns 字号（像素）
		 */
		function glyphFont(glyph, size) {
			return size * Math.min(1, GLYPH_SPAN / glyphEm(glyph))
		}

		/**
		 * 带框的字横向占点直径的几倍（`shapeSpec` 把它塞进 `grow`，列距和连线让位自动跟着走）。
		 *
		 * = 字本身的宽 + 左右各一圈 `GLYPH_PAD_X`，**并且不许比高还窄**：
		 * 一个 `i` 只有 0.3 em，不兜底的话会画成一个瘦条；兜住之后它就是个圆角方块，
		 * 和预设里的"圆角方"一模一样 —— 这也是统一。
		 * @param glyph - 那几个字
		 * @returns 倍数
		 */
		function glyphGrow(glyph) {
			const em = glyphEm(glyph)
			const wide = (glyphFont(glyph, 1) * em) + 2 * GLYPH_PAD_X
			return Math.max(wide, GLYPH_BOX)
		}

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
			poly('triangle', [[0, 0.1], [1, 0.1], [0.5, 0.97]]),
			// 倒三角：和三角共用一套坐标上下翻过来。至今为止"压缩"用正三角，
			// 倒三角留给用户自己指派 —— 一正一倒在 11px 上也分得清，这是小尺寸下
			// 少数几对真的看得出区别的形状。
			poly('triangle-down', [[0, 0.9], [1, 0.9], [0.5, 0.03]]),
			poly('chevron', [[0.08, 0.05], [0.95, 0.5], [0.08, 0.95], [0.32, 0.5]]),
			poly('pentagon', regularPoly(5)),
			// 六边形取**平顶**那一版（转 30°）。尖顶六边形在 11px 上和圆几乎一样，
			// 平顶那条横边才是它在小尺寸下唯一的辨识点。
			poly('hexagon', regularPoly(6, Math.PI / 6)),
			poly('cross', crossPoly(0.4)),
			// 四角星。五角星留给"收藏"那层记号，这里用四角的，免得两件事撞脸。
			poly('sparkle', starPoly(4, 0.34)),
			// 沙漏。⚠️ 别写成"左上→右下→左下→右上"那个自交四边形：画出来是对的，
			// 但鞋带公式对自交图形给的是**带符号面积的净值**，上下两个三角朝向相反、
			// 正好抵成 0，`growOf` 于是除出一个天文数字（实测 2.4 亿倍）。
			// 老老实实带个腰画成简单多边形。
			poly('bowtie', [[0, 0.02], [1, 0.02], [0.58, 0.5], [1, 0.98], [0, 0.98], [0.42, 0.5]]),
		]

		/**
		 * 一个多边形形状的条目。`grow` 一律**算出来**，不手抄小数。
		 *
		 * ⚠️ 以前 `grow` 是注释里算一遍、代码里抄一个两位小数（三角 1.34、星星 1.67）。
		 *    加一个新形状就得再手算一次面积比，而算错的那个"看着小一圈"没有任何断言会响。
		 * @param value - 形状 id（存进设置里的就是它）
		 * @param points - 单位框（0..1）里的顶点
		 * @returns SHAPES 的一条
		 */
		function poly(value, points) {
			return { value, radius: 'px', spin: false, grow: growOf(points), poly: points }
		}

		/**
		 * 多边形面积（鞋带公式）。
		 *
		 * ⚠️ **只对简单多边形有效**。自交图形给的是带符号面积的**净值** —— 朝向相反的两块
		 *    会互相抵消。沙漏画成"左上→右下→左下→右上"的自交四边形时，这里算出来是 0
		 *    （浮点残渣 1.6e-17），`growOf` 除一下就是 2.4 亿倍。所以 SHAPES 里的顶点
		 *    必须首尾不交叉，test-highlight 用例 24 有一条专门盯着"每个形状面积都 > 0"。
		 * @param points - 单位框里的顶点
		 * @returns 面积，恒非负
		 */
		function polyArea(points) {
			let sum = 0
			for (let i = 0; i < points.length; i += 1) {
				const [x1, y1] = points[i]
				const [x2, y2] = points[(i + 1) % points.length]
				sum += x1 * y2 - x2 * y1
			}
			return Math.abs(sum) / 2
		}

		/**
		 * 这个多边形要放大多少，才和同边长的正圆**看着一样大**。
		 *
		 * ⚠️ 配的是**面积**不是边长。底 1 高 0.87 的三角只占单位框的 0.435，
		 *    正圆占 π/4 ≈ 0.785 —— 同边长画出来，三角明显小一号。
		 * @param points - 单位框里的顶点
		 * @returns 放大倍数，恒 >= 1（面积算不出来时退回 1）
		 */
		function growOf(points) {
			const area = polyArea(points)
			// ⚠️ 判的是"小到不像话"，不是 `<= 0`。自交图形抵消之后剩的是 1.6e-17 这种
			//    浮点残渣，它**大于 0** —— 放行的话 grow 会变成两亿多，那个点会占满整块屏。
			//    单位框里任何画得出来的形状面积都远大于 1e-6。
			return area <= 1e-6 ? 1 : Math.sqrt(Math.PI / 4 / area)
		}

		/**
		 * 正 n 边形的顶点，外接圆半径 0.5（顶格）。
		 *
		 * 和 `starPoly` 一个道理：算出来而不是抄一串小数，改边数只要改一个整数。
		 * @param sides - 几条边，至少 3
		 * @param turn - 整体再转多少弧度（六边形要转 30° 才是平顶）
		 * @returns 单位框（0..1）里的顶点
		 */
		function regularPoly(sides, turn) {
			const n = Math.max(3, Math.round(sides))
			const spin = turn === undefined ? 0 : turn
			const out = []
			for (let i = 0; i < n; i += 1) {
				// 从正上方开始（-90°），顺时针排
				const angle = (2 * Math.PI * i) / n - Math.PI / 2 + spin
				out.push([0.5 + 0.5 * Math.cos(angle), 0.5 + 0.5 * Math.sin(angle)])
			}
			return out
		}

		/**
		 * 十字（加号）的十二个顶点。
		 * @param thick - 横竖两臂占单位框的比例，0..1
		 * @returns 单位框（0..1）里的顶点
		 */
		function crossPoly(thick) {
			const t = Math.min(0.98, Math.max(0.02, thick === undefined ? 0.4 : thick))
			const lo = (1 - t) / 2
			const hi = 1 - lo
			return [
				[lo, 0], [hi, 0], [hi, lo], [1, lo], [1, hi], [hi, hi],
				[hi, 1], [lo, 1], [lo, hi], [0, hi], [0, lo], [lo, lo],
			]
		}

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
		 * 一个形状在**屏幕上横向实际占多宽**。列距要按它来留，不能按 `shapeBox`。
		 *
		 * ⚠️ 和 `shapeBox` 的差别在菱形这类 `spin` 形状上：它是个正方形转了 45°，
		 *    边长还是 `shapeBox`，但**外接宽度是对角线**，多出 41%。
		 *    按边长留列距的话，两列菱形的尖角会正好戳到一起。
		 *    （`reachFor` 里那个 `size * 0.71` 就是这条的一半，两处是同一个事实。）
		 * @param shape - shapeSpec 的结果
		 * @param size - 点的直径
		 * @returns 横向占宽（像素）
		 */
		function drawnWidth(shape, size) {
			const edge = shapeBox(shape, size)
			return shape.spin ? edge * Math.SQRT2 : edge
		}

		/**
		 * 一个形状在**屏幕上竖向实际占多高**。连线在两端让位要按它来留。
		 *
		 * ⚠️ 只有自定义字和 `drawnWidth` 不对称：字是**横着摊开**的，`grow` 描述的是
		 *    它横向占几倍宽，竖直方向永远只有一个字那么高。按 `shapeBox` 让位的话，
		 *    挂了个 3 字标签的点上下会凭空空出两倍的缝。
		 * @param shape - shapeSpec 的结果
		 * @param size - 点的直径
		 * @returns 竖向占高（像素）
		 */
		function shapeHeight(shape, size) {
			// 字是横着摊开的：`grow` 说的是横向几倍宽，竖直方向永远只有一个字那么高，
			// 再加上外面那圈框 —— 所以是 `GLYPH_PAD`，不是 `grow`。
			if (shape.glyph !== undefined) return size * GLYPH_BOX
			return shapeBox(shape, size)
		}

		/**
		 * 上传的图的地址。
		 * @param id - 图片 id（内容哈希）
		 * @returns URL
		 */
		function iconUrl(id) {
			// ⚠️ 要带上 net.js 试出来的前缀：局域网页面走的是 /remote 通道，
			//    而这是 CSS background 里的 url()，被围栏拒了不会重试，图就那么空着了。
			return `${apiPrefix()}${ICON_URL}?id=${encodeURIComponent(id)}`
		}

		/**
		 * 收藏的黄。**全局只有这一个色值**，明暗两边都从它算出来。
		 *
		 * 【为什么不再手写两版】原来是 `{dark:'#e3b341', light:'#b8860b'}`。亮色那版是把
		 * 同一个黄压深到能在白底上读出来（对白底 3.25:1），代价是它**已经不像黄了** ——
		 * 深金 `#b8860b` 的相对亮度只有 0.27，摆在白底上眼睛读成的是"一圈黑线"
		 * （John 报的"浅色模式下特别黑"）。
		 *
		 * 【为什么是这个值】这是 Open Color 的 yellow-4。挑它的判据是可以量的：
		 *   · 亮度 0.69 —— 够亮，深底上 13.3:1，一眼是黄的
		 *   · 色相 47°  —— 暖金，不是 58° 那种发酸的柠檬黄
		 *   · 由它算出的描边 `#b88f00` 在白底上 3.01:1，对星身 2.11:1，两头都描得出边
		 * （老的 `#e3b341` 亮度只有 0.49，算出来的描边对星身才 1.54:1，边几乎看不见。）
		 *
		 * 【它怎么落到两种底色上】不靠"星身一个色、描边另一个色"那套分工了 —— 那正是
		 * "同一个色号，普通节点和收藏节点看起来不一样"的来源。现在和别的颜色走同一条路：
		 * 上屏前过一遍 `readable`，暗底上它自己就够亮（13.3:1，一个像素不变），
		 * 亮底上整体压深到 3:1。**描边和填充永远是这同一个颜色**，只差一个透明度。
		 */
		const STAR_COLOR = '#ffd43b'

		// ===== 配色：一套，亮色和暗色各一版 =====
		//
		// 为什么要分明暗两版：同一个色号在白底和深底上**观感完全不同**。亮蓝 `#58a6ff`
		// 在深底上清亮，糊到白底上就发飘、和灰的区分度掉一半。所以亮色版整体压了明度、
		// 提了饱和度（深一点才压得住白底），暗色版则相反。
		//
		// 只有这四个"角色色"是真实色值，因为它们要参与 `rgba()` 运算（路径垫色、外发光）；
		// 其余中性色全走宿主的 `--dsw-alias-*` 变量（见 const.js 的 C）。
		//
		// ⚠️ 改色值的时候**两版一起看**：亮版要压得住白底，暗版要在深底上亮得起来，
		//    只改一边必然有一个模式变难看。test-highlight 的用例 16 盯着这件事。

		/**
		 * 唯一那套配色。
		 *
		 * 空节点跟当前路径同色：它本来就永远在当前路径上，不该长得像另一种东西。
		 * 虚线边才是它自己的记号（在 ROLES 里），不跟着颜色走。
		 */
		const PALETTE = {
			dark: { normalColor: '#6e7681', currentColor: '#58a6ff', compactColor: '#ffa657', emptyColor: '#58a6ff' },
			// 压缩色用的是宿主自己的 amber-600（`--dsw-static-amber-600`），
			// 和界面其它"警示"语义同色；早先那个 #bc4c00 烧焦橙在白底上太闷。
			light: { normalColor: '#8c959f', currentColor: '#1f6feb', compactColor: '#dd8629', emptyColor: '#1f6feb' },
		}

		/**
		 * 形状默认值。颜色跟着 `PALETTE` 走，不写在这儿。
		 *
		 * `favoriteShape` 在这儿而不在 PALETTE 里，是因为收藏的默认色**不分明暗**
		 * （就一个 `STAR_COLOR`，明暗差别交给 `readable` 在上屏前统一处理）。
		 */
		const SHAPE_DEFAULTS = {
			normalShape: 'circle',
			currentShape: 'circle',
			compactShape: 'triangle',
			emptyShape: 'circle',
			favoriteShape: 'star',
			favoriteColor: STAR_COLOR,
		}

		/**
		 * 当前明暗下的那一版。
		 * @param dark - 是不是暗色
		 * @returns 四个角色的颜色 + 形状
		 */
		function paletteOf(dark) {
			return Object.assign({}, SHAPE_DEFAULTS, dark === false ? PALETTE.light : PALETTE.dark)
		}

		/**
		 * 默认主题 = 暗色版。
		 *
		 * 留着它是因为一堆地方要一个"没有设置时也能画"的兜底（`shapeOf(kind, active)`
		 * 不传 theme 时用的就是它）。真正画树时 Rail 会按**当前明暗**现算一份。
		 */
		const THEME = paletteOf(true)


		// ===== 收藏：五角星 =====
		//
		// 收藏和「角色」（普通/当前/压缩/空）**正交** —— 它不是第五种节点，而是盖在任何一种
		// 节点上的一层记号，所以它既不进 ROLES，也不进 THEME / 设置卡。
		// （进了 THEME 就得在设置里给它配颜色和形状，而"收藏"的意思本来就钉死在
		//  "黄色五角星"这四个字上，可配等于可改坏。test-highlight 用例 15 那条
		//  「THEME 的每个键都要在设置里露面」的不变式也就自然保住了。）

		/**
		 * 五角星的顶点。外接圆半径 0.5（顶格），内角半径按正五角星的 1/φ² ≈ 0.382 收进去。
		 *
		 * 算出来而不是抄一串小数：改成六角星只要把 `points` 换成 6，
		 * 而一串手抄的坐标改错一个小数点是看不出来的。
		 * @param points - 几个角
		 * @param inner - 内角半径占外角的比例
		 * @returns 单位框（0..1）里的顶点，可直接交给 polyPoints
		 */
		function starPoly(points, inner) {
			const tips = points === undefined ? 5 : points
			const ratio = inner === undefined ? 0.382 : inner
			const out = []
			for (let i = 0; i < tips * 2; i += 1) {
				// 从正上方开始（-90°），外角内角交替
				const angle = (Math.PI / tips) * i - Math.PI / 2
				const r = 0.5 * (i % 2 === 0 ? 1 : ratio)
				out.push([0.5 + r * Math.cos(angle), 0.5 + r * Math.sin(angle)])
			}
			return out
		}

		/**
		 * 收藏节点的**默认**形状。
		 *
		 * `grow` 和别的多边形一样交给 `growOf` 算：正五角星（R=0.5, r=0.191）占单位框
		 * 约 0.281，正圆占 π/4 ≈ 0.785，所以放大 √(0.785/0.281) ≈ 1.67 倍看着才一样大。
		 * 直接和圆同边长的话，星星的五个角把面积摊开，看着会小一圈。
		 *
		 * ⚠️ 它**不在 `SHAPES` 里**，所以 `shapeSpec('star')` 认不得它（会退回圆）。
		 *    这是故意的：五角星是"收藏"这层记号的专属，进了 SHAPES 就会出现在四个角色的
		 *    形状选择器里，于是"哪个是收藏"当场失效。收藏自己那条路走 `favShape`。
		 */
		const STAR = poly('star', starPoly())

		/**
		 * 一个收藏节点该用哪个形状。
		 *
		 * 收藏**可以换图标**（详情卡里那一排）。颜色**默认**恒为那个黄 ——
		 * 那是"一眼能扫出来"的全部依据，所以不改的话谁都是黄的；
		 * 真要按点分色（比如红=待办、绿=已验证）也给得出，见 `want`。
		 * @param want - 用户挑的形状值：预设 id / `char:<字>` / `img:<id>`；空 = 默认
		 * @returns 画法；空或认不得一律退回五角星
		 */
		function favShape(want) {
			const text = typeof want === 'string' ? want.trim() : ''
			if (text === '' || text === STAR.value) return STAR
			const spec = shapeSpec(text)
			// ⚠️ `shapeSpec` 认不得的东西退回的是**圆**，而收藏的默认不是圆是星。
			//    不拦这一下的话，手改配置写错一个字，一屏收藏全变成普通圆点。
			return spec.value === text ? spec : STAR
		}


		/**
		 * 算对比度用的参考底色。
		 *
		 * ⚠️ 真实底色是宿主的 CSS 变量（`--dsw-alias-bg-layer-1`），JS 读不到也算不了，
		 *    所以拿这两个当代表。偏一点无所谓：`fitContrast` 只用它定"往亮调还是往暗调、调到哪"。
		 */
		const BACKDROP = { dark: '#0d1117', light: '#ffffff' }

		/** 图形类元素的对比度下限（WCAG 1.4.11 非文本对比度就是 3:1）。 */
		const CONTRAST_MIN = 3

		/**
		 * 普通态下填充的不透明度。
		 *
		 * **全局只有这一个数**。以前四个角色各写一个（普通=不填、当前=0.18、压缩=0.3、
		 * 空=0.15），于是同一个色号挂到不同角色上深浅差一倍，谁都说不清"我设的颜色"
		 * 到底应该长什么样 —— John 报的"看起来有色差"就是这条。
		 */
		const FILL_ALPHA = 0.18

		/**
		 * 把一个颜色推到对当前底色**至少 3:1**，方向按明暗定。
		 *
		 * 【为什么要有这一步】用户挑的色号是个绝对值，而它要落在两种底色上。亮黄
		 * `#ffd43b` 对深底 13:1（好看），对白底只有 1.4:1（基本看不见）。业界的做法是
		 * **令牌随主题解析**（Material 的 tonal palette、Primer 的 functional color）：
		 * 同一个语义色在亮暗两套里本来就是两个不同的明度，而不是画的时候临时补救。
		 * 这里就是那一步 —— 一个颜色上屏前先过它，之后描边和填充都从结果派生。
		 *
		 * ⚠️ 只推明度，色相和饱和度不动（`fitContrast` 保证）。推的是"刚好够"的那一档，
		 *    不是推到底 —— 调过头只会离用户挑的那个颜色越来越远。
		 * @param hex - 用户挑的颜色 `#rrggbb`
		 * @param dark - 是不是暗色主题；省略按暗色算（`THEME` 就是暗色版）
		 * @returns `#rrggbb`
		 */
		function readable(hex, dark) {
			const light = dark === false
			const page = light ? BACKDROP.light : BACKDROP.dark
			if (contrastRatio(hex, page) >= CONTRAST_MIN - 1e-9) return hex
			// 亮底上往深里推，深底上往亮里推 —— 反过来推只会撞进底色里
			return fitContrast(hex, page, CONTRAST_MIN, light ? 'darker' : 'lighter')
		}

		/**
		 * 实心底上放什么颜色的内容（自定义的那个字）。
		 *
		 * 就是业界说的 on-color：底色实了之后，压在上面的字必须换成和底色对比最大的那个，
		 * 不然字会糊进底色里 —— **而且恰好是"正看着的这一轮"最糊**，因为它填得最实。
		 * @param hex - 底下那块实色
		 * @returns `#ffffff` 或 `#0d1117`
		 */
		function onAccent(hex) {
			return contrastRatio(hex, BACKDROP.light) >= contrastRatio(hex, BACKDROP.dark) ? BACKDROP.light : BACKDROP.dark
		}

		/**
		 * WCAG 相对亮度。
		 * @param hex - `#rrggbb`
		 * @returns 0..1；认不出来的返回 0
		 */
		function relLuminance(hex) {
			const matched = /^#([0-9a-fA-F]{6})$/.exec(String(hex || ''))
			if (matched === null) return 0
			const parts = [0, 2, 4].map((at) => {
				const channel = Number.parseInt(matched[1].slice(at, at + 2), 16) / 255
				return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4
			})
			return 0.2126 * parts[0] + 0.7152 * parts[1] + 0.0722 * parts[2]
		}

		/**
		 * 两个颜色的对比度，1..21。
		 * @param one - `#rrggbb`
		 * @param other - `#rrggbb`
		 * @returns 比值，恒 >= 1
		 */
		function contrastRatio(one, other) {
			const a = relLuminance(one)
			const b = relLuminance(other)
			return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)
		}

		/**
		 * `#rrggbb` → HSL（h 0..360，s/l 0..1）。
		 * @param hex - `#rrggbb`
		 * @returns `{h, s, l}`
		 */
		function hexToHsl(hex) {
			const matched = /^#([0-9a-fA-F]{6})$/.exec(String(hex || ''))
			if (matched === null) return { h: 0, s: 0, l: 0 }
			const [r, g, b] = [0, 2, 4].map((at) => Number.parseInt(matched[1].slice(at, at + 2), 16) / 255)
			const high = Math.max(r, g, b)
			const low = Math.min(r, g, b)
			const span = high - low
			const l = (high + low) / 2
			if (span === 0) return { h: 0, s: 0, l }
			const s = span / (1 - Math.abs(2 * l - 1))
			const h = high === r
				? ((g - b) / span + (g < b ? 6 : 0))
				: high === g
					? (b - r) / span + 2
					: (r - g) / span + 4
			return { h: h * 60, s, l }
		}

		/**
		 * HSL → `#rrggbb`。
		 * @param hsl - `{h, s, l}`
		 * @returns `#rrggbb`
		 */
		function hslToHex(hsl) {
			const h = ((hsl.h % 360) + 360) % 360
			const s = Math.min(1, Math.max(0, hsl.s))
			const l = Math.min(1, Math.max(0, hsl.l))
			const c = (1 - Math.abs(2 * l - 1)) * s
			const x = c * (1 - Math.abs(((h / 60) % 2) - 1))
			const m = l - c / 2
			const slot = Math.floor(h / 60) % 6
			const rgb = [[c, x, 0], [x, c, 0], [0, c, x], [0, x, c], [x, 0, c], [c, 0, x]][slot]
			return `#${rgb.map((one) => Math.round((one + m) * 255).toString(16).padStart(2, '0')).join('')}`
		}

		/**
		 * 把一个颜色**只调明度**，直到它对指定底色够 `target` 倍对比度。
		 *
		 * 色相和饱和度一个都不动 —— 所以调出来的还是"同一个颜色"，只是深浅换了。
		 * 已经够了就原样返回（暗色模式下那个黄走的就是这条：对深底 9.7:1，一个像素不变）。
		 * 那个提前返回只是**省一次二分**，不是行为保证 —— 二分本来也会收敛回原色。
		 *
		 * 往哪边调：缺省由底色决定（底色亮就往深里调，底色深就往亮里调）。
		 * `dir` 给 `'darker'` / `'lighter'` 可以钉死方向 —— `readable` 就钉死：
		 * 亮底往深里调、深底往亮里调，反过来只会撞进底色里。
		 * 调到 0 或 1 还够不着就交回能拿到的最好的那个 —— 纯黑纯白都够不着的目标不存在，
		 * 但传进来一个奇怪的 target 时不该死循环。
		 *
		 * 小例子（`#e3b341` 对白底，目标 3）：
		 *   原色亮度 0.49，对白底才 1.95:1 → 往深里二分，明度从 0.57 一路压到约 0.42，
		 *   得到一个更深的金色，对白底 3.0:1；色相仍是 42°、饱和度仍是 73%。
		 * @param hex - `#rrggbb`
		 * @param backdrop - 底色 `#rrggbb`
		 * @param target - 对比度目标，缺省 `CONTRAST_MIN`
		 * @param dir - `'darker'` / `'lighter'` 钉死方向；缺省看底色
		 * @returns `#rrggbb`；认不出来的原样返回
		 */
		function fitContrast(hex, backdrop, target, dir) {
			const want = Number.isFinite(target) && target > 1 ? target : CONTRAST_MIN
			if (!/^#[0-9a-fA-F]{6}$/.test(String(hex || ''))) return hex
			if (contrastRatio(hex, backdrop) >= want) return hex
			const hsl = hexToHsl(hex)
			// 缺省：底色亮 → 往深里调；底色深 → 往亮里调
			const down = dir === 'darker' ? true : dir === 'lighter' ? false : relLuminance(backdrop) > 0.5
			let lo = down ? 0 : hsl.l
			let hi = down ? hsl.l : 1
			let best = down ? hslToHex({ h: hsl.h, s: hsl.s, l: 0 }) : hslToHex({ h: hsl.h, s: hsl.s, l: 1 })
			// 二分 24 次，明度精度到 1e-7 —— 远超 8 位色深分得出的粒度
			for (let step = 0; step < 24; step += 1) {
				const mid = (lo + hi) / 2
				const tried = hslToHex({ h: hsl.h, s: hsl.s, l: mid })
				if (contrastRatio(tried, backdrop) >= want) {
					// 够了就往回收一点，取**刚好够**的那个（调过头只会更暗/更白，更不像原色）
					best = tried
					if (down) lo = mid
					else hi = mid
				} else if (down) hi = mid
				else lo = mid
			}
			return best
		}


		/**
		 * 收藏节点的颜色。
		 *
		 * **和普通节点同一条规则** —— 这正是它存在的全部意义：收藏只换「用哪个色号」和
		 * 「画成什么形状」，怎么上色一个字都不改。所以一个普通节点和一个收藏节点配同一个
		 * 色号时，它俩长得一模一样（只差形状），不会再出现 John 报的那种"同一个颜色，
		 * 看起来却有色差"。
		 *
		 * ⚠️ 别再给收藏开小灶。以前它是"星身填亮黄 + 描边另算一个压深的同色"，于是
		 *    同一个 `#ffd43b`，普通节点是"空心黄边"、收藏是"实心黄 + 暗黄边"——
		 *    三个颜色，用户设的只有一个，哪个都对不上。
		 * @param focused - 正看着这一轮（= 当前点）
		 * @param dark - 是不是暗色
		 * @param icon - 这个点自己挑的图标；空 = 跟着默认走
		 * @param want - 这个点自己挑的颜色；空 / 认不得 = 跟着默认走
		 * @param theme - 当前主题；收藏的默认色和默认图标在设置里可改，从这儿取
		 * @returns 和 `inkOf` 一模一样的 `{accent, ink, fill, solid}`，外加一个 `shape`
		 */
		function starSkin(focused, dark, icon, want, theme) {
			const skin = theme || THEME
			// 用户改过这个点就用他挑的；没改过就用设置里的默认；设置也认不得就退回出厂那个黄。
			// 认得严一点：这个字符串要直接进 CSS。
			const ok = (value) => typeof value === 'string' && /^#[0-9a-fA-F]{6}$/.test(value)
			const seed = (ok(want) ? want : ok(skin.favoriteColor) ? skin.favoriteColor : STAR_COLOR).toLowerCase()
			return Object.assign(paint(seed, focused, dark), {
				shape: favShape(icon === undefined || icon === null || icon === '' ? skin.favoriteShape : icon),
			})
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
		 *   · `own`  —— 自带颜色，不随"在不在当前路径上"变（靠颜色表明**自己是什么**，
		 *               而不是表明**自己在哪**）
		 *   · `dashed` —— 虚线边，"还没说话"的记号；不跟着配置走
		 *
		 * ⚠️ **这里不许再出现"描边多透明""填充多透明"这类数字。** 原来四个角色各写一份
		 *    （普通=不填、当前=0.18、压缩=0.3、空=0.15，描边还有 1 和 0.9 之分），
		 *    于是同一个色号挂到不同角色上深浅差一倍。深浅归 `paint`，那儿只有一个 `FILL_ALPHA`。
		 */
		const ROLES = {
			normal: { color: 'normalColor', shape: 'normalShape' },
			current: { color: 'currentColor', shape: 'currentShape' },
			compact: { color: 'compactColor', shape: 'compactShape', own: true },
			empty: { color: 'emptyColor', shape: 'emptyShape', own: true, dashed: true, plus: 2 },
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
				// grow = 横向占几倍宽。挂在 spec 上，列距和连线让位就自动跟着走了。
				// `grow` 是**连框在内**的占宽，`glyphGrow` 已经把那圈 `GLYPH_PAD` 算进去了
				if (glyph !== '' && [...glyph].length <= GLYPH_MAX)
					return { value: text, radius: 'px', spin: false, glyph, grow: glyphGrow(glyph) }
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
		 * @param dark - 是不是暗色主题；省略按暗色算
		 * @param override - 已经解析好的画法。收藏那排要用 `favShape` 解（`'star'` 在
		 *                   `shapeSpec` 眼里是认不得的，会退回圆），所以给个口子让调用方
		 *                   把解析权拿走 —— 而不是在这里再塞一个"是不是收藏"的开关。
		 * @returns 一个 <span>
		 */
		function preview(want, color, size, dashed, override, dark) {
			const spec = override === undefined || override === null ? shapeSpec(want) : override
			// ⚠️ 选择器里看到的必须是**节点平时的样子**，所以走同一个 `paint`（非实心那一档）。
			//    以前这里写死 0.3、树上普通节点又是不填 —— 于是选择器里挑的和树上画出来的
			//    深浅对不上；收藏那排更离谱，选择器是半透明、树上是实心。
			const skin = paint(color, false, dark)
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
				// ⚠️ 字要按 `size / GLYPH_PAD` 画：这里的外框是固定的 size×size 小方块，
				//    而带框的字占 `size × GLYPH_PAD`，照原尺寸画会从选择器按钮里溢出来。
				//    缩回去之后单字正好填满这颗预览，和别的形状一样齐。
			}, dotInside(spec, spec.glyph === undefined ? size : size / GLYPH_PAD, skin, 1.5, dashed))
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
		 * **全树唯一的上色规则。** 一个颜色进来，描边和填充出去。
		 *
		 * ```
		 * 普通态：描边 = 这个色        填充 = 这个色 @ FILL_ALPHA
		 * 实心态：描边 = 这个色        填充 = 这个色（不透明）
		 * ```
		 *
		 * 描边和填充**永远是同一个颜色**，差别只有一个透明度 —— 所以"我设的那个颜色"
		 * 指的就是它，不存在第二个答案。这是 Material / Primer / Ant Design 这些成熟
		 * 设计系统的通行写法（一个 accent 令牌，填充是它的低透明度版，选中时填实）。
		 *
		 * 实心态**只有一个含义：正看着这一轮**。别再往里塞第二个含义 —— 收藏、压缩、
		 * 空节点靠颜色和形状表达自己，不靠填不填实。
		 * @param color - 用户挑的颜色 `#rrggbb`
		 * @param focused - 正看着这一轮
		 * @param dark - 是不是暗色主题
		 * @returns `{accent, ink, fill, solid}`
		 */
		function paint(color, focused, dark) {
			const ink = readable(color, dark)
			const solid = focused === true
			// accent（外发光）就用同一个色。以前它另取"这个 kind 在当前路径上的颜色"，
			// 于是一个配成绿色的普通节点，滚到它那一轮时会发蓝光 —— 又一个对不上的颜色。
			return { accent: ink, ink, fill: solid ? ink : fade(ink, FILL_ALPHA), solid }
		}

		/**
		 * 一个节点该用哪个颜色，然后交给 `paint` 上色。
		 * @param kind - normal / compact / empty
		 * @param active - 在当前路径上
		 * @param focused - 正看着这一轮
		 * @param theme - 颜色与形状，缺省用 THEME
		 * @param dark - 是不是暗色主题；省略按暗色算（`THEME` 就是暗色版）
		 * @returns `{accent, ink, fill, solid}`
		 */
		function inkOf(kind, active, focused, theme, dark) {
			const skin = theme || THEME
			return paint(skin[ROLES[roleOf(kind, active)].color], focused, dark)
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
		 * @param star - `starSkin()` 的结果；给了就整个换成五角星（收藏），不给就照角色画
		 * @param dark - 是不是暗色主题；省略按暗色算
		 * @returns 内联样式
		 */
		function dotStyle(kind, active, hover, size, focused, theme, alpha, star, dark) {
			const k = size / Z.dot
			// 收藏过的点整个换成五角星：形状和颜色都由 `star` 说了算，角色那一套全部让位。
			// 之所以传进来一个**算好的 skin** 而不是一个 `starred` 布尔，是因为星星的黄
			// 要分明暗两版，而 dotStyle 手里只有 theme、不知道现在是明是暗。
			// 收藏的形状由 `starSkin` 一起带过来（用户能在详情卡里换图标）；
			// 老调用方只传 `{accent, ink, fill}` 的话退回五角星。
			const shape = star === undefined ? shapeOf(kind, active, theme) : star.shape || STAR
			const { accent, ink, fill } = star === undefined ? inkOf(kind, active, focused, theme, dark) : star
			// 多边形 / 字 / 图片都不靠这个 <span> 的 border+background 成形：
			// 方框会在图形外面套一圈，所以这三类一律把方框关掉，由里面的内容自己画。
			// 外发光也得换 —— box-shadow 画的是**方框**的光晕，套在三角外面就是个方的光。
			const drawn = shape.poly !== undefined || shape.glyph !== undefined || shape.image !== undefined
			return {
				width: `${size}px`, height: `${size}px`,
				borderRadius: shape.radius === 'px' ? `${1.5 * k}px` : shape.radius,
				borderWidth: drawn ? '0px' : `${1.5 * k}px`,
				// 星星不画虚线：它自己就是记号了，再虚一圈只会看不清那五个角
				borderStyle: star === undefined && dashedOf(kind) ? 'dashed' : 'solid',
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
				// 收藏过的点**不跟着路径外那一档淡**（0.4 → 0.85）：收藏的意思就是"待会儿
				// 我要回来找它"，而它多半不在当前路径上 —— 淡到看不见就白收藏了。
				opacity: (focused || active ? 1 : star === undefined ? 0.4 : 0.85) * (alpha === undefined ? 1 : alpha),
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
			// ⚠️ 字**不能**直接当 <span> 的文本内容返回。那个 span 是 size×size 的方框，
			//    两个字以上就会从右边糊出去（不是居中溢出）—— 这就是"超过 2 个字就不对劲"的
			//    另一半。和多边形一样绝对居中，字号按字数自己缩，横向往两边等量溢出。
			if (shape.glyph !== undefined) return h('span', { style: glyphBoxStyle(shape, size, skin, stroke, dashed) }, shape.glyph)
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
		 * 自定义字外面那个框的内联样式。
		 *
		 * 单独抽出来是为了**能测**（和 `polyProps` 同一个理由）：描边色、填充色、线宽
		 * 必须和方框类形状同源，藏在渲染函数里的话，哪天有人把边去掉或者换个颜色，
		 * 一条断言都不会响 —— 而一排节点里混一个"没有边、直接浮着的字"，一眼就看得出
		 * 是两拨人画的。
		 *
		 * ⚠️ 盒子的大小必须正好是布局给它留的那块（`drawnWidth` × `shapeHeight`）。
		 *    画小了框和字之间空一圈，画大了就糊到隔壁列上 —— 两边都只会在真机上才看见。
		 * @param shape - shapeSpec 的结果，要有 `glyph`
		 * @param size - 点的直径
		 * @param skin - `inkOf` 的结果
		 * @param stroke - 描边宽度，和同尺寸下方框类形状的边框一样粗
		 * @param dashed - 画成虚线（空节点的记号）
		 * @returns 内联样式
		 */
		function glyphBoxStyle(shape, size, skin, stroke, dashed) {
			return {
				position: 'absolute', left: '50%', top: '50%', transform: 'translate(-50%, -50%)',
				width: `${drawnWidth(shape, size)}px`, height: `${shapeHeight(shape, size)}px`,
				display: 'flex', alignItems: 'center', justifyContent: 'center', boxSizing: 'border-box',
				borderWidth: `${stroke}px`, borderStyle: dashed === true ? 'dashed' : 'solid', borderColor: skin.ink,
				borderRadius: `${shapeHeight(shape, size) * GLYPH_RADIUS}px`,
				// 填充和别的形状同一条规则（`paint`）：平时是主色的 18%，压不住字；
				// 实心时才填满，而那时字会换成 `onAccent` 的对比色，见下面那行。
				background: skin.fill,
				whiteSpace: 'nowrap', pointerEvents: 'none',
				// ⚠️ 实心底上必须换对比色。不换的话字和底同色 —— 而**恰好是"正看着的这一轮"
				//    最看不清**，因为它填得最实。这就是设计系统里的 on-color。
				fontSize: `${glyphFont(shape.glyph, size)}px`, lineHeight: 1,
				color: skin.solid === true ? onAccent(skin.ink) : skin.ink,
			}
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
		 * 小例子（聊天区高 600、缩放 100%、12 行、最宽 2 列、全是圆点）：
		 *   available = 600 - 16×2 = 568；rowH = min(24, 568/12) = 24；树高 288；
		 *   dotSize = min(11, 24-6) = 11；最宽形状就是圆点本身 11，
		 *   lane = max(17, 11+5) = 17（下限说了算）；edge = max(22, 16) = 22；
		 *   railWidth = 22 + 2×17 = 56；第 0 列的圆心 x = 56 - 11 = 45。
		 *
		 * 同一棵树，把其中一个点收藏成五角星（1.67 倍）之后：
		 *   最宽形状 = 11 × 1.67 = 18.4；lane = max(17, 23.4) = 23.4；edge = max(22, 23.4) = 23.4；
		 *   railWidth = 23.4 + 2×23.4 = 70.2 —— 列自己撑开了，星星不再和隔壁贴脸。
		 *
		 * 横向也有"放不下就压"这一档，和行高一个道理（见下面的 `room`）。
		 *
		 * @param box - 聊天区的位置和大小
		 * @param scale - 节点缩放百分比
		 * @param rows - 省略之后实际要画几行
		 * @param maxColumn - 图上最宽到第几列（**不是可见列** —— 省略随滚动变，导轨宽度不该跟着跳）
		 * @param widestOf - `(dotSize) => 这棵树上画得最宽的那个形状占多少像素`；
		 *                   省略就按"最宽的就是点本身"算（退回老几何）
		 * @param room - 横向最多能占多宽（`railRoom` 算的）。省略 = 不设限
		 * @returns 尺寸表 + 两个换算函数
		 */
		function railLayout(box, scale, rows, maxColumn, widestOf, room) {
			const z = scaleZ(scale)
			const available = box.height - z.pad * 2
			// 放不下就压行高（下限 rowMin）。鱼眼不额外占行：淡出的那两圈本来就在半径里面，
			// 顶底不再留"放省略号"的空行。
			const rowH = Math.max(z.rowMin, Math.min(z.row, available / Math.max(1, rows)))
			const dotSize = Math.max(z.dotMin, Math.min(z.dot, rowH - z.dotPad))
			// ⚠️ 列距按**这棵树上真画出来最宽的那个形状**留，不能按点的直径留。
			//    `Z.lane` 是圆点时代定的，只够放下 11px 的圆；收藏的五角星要 18.4px，
			//    四角星（sparkle）更要 19.9px —— 硬塞进 17px 的列里，相邻两列就贴在一起。
			//    这里只认"画多宽"，所以以后再加什么形状、用户传什么图标都自动跟着让。
			const widest = Math.max(dotSize, typeof widestOf === 'function' ? widestOf(dotSize) : 0)
			// 第 0 列靠着导轨右缘，留的宽度同理要够它自己画完，否则星星的右半边会探到导轨外面
			let edge = Math.max(z.hit, widest + z.laneGap)
			let lane = Math.max(z.lane, widest + z.laneGap)
			let railWidth = edge + maxColumn * lane
			// ⚠️ 横向也得有"放不下就压"这一档，和上面的行高一模一样的道理。
			//    列距现在跟着最宽的形状长，岔路一多、再挂几个宽图标，整棵树能一路长到
			//    盖住聊天正文、甚至从屏幕左边出去。`room` 是量出来的剩余空间（见 railRoom）。
			//
			//    压到底为止：`floor` 是"两个点还分得开"的最小列距，比这更窄就是叠在一起，
			//    压了也白压。真到了连 floor 都塞不下的地步（屏幕特别窄 + 树特别宽），
			//    那就让它超出去 —— 这时候把树画糊比画到界外更糟。
			const floor = Math.min(lane, Math.max(z.rowMin, dotSize + 2))
			if (Number.isFinite(room) && room > 0 && railWidth > room) {
				if (maxColumn > 0) {
					lane = Math.max(floor, (room - edge) / maxColumn)
					railWidth = edge + maxColumn * lane
				}
				// 列压到底还超，就只能动第 0 列那格（下限是命中区宽度，再窄就点不中了）
				if (railWidth > room) {
					edge = Math.max(z.hit, edge - (railWidth - room))
					railWidth = edge + maxColumn * lane
				}
			}
			return {
				z,
				available,
				rowH,
				treeHeight: rows * rowH,
				railWidth,
				lane,
				edge,
				dotSize,
				/** 第 column 列的圆心 x。列号从右往左长，所以是减。 */
				xOf: (column) => railWidth - edge / 2 - column * lane,
				/** 第 row 行的圆心 y。 */
				yOf: (row) => row * rowH + rowH / 2,
			}
		}

		/**
		 * 导轨离视口右缘多远（CSS 的 `right`，**值越大越靠左**）。
		 *
		 * **就是贴着聊天区右缘**，一个像素都不挪。
		 *
		 * ⚠️ 中间试过"在空当里居中"，John 试完说还是靠右好，撤回了。别再改回去：
		 *    居中会让树的横坐标随树宽（岔路数、有没有宽图标）浮动，眼睛得重新找一遍它在哪；
		 *    靠右则是钉死的，扫一眼就知道往哪看。空间不够是**压列距**解决的（见 railRoom），
		 *    不是靠挪位置解决。
		 *
		 * 参数留着 `railWidth` 没用上，是为了调用方不用记"这个函数现在不需要宽度了"——
		 * 将来真要按宽度调整位置，签名不用再动一次。
		 *
		 * @param box - 聊天区的位置和大小
		 * @param railWidth - 导轨宽度（当前不参与计算）
		 * @param viewWidth - 视口宽度
		 * @param gap - 树和聊天区右缘之间留多少，缺省 `Z.gap`
		 * @returns CSS 的 `right`，像素
		 */
		function railRight(box, railWidth, viewWidth, gap) {
			const pad = Number.isFinite(gap) ? gap : Z.gap
			return Math.max(0, viewWidth - box.right) + pad
		}

		/**
		 * 导轨横向最多能占多宽。
		 *
		 * 就是「聊天正文右缘 ～ 聊天区右缘」那条空当，两头各让 `gap`。
		 * 树贴着聊天区右缘往左长，长到这个数就该开始压列距了（见 railLayout 的 `room`）。
		 *
		 * ⚠️ 量不到正文右缘时**不能当作"随便长"**，要退回"到聊天区左缘为止"
		 *    （`content = 0`）—— 那至少挡住了"从屏幕左边长出去"这一半。
		 *
		 * 小例子（聊天区右缘 1600、正文右缘 1100、gap 20）：
		 *   room = 1600 - 20 - 1100 - 20 = 460，树最宽长到 460 就开始压。
		 * @param box - 聊天区的位置和大小，`contentRight` = 正文栏右缘
		 * @param gap - 两头各让多少，缺省 `Z.gap`
		 * @returns 像素，恒非负
		 */
		function railRoom(box, gap) {
			const pad = Number.isFinite(gap) ? gap : Z.gap
			const content = Number.isFinite(box.contentRight) ? box.contentRight : 0
			return Math.max(0, box.right - pad - content - pad)
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
		 * @param starred - 这个点被收藏了。`true` = 默认的五角星；也可以直接给一个算好的
		 *                  shapeSpec（用户在详情卡里换过收藏图标）
		 * @returns 像素，恒大于 0
		 */
		function reachFor(kind, active, dotSize, theme, grow, starred) {
			const size = dotSizeOf(kind, dotSize, grow)
			// ⚠️ 收藏的点也得按**它实际画多大**让，不然收藏一个点，连线立刻戳进它下面那两个角里。
			//    收藏图标可换，所以这里认两种写法：true（默认星）和一个具体的 shapeSpec。
			const shape = starred === true
				? STAR
				: starred !== undefined && starred !== null && starred !== false && starred.value !== undefined
					? starred
					: shapeOf(kind, active, theme)
			// 多边形按它实际画多大让（三角放大了 1.34 倍），不然尖角会戳到线上。
			// 走 shapeHeight 而不是 shapeBox：自定义字横着摊开，竖直方向还是一个字高。
			return (shape.spin ? size * 0.71 : shapeHeight(shape, size) / 2) + 1
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

		/** 短到这个地步的残段直接丢掉：浮点减法留下的渣，画出来只是一个更黑的像素。 */
		const MIN_RUN = 0.5

		/**
		 * 同一行上重复画的横段，**一像素只许画一次**。
		 *
		 * 【症状】一个父节点有好几个孩子时，横线一会儿粗一会儿细、还上下起伏（John 报的）。
		 *
		 * 【为什么】走法是先横后竖，于是同一个父节点的每个孩子**各画一条横段**，
		 * 它们都贴在父节点那一行、右端都停在父节点边上，只是往左伸的长度不同 ——
		 * 换句话说是一组**同心嵌套**的线段。靠父节点那一截于是被画了 N 遍：
		 *   · 每条 span 带着自己的 `opacity`（鱼眼淡出用的），叠 N 层就比别处黑一截 → 忽粗忽细
		 *   · `top` 是 `yFrom - 0.5`，通常是小数，浏览器把这 1px 抹到**两行**物理像素上；
		 *     叠几层之后那两行都被填实 → 看着就是上下起伏
		 *
		 * 【怎么修】不靠"谁后画谁赢"，直接让这些横段**互不重叠**：
		 * 按优先级挨个来，每条只画还没被占掉的那截，画完把自己占的区间记下。
		 * 嵌套的那几条里，第一条占完，剩下的整条都被盖住，自然一条都不画。
		 *
		 * 优先级：**蓝的（当前路径）先占**，同色里**长的先占**。
		 * 蓝的先占 = 靠父节点那一截归蓝线，和原来"蓝线压在最上面"看到的是同一个结果；
		 * 区别是现在每个像素只被画一次，所以既不依赖 DOM 顺序，也不会叠出更黑的一段。
		 *
		 * @param runs - 横段，形如 `{left, top, width, active, ...}`，其余字段原样带过去
		 * @returns 互不重叠的横段；被完全盖住的那些不出现。多出一个 `part` 字段用来配 key
		 */
		function trimRuns(runs) {
			const claimed = new Map()
			const out = []
			// 稳定排序：优先级一样时保持原来的先后，免得同一棵树每次重画挑中的是不同那条
			const ranked = runs.map((run, seat) => ({ run, seat })).sort((a, b) => {
				if (a.run.active !== b.run.active) return a.run.active === true ? -1 : 1
				if (b.run.width !== a.run.width) return b.run.width - a.run.width
				return a.seat - b.seat
			})
			for (const { run } of ranked) {
				// 同一行（= 同一个树深度）的横段才会撞上。父节点不同也照样撞，所以按 top 分组，
				// 不是按父节点分组。
				const lane = run.top.toFixed(2)
				const taken = claimed.get(lane) || []
				let pieces = [[run.left, run.left + run.width]]
				for (const [from, to] of taken) {
					const next = []
					for (const [a, b] of pieces) {
						if (to <= a || from >= b) { next.push([a, b]); continue } // 不相交
						if (a < from) next.push([a, from]) // 左边露出来的一截
						if (to < b) next.push([to, b]) // 右边露出来的一截
					}
					pieces = next
				}
				let part = 0
				for (const [a, b] of pieces) {
					if (b - a < MIN_RUN) continue
					out.push(Object.assign({}, run, { left: a, width: b - a, part }))
					part += 1
				}
				// ⚠️ 记下的是**原来那整条**，不是画出来的那几截。被当成残渣丢掉的那点宽度
				//    也得算占过，否则后面每一条都会在同一个位置再补一根发丝线。
				taken.push([run.left, run.left + run.width])
				claimed.set(lane, taken)
			}
			return out
		}

		/**
		 * 连线的绘制顺序：灰的在前，蓝的在后。
		 *
		 * 横段的压盖关系现在归 `trimRuns` 管（它让那些线压根不重叠），这里只剩两件事：
		 * 给 `trimRuns` 一个稳定的输入顺序，以及决定竖段的 DOM 先后 —— 竖段各在各的列上，
		 * 本来就不会互相盖，所以先后无所谓。
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
		 *    左边每一列（列挨着列，命中区还互相重叠），沿途每个点都会抢走卡片，
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
		function watchViewport(schedule) {
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
		function contentRightOf(el) {
			let most
			for (const row of el.querySelectorAll('[data-chat-turn]')) {
				const rect = row.getBoundingClientRect()
				if (rect.width < 1) continue
				if (most === undefined || rect.right > most) most = rect.right
			}
			return most
		}

		/** 导轨最外层那个 div 身上的记号。`isCovered` 靠它认出"这是我自己"。 */
		const RAIL_MARK = 'data-dsh-tree-rail'

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
		function isCovered(el, probe) {
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
		const STAR_ANIM_MS = 340

		/** 关键帧的名字。收藏和取消各一条 —— 取消那下要"缩回去"，不是把收藏倒放。 */
		const STAR_ANIM = { on: 'dsh-tree-star-on', off: 'dsh-tree-star-off' }

		/**
		 * 把那两条关键帧塞进页面。整页只需要一份，Rail 挂载时调一次。
		 * @returns 卸载函数
		 */
		function installStarAnimation() {
			try {
				if (document.querySelector('style[data-dsh-tree="star-anim"]') !== null) return () => {}
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
		function starAnimation(flash, key) {
			if (flash === null || flash === undefined || flash.key !== key) return 'none'
			return `${flash.on ? STAR_ANIM.on : STAR_ANIM.off} ${STAR_ANIM_MS}ms cubic-bezier(.34,1.4,.64,1)`
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
		 * 收藏图标认的值比节点形状多一个 `'star'`。
		 *
		 * ⚠️ 别图省事用 `isShape`：`shapeSpec('star')` 认不得五角星（它**故意**不在 SHAPES 里，
		 *    免得五角星出现在四个角色的形状选择器里，"哪个是收藏"当场失效），会退回圆 ——
		 *    于是"收藏默认形状"存成 star 之后读出来不合法，设置里改了跟没改一样。
		 */
		const isFavShape = (value) => typeof value === 'string' && favShape(value).value === value

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
			// 收藏**不是第五个角色**（它是盖在任何一种节点上的一层记号，所以不在 ROLES 里），
			// 但它确实有一对"颜色 + 形状"要给用户调，所以字段名直接写出来。
			{
				key: 'favorite',
				label: '收藏',
				color: 'favoriteColor',
				shape: 'favoriteShape',
				extra: ['star'],
				hint: '收藏过的节点长什么样。这里改的是**默认** —— 在树上某个点的卡片里单独挑过图标或颜色的，仍按它自己的来。描边和填充都是这个颜色，填充只是它的半透明版；深浅由当前主题自动调。',
			},
			// `key` 就是 shapes.js 里的角色名（收藏除外），所以改哪两个设置字段、要不要画虚线，
			// 一律从 ROLES 查，不在这儿重写一遍
		].map((row) =>
			Object.assign(
				{},
				ROLES[row.key] === undefined
					? {}
					: { color: ROLES[row.key].color, shape: ROLES[row.key].shape, dashed: ROLES[row.key].dashed === true },
				row,
			),
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
				// 收藏那一行的形状多认一个 'star'，见 isFavShape
				{ field: row.shape, kind: 'shape', label: `${row.label}形状`, fallback: THEME[row.shape], accept: row.key === 'favorite' ? isFavShape : isShape, hint: '' },
			]),
		]

		/**
		 * 这一帧该用哪套颜色和形状。
		 *
		 * 规矩只有一条：**没被用户亲手改过的，跟着当前明暗走；改过的就钉死。**
		 * 所以宿主一切明暗树就立刻跟着换，而用户自己挑的那个色不会被悄悄改掉。
		 * （卡片上按「重置」清掉 user 标记，那一项就重新跟着明暗走。）
		 *
		 * @param values - 设置里存的值
		 * @param user - 哪些字段是用户亲手改过的（宿主快照里的 `user`）
		 * @param dark - 当前是不是暗色
		 * @returns 四个角色的颜色与形状
		 */
		function themeFrom(values, user, dark) {
			const base = paletteOf(dark)
			const theme = Object.assign({}, base)
			for (const spec of FIELDS) {
				if (spec.kind !== 'color' && spec.kind !== 'shape') continue
				const touched = (user || {})[spec.field] === true
				if (touched && spec.accept((values || {})[spec.field])) theme[spec.field] = values[spec.field]
			}
			return theme
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
		 *
		 * 卡片有**两档**：
		 *   · 收起（鼠标停在点上就是这档）—— 一行：信息 + ＋ + ☆，**就这两个动作**。
		 *   · 展开（在卡片上双击）—— 第一行左边多出改树形那三颗（⇤ / ⇥ / ⊕），
		 *     底下多出名字框和收藏图标那排。
		 *
		 * ⚠️ 全部动作按钮都在**第一行**，包括只有展开才露面的那三颗。
		 *    它们本来整个收在展开档的第二行，跟名字框挤在一起 —— 那是"改结构"和"改标注"
		 *    两回事摞成一摞。现在按钮归第一行、输入归下面，两档之间只有"多不多三颗"的差别。
		 *
		 * ⚠️ 卡片里**不写操作说明**（"双击收起""单击改名""名字改过了"这类）。
		 *    双击、单击、框变蓝都是一眼就懂的事，写出来只是占地方。
		 */

		/**
		 * 草稿和现名比，算不算"改过了"。
		 *
		 * `draft === null` = 还没动过文本框。**这和"改成空串"是两回事**：
		 * 空串的意思是"把名字清掉，回到默认"，那是一次真实的修改。
		 * @param draft - 文本框里的草稿；null 表示没动过
		 * @param text - 现在显示的名字
		 * @returns 是否改过
		 */
		function isDirty(draft, text) {
			return draft !== null && draft !== undefined && draft.trim() !== String(text === undefined ? '' : text).trim()
		}

		/**
		 * 这个键盘事件是不是**中文输入法正在拼字**的那一下。
		 *
		 * ⚠️ 这就是 John 报的"双击改名时，中文输入法打两个字卡片就自己关了"：
		 *    微软拼音选词是按**空格或回车**确认的，而那一下会先派发一个
		 *    `keydown{key:'Enter'}`（`isComposing: true`）—— 老写法看见 Enter 就
		 *    "确认改名并收起卡片"，于是你才打了两个拼音字母，卡片没了。
		 *    Esc 同理：它在输入法里是"取消候选词"，不是"放弃改名"。
		 *
		 * 两条判据都要：`isComposing` 是标准写法，但 Safari 和几个国产输入法只给
		 * composition 事件不给这个标志，所以再用 compositionstart/end 自己兜一层。
		 * @param event - react 的键盘事件
		 * @param composing - 我们自己用 composition 事件记的状态
		 * @returns 是不是拼字中途
		 */
		function isComposingKey(event, composing) {
			if (composing === true) return true
			const native = event === undefined || event === null ? undefined : event.nativeEvent
			if (native !== undefined && native !== null && native.isComposing === true) return true
			return event !== undefined && event !== null && event.isComposing === true
		}

		/**
		 * 焦点从我们的输入框上掉了，该不该抢回来。
		 *
		 * 【症状】在卡片里打字，打到一半字就跑进聊天框了；按 Ctrl+A 想全选节点描述，
		 * 结果全选的是聊天区。两个都是同一件事：**焦点被别人悄悄拿走了**。
		 * 宿主那边会在某些时刻重挂组件 / 让 Lexical 编辑器取回焦点，我们拦不住它。
		 *
		 * 拦不住就抢回来 —— 但**只抢"没有理由"的那一次**：
		 *   · 用户自己点了别处（最近 `LEAVE_MS` 毫秒内有过 pointerdown）→ 他真的想走，不抢
		 *   · 用户按了 Tab / Esc / 回车 → 他真的想走，不抢
		 *   · 焦点落在卡片里的别的东西上 → 本来就是自己人，不抢
		 *   · 以上都不是，也就是**谁都没动，焦点自己没的** → 抢回来
		 *
		 * ⚠️ 少一条"用户自己点了别处"就会变成焦点陷阱：点哪儿都跳回这个框，
		 *    连关卡片都做不到。这条是整个机制能不能上线的分界线。
		 * @param inside - 焦点现在落在卡片里面吗
		 * @param byUser - 这次失焦有用户动作能解释吗（点了别处 / 按了 Tab-Esc-回车）
		 * @param wanted - 这个框此刻还想要焦点吗（组件还在、还没提交）
		 * @returns 是否抢回来
		 */
		function shouldRefocus(inside, byUser, wanted) {
			return wanted === true && byUser !== true && inside !== true
		}

		/** 用户动作之后多久之内的失焦都算"他自己要走的"。 */
		const LEAVE_MS = 350

		/**
		 * 一串字裁到最多 `GLYPH_MAX` 个**码点**。
		 *
		 * ⚠️ 按码点数不按 `.length`：`'🙂'` 的 `.length` 是 2，按它算的话一个 emoji
		 *    就吃掉两格配额。展开成数组才是"用户眼里的几个字"。
		 *
		 * ⚠️ 这条**只能在拼字落地之后调**。中文输入法打字时框里躺的是一串拼音
		 *    （"zhongguo" 八个字符才换来两个汉字），中途裁一刀就再也打不出字了 ——
		 *    调用方必须先看 `compositionstart/end`，见 FavIconRow。
		 * @param text - 框里的字
		 * @returns 裁过的字；最多 GLYPH_MAX 个码点
		 */
		function clampGlyph(text) {
			return [...String(text === undefined || text === null ? '' : text)].slice(0, GLYPH_MAX).join('')
		}

		/**
		 * 这张卡现在该不该按住不放（不许关、不许换点）。
		 *
		 * ⚠️ 判据是「框里有光标 **或** 名字改过了」，**不能只看后者**。只看"改过了"的话，
		 *    从点进框到敲出第一个不一样的字之间是一段没上锁的真空期：鼠标稍微飘出卡片，
		 *    `onMouseLeave` 就把整张卡关了，输入框跟着卸载 —— 焦点掉回宿主那个 Lexical
		 *    编辑器，**后面敲的字全进了聊天框**（John 报的就是这条）。
		 *    删回原样时 `dirty` 会翻回 false，可光标还在框里，那一下同理也得按住。
		 *
		 * 抽成纯函数是为了能测：藏在组件里的话，改回"只看 dirty"一条断言都不会响，
		 * 而症状要人肉边敲边把鼠标挪出去才复现得出来。
		 * @param dirty - 名字改过了还没定夺
		 * @param typing - 名字框里有光标
		 * @returns 是否按住
		 */
		function keepsCard(dirty, typing) {
			return dirty === true || typing === true
		}

		/** 详情卡最外层那个 div 身上的记号。焦点守卫靠它判断"焦点还在不在卡片里"。 */
		const CARD_MARK = 'data-dsh-tree-card'

		/**
		 * 焦点守卫：把 `shouldRefocus` 那条规矩挂到一个真的输入框上。
		 *
		 * 返回一组直接摊进 `h('input', {...})` 的属性 + 一个 `leave()`（自己主动要走时先喊一声）。
		 *
		 * ⚠️ 抢回焦点必须排到**下一帧**。`blur` 事件派发的当口 `document.activeElement`
		 *    还没落定，当场 `focus()` 会被紧跟着的那一手再抢走一次，两边来回弹。
		 * @param wanted - 这个框此刻还想要焦点吗
		 * @returns `{props, leave}`
		 */
		function useFocusGuard(wanted) {
			const box = react.useRef(null)
			// 最近一次"用户自己要走"的时刻。pointerdown 记在 document 上（捕获阶段），
			// 因为点的很可能是卡片外面的东西，冒泡到不了我们这儿。
			const left = react.useRef(0)
			const alive = react.useRef(false)
			alive.current = wanted === true
			react.useEffect(() => {
				if (typeof document === 'undefined') return undefined
				const mark = () => { left.current = Date.now() }
				document.addEventListener('pointerdown', mark, true)
				document.addEventListener('wheel', mark, true)
				return () => {
					document.removeEventListener('pointerdown', mark, true)
					document.removeEventListener('wheel', mark, true)
				}
			}, [])
			const leave = react.useCallback(() => { left.current = Date.now() }, [])
			return {
				leave,
				props: {
					ref: (node) => { box.current = node },
					onBlur: () => {
						const el = box.current
						if (el === null || el === undefined) return
						const byUser = Date.now() - left.current < LEAVE_MS
						setTimeout(() => {
							if (!alive.current) return
							const now = typeof document === 'undefined' ? null : document.activeElement
							const card = typeof el.closest === 'function' ? el.closest(`[${CARD_MARK}]`) : null
							const inside = card !== null && card !== undefined && now !== null && card.contains(now)
							if (!shouldRefocus(inside, byUser, alive.current)) return
							// ⚠️ preventScroll：不加的话，抢回焦点会把聊天区滚到导轨那一行去
							if (typeof el.focus === 'function') el.focus({ preventScroll: true })
						}, 0)
					},
				},
			}
		}

		/**
		 * 展开档里那个名字框。单击即可改，**不自动聚焦** ——
		 * 双击展开卡片时就把光标抢走的话，想按 ＋ 还得先点一下别处。
		 *
		 * ⚠️ 这个框**必须把自己的聚焦状态报上去**（`onHold` / `onDrop`）。
		 *    卡片原来只在"名字改过了"时才锁住，于是从点进框到敲出第一个不一样的字之间
		 *    有一段真空期：鼠标稍微飘出卡片，`onMouseLeave` 就把整张卡关了，
		 *    输入框跟着卸载 —— 焦点掉回宿主那个 Lexical 编辑器，**后面敲的字全进了聊天框**
		 *    （John 报的就是这条）。改成"框里有光标就锁住"，真空期整个没了。
		 */
		function NameField(props) {
			const composing = react.useRef(false)
			const canHover = useHover()
			// 只要这个框现在有光标，就一直想要焦点 —— 被谁抢走都抢回来（见 useFocusGuard）
			const [held, setHeld] = react.useState(false)
			const guard = useFocusGuard(held)
			return h('input', Object.assign({}, guard.props, {
				style: {
					width: '100%', boxSizing: 'border-box',
					background: C.input, color: C.text, border: `1px solid ${C.line}`, borderRadius: '4px',
					// 两行那么高。名字常常比框长，矮框里改字要一路盲敲；
					// 而且框越大，光标在里面时鼠标越不容易蹭出卡片。
					padding: '8px', minHeight: '48px', lineHeight: '18px',
					font: 'inherit', outline: 'none',
					// ⚠️ iOS Safari 的死规矩：聚焦一个**字号小于 16px** 的输入框，它会把整个页面
					//    放大过去。宿主的 viewport meta 不归我们管，改不了 user-scalable，
					//    所以只能把字号顶到 16px —— 这是唯一不靠 meta 的解法。
					//    放大之后页面不会自己缩回来，而导轨是 position:fixed 的，
					//    结果就是"改了个名字，树跑到屏幕外面去了"。
					//    能悬停的机器上不动它，免得桌面上这个框忽然比周围字大一圈。
					fontSize: canHover ? undefined : '16px',
				},
				value: props.value,
				placeholder: props.placeholder,
				spellCheck: false,
				// iOS 的键盘默认会把第一个字母自动大写、还会自作主张改拼写。
				// 这是**节点名**，不是句子，两样都不要。
				autoCapitalize: 'off',
				autoCorrect: 'off',
				onClick: (event) => event.stopPropagation(),
				onDoubleClick: (event) => event.stopPropagation(),
				onFocus: (event) => {
					event.currentTarget.style.borderColor = C.accent
					setHeld(true)
					if (typeof props.onHold === 'function') props.onHold()
				},
				onBlur: (event) => {
					event.currentTarget.style.borderColor = C.line
					guard.props.onBlur(event)
					if (typeof props.onDrop === 'function') props.onDrop()
				},
				onChange: (event) => props.onChange(event.target.value),
				onCompositionStart: () => { composing.current = true },
				onCompositionEnd: () => { composing.current = false },
				// ⚠️ 键盘事件到此为止，**不许冒泡出去**。宿主在上层挂着自己的快捷键
				//    （Ctrl+A 全选、回车发送这类），不拦的话在这个框里敲的每一下都会被它
				//    当成"在聊天界面上按的"—— John 报的"Ctrl+A 把聊天全选了"就是这条。
				onKeyDown: (event) => {
					event.stopPropagation()
					// 拼字中途的 Enter / Esc 是输入法的，不是我们的（见 isComposingKey）
					if (isComposingKey(event, composing.current)) return
					// 这三下是"我自己要走"，别让焦点守卫再把光标抢回来
					if (event.key === 'Enter' || event.key === 'Escape' || event.key === 'Tab') {
						setHeld(false)
						guard.leave()
					}
					if (event.key === 'Enter') { event.preventDefault(); props.onSave() }
					if (event.key === 'Escape') { event.preventDefault(); props.onCancel() }
				},
				onKeyUp: (event) => event.stopPropagation(),
				onKeyPress: (event) => event.stopPropagation(),
			}))
		}

		/**
		 * 收藏颜色的几个预设。第一格是空串 = 恢复默认（那个黄）。
		 *
		 * 挑的是**在深底和白底上都压得住**的六个色相，两两之间在 18px 的小圆点上也分得开；
		 * 再多就不是"一眼认出"而是"逐个辨认"了，那正是这一排最该避免的下场。
		 */
		const FAV_COLORS = ['', '#f85149', '#ffa657', '#56d364', '#58a6ff', '#bc8cff', '#ff7bb0']

		/** 收藏选择器里每一格多大、格与格之间留多少。全在一行里挤，所以比设置卡那排小一圈。 */
		const PICK = 18
		const GAP = 3

		/**
		 * 收藏图标能挑哪几种形状。
		 *
		 * ⚠️ **不是 `SHAPES` 全量**。挑剩下这几种的判据是"在 11px 上分得出来"：
		 *    右箭头（chevron）、五边形、六边形在这个尺寸下和圆几乎没差别，
		 *    占着格子却提供不了区分度 —— 而这一排要和颜色挤在同一行里，格子很贵。
		 *    设置卡那边**不删**：那是给节点配形状的，格子宽松，而且删掉会让已经
		 *    存了 hexagon 的设置读出来不合法。
		 */
		const FAV_DROP = ['chevron', 'pentagon', 'hexagon']

		/** 实际列出来的那几格。`'star'` 排头 —— 它是默认，也是"恢复默认"那一格。 */
		const FAV_SHAPES = ['star', ...SHAPES.map((one) => one.value).filter((one) => !FAV_DROP.includes(one))]

		/**
		 * 收藏图标选择器。挂在展开档里，只有**收藏过的点**才露面。
		 *
		 * 【为什么收藏能换图标，而四个角色的形状只能在设置里改】
		 * 角色形状是"这一类节点长什么样"，全局一份；收藏是**按点**贴的记号 ——
		 * 一屏里收藏了七八个点，全长一个样等于没标。所以它天然是每个点自己的事，
		 * 也就只能在这个点自己的卡片里改。
		 *
		 * ⚠️ **只给形状，不给颜色**。收藏恒为那个黄，颜色一旦可配，"哪个是收藏"
		 *    这件一眼能扫出来的事就当场失效了 —— 那是收藏存在的全部理由。
		 *
		 * 形状词汇和设置卡里那排完全一样（预设 id / `char:<字>` / `img:<id>`），
		 * 所以 emoji 和自己传的图都能当收藏图标用。
		 */
		function FavIconRow(props) {
			const { value, color, dark, onPick, onFail, onColor } = props
			const canHover = useHover()
			const [held, setHeld] = react.useState(false)
			const guard = useFocusGuard(held)
			const now = typeof value === 'string' && value.length > 0 ? value : 'star'
			// 「字」那一格自己拿着草稿。**不能直接把存起来的值当 value 用**：
			// 那样每敲一下都要走「onPick → 写 localStorage → 整条导轨重画 → 值再绕回来」，
			// 而那一圈落在中文输入法的拼字中途，拼一半的候选就被冲掉了 ——
			// John 报的"自定义图标里一输中文就退出"就是这条。
			const [draft, setDraft] = react.useState(null)
			const composing = react.useRef(false)
			const stored = String(now).startsWith(CUSTOM) ? String(now).slice(CUSTOM.length) : ''
			// 落地：裁到上限再存。裁的动作只发生在这里，所以拼音中途永远碰不到它。
			const land = (raw) => {
				const cut = clampGlyph(raw)
				setDraft(cut)
				onPick(cut.trim() === '' ? '' : CUSTOM + cut)
			}
			// ⚠️ 传图那一格必须是 <label>，不能是 <span>：里面藏着的 file input 靠 label
			//    的"点我等于点它"才点得动。所以这里把标签名开成参数。
			const cell = (tag, key, picked, extra, child) =>
				h(tag, Object.assign({
					key,
					style: Object.assign({
						display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
						width: PICK + 'px', height: PICK + 'px', boxSizing: 'border-box', flex: '0 0 auto',
						borderWidth: '1px', borderStyle: 'solid', borderColor: picked ? color : C.line,
						borderRadius: '5px', cursor: 'pointer', overflow: 'hidden',
					}, TAPPABLE),
				}, extra), child)

			// 形状、字、传图、颜色**全在同一个 flex 里**，挤不下就自己换行。
			// 拆成"图标一排、颜色一排"的话，光两个标题就占掉两行 —— 而卡片总共才十几行高。
			return h('div', {
				style: { display: 'flex', alignItems: 'center', gap: GAP + 'px', flexWrap: 'wrap', width: '100%', marginTop: '6px' },
			}, [
				// ⚠️ 预览一律走 `favShape` 解，不走 `shapeSpec`：`'star'` 不在 SHAPES 里，
				//    交给 shapeSpec 会退回圆 —— 那一格就成了"默认是个圆点"，正好说反。
				...FAV_SHAPES.map((want) =>
					cell('span', want, now === want, {
						title: want === 'star' ? '恢复默认（五角星）' : want,
						onClick: (event) => { event.stopPropagation(); onPick(want === 'star' ? '' : want) },
					}, preview(want, color, PICK - 6, false, favShape(want), dark)),
				),
				// 填字：emoji 也行，于是"图标库"实际上是无限的。
				// ⚠️ 它和这一排里所有格子**一样高**。以前特意做成两行高，结果整排被它撑起来、
				//    白占一行 —— 而它最多只放 5 个字，一行绰绰有余。
				//    真正需要两行的是名字框（那儿才写长句子），不是这个。
				h('input', Object.assign({}, guard.props, {
					key: 'char', type: 'text',
					// ⚠️ 这里**不能挂 `maxLength`**。中文输入法是先把拼音打进框里再换成汉字的，
					//    "zhongguo" 八个字符才换来两个字 —— 挂上 5 的上限，拼音打到第六个字母
					//    就被截断，汉字根本拼不出来。上限改成在拼字**落地之后**裁（见 land）。
					value: draft === null ? stored : draft,
					placeholder: '字', title: `填几个字当图标，emoji 也行，最多 ${GLYPH_MAX} 个`,
					spellCheck: false, autoCapitalize: 'off', autoCorrect: 'off',
					style: {
						width: '40px', height: PICK + 'px', boxSizing: 'border-box', flex: '0 0 auto',
						background: C.input, color: C.text, textAlign: 'center',
						borderWidth: '1px', borderStyle: 'solid',
						borderColor: String(now).startsWith(CUSTOM) ? color : C.line,
						borderRadius: '5px', outline: 'none', font: 'inherit', padding: 0,
						// 和 NameField 同一条 iOS 规矩：小于 16px 的输入框一聚焦就把整页放大
						fontSize: canHover ? '11px' : '16px',
					},
					onClick: (event) => event.stopPropagation(),
					onDoubleClick: (event) => event.stopPropagation(),
					// 和名字框同一条规矩：框里有光标就把整张卡按住，不然鼠标一飘出去卡片就关了，
					// 焦点掉回宿主的输入框，接着敲的字全进聊天框（见 keepsCard / useFocusGuard）。
					onFocus: () => {
						setHeld(true)
						if (typeof props.onHold === 'function') props.onHold()
					},
					onBlur: (event) => {
						composing.current = false
						setDraft(null) // 交还给存起来的值，省得草稿和真值各说各话
						guard.props.onBlur(event)
						if (typeof props.onDrop === 'function') props.onDrop()
					},
					// 键盘到此为止，理由和名字框那条一模一样（宿主的 Ctrl+A / 回车会抢走）
					onKeyDown: (event) => {
						event.stopPropagation()
						// ⚠️ 拼字中途的按键**一个都不许动**。微软拼音选词按的就是空格或回车，
						//    那一下会先派发一个 `keydown{key:'Enter', isComposing:true}` ——
						//    老写法看见 Enter 就 blur()，浏览器当场把这次合成掐掉、把**拼音原文**
						//    当结果落进框里。于是打完 "ceshiyixia" 还没选词，框里就成了那串英文
						//    （John 报的）。名字框早就有这道闸，这个框当初漏了。
						if (isComposingKey(event, composing.current)) return
						if (event.key === 'Enter' || event.key === 'Escape' || event.key === 'Tab') {
							setHeld(false)
							guard.leave()
							if (typeof event.currentTarget.blur === 'function') event.currentTarget.blur()
						}
					},
					onKeyUp: (event) => event.stopPropagation(),
					onKeyPress: (event) => event.stopPropagation(),
					onCompositionStart: () => { composing.current = true },
					// 拼字落地那一下才裁、才存。Chrome 是 compositionend 在前、Firefox 在后，
					// 两边都覆盖到：这里存一次，下面那个 onChange 看 composing 再存一次。
					onCompositionEnd: (event) => {
						composing.current = false
						land(event.target.value)
					},
					onChange: (event) => {
						const raw = event.target.value
						// 拼音还在框里躺着，长度先不管，也别写进存储
						if (composing.current) return setDraft(raw)
						land(raw)
					},
				})),
				// 传图：和设置卡里那颗同一套 —— 浏览器里先光栅化成 PNG 再交给 host（见 shrink()）
				cell('label', 'img', String(now).startsWith(PICTURE), { title: '传一张图当图标。png / jpg / webp / svg 都行，尺寸不限' }, [
					String(now).startsWith(PICTURE)
						? preview(now, color, PICK - 4, false, favShape(now), dark)
						: h('span', { key: 'p', style: { fontSize: '12px', lineHeight: 1, color: C.muted } }, '🖼'),
					h('input', {
						key: 'f', type: 'file', accept: 'image/*', style: { display: 'none' },
						onChange: (event) => {
							const file = event.target.files && event.target.files[0]
							event.target.value = '' // 同一个文件再传一次也要触发
							if (file === undefined || file === null) return
							// 传图是用户按下去的动作，失败了要说一句（摊在卡片下面那行），
							// 不能悄悄没反应 —— 和 icon-upload.js 里那条注释同一个道理。
							upload(file).then(onPick, (error) => onFail(String((error && error.message) || error)))
						},
					}),
				]),
				// ===== 颜色 =====
				// ⚠️ 这几个色点推翻了原来"收藏恒为那个黄"的硬规矩。当初的理由现在仍然成立 ——
				//    所以**默认还是黄的**，这里改的只是这一个点。真要按点分色（红=待办、
				//    绿=已验证）给得出，但一屏里七八种颜色之后，"哪个是收藏"就得靠形状认了。
				// 不写"收藏颜色"四个字，也不另起一行：圆的是颜色、方的是形状，一眼就分得开。
				...FAV_COLORS.map((hex) =>
					h('span', {
						key: 'c' + hex,
						title: hex === '' ? '恢复默认颜色' : hex,
						style: Object.assign({
							display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
							width: PICK + 'px', height: PICK + 'px', boxSizing: 'border-box', flex: '0 0 auto',
							background: hex === '' ? 'none' : hex,
							borderWidth: hex === '' ? '1px' : '2px', borderStyle: hex === '' ? 'dashed' : 'solid',
							// 选中的那颗描一圈亮边；没选中的用中性描边，免得每颗都在抢注意力
							borderColor: (hex === '' ? props.ownColor === undefined : props.ownColor === hex) ? C.text : C.line,
							// ⚠️ 颜色一律画成**圆**、形状一律画成**方**。两组挤在同一行里，
							//    不靠外框区分的话，"这一格是选形状还是选颜色"得逐个试。
							borderRadius: '50%', cursor: 'pointer',
							fontSize: '9px', lineHeight: 1, color: C.muted,
						}, TAPPABLE),
						onClick: (event) => { event.stopPropagation(); if (typeof onColor === 'function') onColor(hex) },
					}, hex === '' ? '×' : null),
				),
				// 取色盘：预设不够时自己挑。`type=color` 原生就给 `#rrggbb`，正好是我们收的格式。
				h('input', {
					key: 'pick', type: 'color',
					value: typeof props.ownColor === 'string' ? props.ownColor : color,
					title: '自己挑一个颜色',
					style: {
						width: (PICK + 4) + 'px', height: PICK + 'px', boxSizing: 'border-box', flex: '0 0 auto',
						padding: 0, background: 'none', border: '1px solid ' + C.line, borderRadius: '9px', cursor: 'pointer',
					},
					onClick: (event) => event.stopPropagation(),
					onChange: (event) => { if (typeof onColor === 'function') onColor(event.target.value) },
				}),
			])
		}

		/**
		 * 详情条：鼠标停在某个点上时从旁边平移淡入。
		 *
		 * 向左滑出（导轨贴着聊天区右缘，右边没有空间）。常驻挂载，否则过渡播不出来。
		 * 自带 onMouseEnter 取消关闭计时，不然鼠标还没走到 ＋ 就消失了。
		 */
		function Detail(props) {
			const { node, y, railWidth, labels, hold, release } = props
			const [expanded, setExpanded] = react.useState(false)
			const [draft, setDraft] = react.useState(null)
			const [merging, setMerging] = react.useState(false)
			// 名字框里有没有光标。和 `dirty` 一起决定"这张卡现在不许关、也不许换点"。
			const [typing, setTyping] = react.useState(false)
			// 灰掉的按钮、小牌子上那些理由全写在 `title` 里，而 **title 在触摸设备上
			// 永远不会出现**（手指没有"停在上面"这个状态）。iPad 上看到的就成了一个
			// 按不动、也不说为什么的 ＋ —— 比没有这个按钮更让人发毛。
			// 所以这些地方一律再挂一条 onClick，把同一句话摊在卡片里。
			const [note, setNote] = react.useState(null)
			react.useEffect(() => {
				setExpanded(false)
				setMerging(false)
				setDraft(null)
				setNote(null)
				setTyping(false)
			}, [node])

			const shown = node !== null
			const isEmpty = shown && node.kind === 'empty'
			const key = !shown ? '' : isEmpty ? 'root' : node.key
			const fallback = !shown ? '' : isEmpty ? node.session.title || '未命名对话' : node.entry.prompt || `第 ${node.entry.turn} 轮`
			const text = labels[key] || fallback
			const dirty = isDirty(draft, text)
			const starred = shown && (props.favorites || new Set()).has(key)

			// 正在改名时，**整张卡锁住**：鼠标走开不关、换点不换。
			// 否则手一滑划过别的点，刚敲的名字就没了 —— 而它连个"没保存"的提示都来不及给。
			//
			// 判据见 keepsCard：光标在框里就算，不必等到真改出不一样的字。
			const busy = keepsCard(dirty, typing)
			const onLock = props.onLock
			react.useEffect(() => {
				if (typeof onLock === 'function') onLock(busy)
			}, [busy, onLock])
			react.useEffect(() => () => { if (typeof onLock === 'function') onLock(false) }, [onLock])

			const commit = (value) => {
				props.onRename(key, value === null || value === undefined ? '' : value.trim())
				setDraft(null)
			}

			const button = (glyph, title, action, color) =>
				h('span', {
					key: glyph, title,
					style: Object.assign({ flex: '0 0 auto', cursor: 'pointer', color: color || C.muted, padding: '0 4px', fontSize: '13px' }, TAPPABLE),
					onClick: (event) => { event.stopPropagation(); action() },
				}, glyph)

			// 按不了的按钮**留在原地**灰掉，鼠标停上去说原因 —— 和合并单子里被拦下的那几行
			// 同一套语言。直接藏起来的话，用户只会觉得"按钮怎么没了"，比看到理由更慌。
			const blocked = (glyph, why) =>
				h('span', {
					key: glyph, title: why,
					style: Object.assign({ flex: '0 0 auto', cursor: 'not-allowed', color: C.muted, opacity: 0.4, padding: '0 4px', fontSize: '13px' }, TAPPABLE),
					// 按不动，但**戳得动** —— 戳一下把理由摊到下面那行。桌面上多这一下无害
					// （title 本来就会出来），触摸设备上这是唯一的知情途径。
					onClick: (event) => { event.stopPropagation(); setNote(why) },
				}, glyph)

			// 保存 / 不保存那两颗。写成字而不是符号：这是**会丢东西**的抉择，
			// 得让人一眼读懂，不能让他去猜 ✓ 和 ✗ 各是什么意思。
			const word = (label, title, action, accent) =>
				h('span', {
					key: label, title,
					style: Object.assign({
						flex: '0 0 auto', cursor: 'pointer', fontSize: '11.5px', lineHeight: '18px',
						padding: '0 8px', borderRadius: '4px',
						borderWidth: '1px', borderStyle: 'solid', borderColor: accent ? C.accent : C.line,
						color: accent ? C.accent : C.muted,
					}, TAPPABLE),
					onClick: (event) => { event.stopPropagation(); action() },
				}, label)

			// 「撤回」「无上下文」这类小牌子共用一套样子
			const tag = (slot, label, why) =>
				h('span', {
					key: slot, title: why,
					style: Object.assign({
						flex: '0 0 auto', color: C.muted, fontSize: '10px', lineHeight: '14px',
						border: `1px solid ${C.line}`, borderRadius: '3px', padding: '0 3px', cursor: 'help',
					}, TAPPABLE),
					// 同上：「撤回」「无上下文」这两块牌子的全部信息量都在 title 里
					onClick: (event) => { event.stopPropagation(); setNote(why) },
				}, label)

			// 摊开的那句理由。再戳一下收起 —— 不然它会一直占着卡片下沿。
			const noteLine = note === null ? null : h('div', {
				key: 'note',
				style: Object.assign({
					width: '100%', marginTop: '5px', color: C.muted, fontSize: '11px', lineHeight: 1.5,
					whiteSpace: 'pre-wrap', cursor: 'pointer',
				}, TAPPABLE),
				onClick: (event) => { event.stopPropagation(); setNote(null) },
			}, note)

			// ===== 第一行：信息 + 动作 =====
			// 顺序是按"多重"排的，从左到右越来越轻：改树形（⇤ ⇥ ⊕）→ 开分支（＋）→ 收藏（☆）。
			//
			// ⚠️ 改树形那三颗**只在展开档露面**，收起档就只有 ＋ 和 ☆。
			//    收起档是鼠标划过导轨时跟着走的那一档，手还在动，按钮又小又挨着 ——
			//    这时候摆出"把这条支线拆出去"这种改结构的动作，迟早点错。
			//    展开是一次明确的双击，相当于"我确实要动这个节点"。
			const head = !shown ? null : h('div', {
				key: 'head',
				style: { display: 'flex', alignItems: 'center', gap: '6px', width: '100%' },
			}, [
				h('span', {
					key: 'n',
					title: isEmpty ? '' : `会话内第 ${node.entry.turn} 轮`,
					style: { flex: '0 0 auto', color: C.muted, fontSize: '11px', fontVariantNumeric: 'tabular-nums' },
				}, isEmpty ? '对话' : `#${node.no}`),
				// 撤回过的那一轮还画在树上（答完了才留），但它已经不在对话里，
				// 不挂个牌子的话点开只会看到一条"怎么滚不过去"的旧提问。
				node.rewound !== true ? null : tag('r', '撤回', '这一轮已被撤回，不在对话里了'),
				// 这条分支开出来的时候没能继承 Claude 那边的上下文。不说一声的话，
				// 它看起来和别的分支一模一样，直到答得驴唇不对马嘴才发现。
				node.session.contextMissing !== true || !isBranchHead(node)
					? null
					: tag('c', '无上下文', '开这条分支时没能继承 Claude 那边的记忆，所以它不记得岔路点之前的对话。\n（多半是开分支那一刻父对话正在运行 —— 读它的记录会打断那一轮。）'),
				// 展开档里名字搬进了下面那个框，这里就淡下去 —— 同一个名字摆两遍没必要抢眼。
				h('span', {
					key: 't',
					style: {
						flex: '1 1 auto', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
						fontWeight: isEmpty ? 600 : 400, opacity: expanded ? 0.45 : 1,
					},
				}, text),
				// 改树形那三颗：只有展开档才露面，但露面时和 ＋ / ☆ 并排在这一行。
				// ⚠️ 有未保存的草稿时一律灰掉：它们每一个都会触发重画，而重画就意味着草稿悄悄没了。
				//    只是光标停在框里、还没改动的话不灰 —— 那会儿没东西可丢，灰掉纯属碍事。
				!expanded || node.cut !== true
					? null
					: dirty
						? blocked('⇤', '先保存或放弃这次改名')
						: button('⇤', '把这条支线接回原来那棵树', () => props.onJoin(node)),
				!expanded || !props.detachable
					? null
					: dirty
						? blocked('⇥', '先保存或放弃这次改名')
						: button('⇥', '把这条支线拆成独立的一棵树', () => props.onDetach(node)),
				// 合并整棵对话。挂在树根那个空节点上：合并是**整棵树对整棵树**的，
				// 不是某个节点对某个节点，挂在中间任何一个节点上都会让人以为"接到这儿"。
				!expanded || !isEmpty || (props.targets || []).length === 0
					? null
					: dirty
						? blocked('⊕', '先保存或放弃这次改名')
						: button(merging ? '×' : '⊕', merging ? '收起' : '把别的对话合并进这棵树', () => setMerging(!merging)),
				branchAction(node) === 'none'
					? null
					: dirty
						? blocked('＋', '先保存或放弃这次改名')
						: forkBlockedWhy(node) !== ''
							? blocked('＋', forkBlockedWhy(node))
							: button('＋', '从这之后新开分支', () => props.onFork(node)),
				dirty
					? blocked(starred ? '★' : '☆', '先保存或放弃这次改名')
					: button(
						starred ? '★' : '☆',
						starred ? '取消收藏' : '收藏这个节点（树上变成黄色五角星）',
						() => props.onFavorite(key, !starred),
						starred ? props.starInk : C.muted,
					),
			])

			// 收藏图标那一排。**只在收藏过的点上露面** —— 没收藏的话它改的是个看不见的东西。
			// 改名改到一半时也收起来：那会儿只剩"保存 / 不保存"两条出路（见下面那段注释）。
			const favIcons = props.favIcons || {}
			const iconRow = !starred || dirty || !expanded ? null : h(FavIconRow, {
				key: 'favicon',
				value: favIcons[key],
				color: props.starInk || C.muted,
				// ⚠️ 选择器里那几颗预览要按当前明暗算，否则亮色下画出来的是暗色那套色
				dark: props.dark,
				ownColor: (props.favColors || {})[key],
				onColor: (want) => props.onFavColor(key, want),
				onHold: () => setTyping(true),
				onDrop: () => setTyping(false),
				onPick: (want) => props.onFavIcon(key, want),
				onFail: (why) => setNote(`图标没换成：${why}`),
			})

			// ===== 展开档：名字框 + 收藏图标 =====
			// 动作按钮不在这儿 —— 它们全在第一行，展开与否都不动。
			const body = !shown || !expanded ? null : [
				h('div', { key: 'name', style: { display: 'flex', width: '100%', marginTop: '6px' } },
					h(NameField, {
						value: draft === null ? text : draft,
						placeholder: fallback,
						onChange: setDraft,
						onHold: () => setTyping(true),
						onDrop: () => setTyping(false),
						onSave: () => { commit(draft); setExpanded(false) },
						onCancel: () => setDraft(null),
					}),
				),
				// 改过之后**只剩这两条出路**（别的按钮这会儿全灰着，见第一行那几个 `dirty`）。
				// 不写"名字改过了"：框变蓝、这两颗冒出来，已经把话说完了。
				!dirty ? null : h('div', {
					key: 'acts',
					style: { display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: '6px', width: '100%', marginTop: '6px' },
				}, [
					word('不保存', '丢掉这次改名', () => { setDraft(null); setTyping(false); setExpanded(false) }),
					word('保存', '保存这个名字（回车也行）', () => { commit(draft); setTyping(false); setExpanded(false) }, true),
				]),
				iconRow,
			]

			return h(
				'div',
				{
					// 焦点守卫靠这个记号判断"焦点还落在卡片里（点了卡片上别的东西），
					// 还是被外人抢走了"。见 useFocusGuard。
					[CARD_MARK]: '1',
					style: {
						position: 'absolute', right: `${railWidth + 4}px`, top: `${y}px`,
						transform: `translateY(-50%) translateX(${shown ? 0 : 8}px)`,
						opacity: shown ? 1 : 0,
						transition: 'opacity .14s ease, transform .14s ease',
						pointerEvents: shown ? 'auto' : 'none',
						width: `${Z.card}px`, maxWidth: '60vw',
						display: 'flex', flexDirection: 'column', alignItems: 'stretch',
						background: C.card, borderWidth: '1px', borderStyle: 'solid', borderColor: dirty ? C.accent : C.line, borderRadius: '7px',
						boxShadow: '0 6px 20px rgba(0,0,0,.45)', padding: '6px 8px',
						font: '12.5px/1.45 -apple-system,"Segoe UI","PingFang SC",sans-serif', color: C.text,
						// ⚠️ 这里只能上 NO_ZOOM，不能上整套 TAPPABLE：卡片里有改名输入框，
						//    祖先一旦 user-select:none，iOS 上那个框里的字就选不中、放不了光标。
						//    manipulation 还顺手救了"双击展开"—— 否则那两下被 Safari
						//    当成缩放手势吃掉，dblclick 压根不发，展开档在 iPad 上打不开。
						...NO_ZOOM,
					},
					onMouseEnter: hold,
					// 锁住的时候连"鼠标走了就关"都不许 —— 草稿还在里面
					onMouseLeave: () => { if (!busy) release() },
					// 双击开合。⚠️ 改过名之后不许用双击收起：那条路不经过保存/不保存，
					//    等于给了第三个出口，而它是个**静默丢弃**。
					onDoubleClick: () => { if (!dirty) setExpanded(!expanded) },
				},
				head,
				noteLine,
				body,
				!shown || !expanded || !merging || dirty ? null : h(MergeList, {
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
						// 单子滑到头之后别把滚动传给底下的聊天区（iOS 上那一下是整页橡皮筋回弹，
						// 手一松单子自己弹没了）；WebkitOverflowScrolling 给老 iOS 补惯性滚动。
						overscrollBehavior: 'contain', WebkitOverflowScrolling: 'touch',
						background: C.card, border: `1px solid ${C.line}`, borderRadius: '7px',
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
							...TAPPABLE,
						},
						onMouseEnter: (event) => { if (!stop) event.currentTarget.style.background = C.hover },
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
			const dark = useColorScheme()
			// 只为一件事：iOS 上聚焦小于 16px 的输入框会把整页放大过去（见 NameField 那条注释）。
			const canHover = useHover()

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
				// 颜色和形状没被亲手改过时，实际画上去的是**方案色**（themeFrom 的规矩），
				// 这里也得显示方案色 —— 否则色板上写着 A、树上画的是 B，还以为坏了
				if (spec.kind === 'color' || spec.kind === 'shape') return themeFrom(values, user, dark)[field]
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
			// 「填字」那个框自己拿草稿 + 认拼字，理由见下面那段 ⚠️
			// ⚠️ 名字别和上面那个色值回显用的 `draft` 撞 —— 两件事，两份状态。
			const [glyph, setGlyph] = react.useState(null)
			const composing = react.useRef(false)
			/** 拼字落地：按码点裁到上限再写进设置。空了就清掉这一项，回到默认。 */
			const land = (field, raw) => {
				const cut = [...String(raw)].slice(0, GLYPH_MAX).join('').trim()
				setGlyph(cut)
				if (cut === '') clear([field])
				else put(field, CUSTOM + cut)
			}

			const shapes = (field, now, color, dashed, extra) =>
				h('div', { key: 'sp', style: S.picks }, [
					// 额外那几格：目前只有收藏那一行的五角星。它**故意不在 SHAPES 里**
					// （进了就会出现在四个角色的选择器里，"哪个是收藏"当场失效），
					// 所以预览得走 favShape 解，不然画出来是个圆。
					...(extra || []).map((one) =>
						h('button', {
							key: one, type: 'button', disabled: !on, title: one,
							style: S.chip(now === one, on),
							onClick: () => put(field, one),
						}, preview(one, color, 13, dashed, favShape(one), dark)),
					),
					...SHAPES.map((one) =>
						h('button', {
							key: one.value, type: 'button', disabled: !on, title: one.value,
							style: S.chip(now === one.value, on),
							onClick: () => put(field, one.value),
						}, preview(one.value, color, 13, dashed, undefined, dark)),
					),
					// 传图：选完立刻在浏览器里缩成 ICON_EDGE 见方的 PNG 再上传，见 shrink()
					h('label', {
						key: 'img',
						title: `传一张图当节点。png / jpg / webp / svg 都行，尺寸不限 —— 会自动等比缩进 ${ICON_EDGE}×${ICON_EDGE}`,
						style: S.chip(String(now).startsWith(PICTURE), on),
					}, [
						String(now).startsWith(PICTURE)
							? preview(now, color, 15, dashed, undefined, dark)
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
					// 填字：emoji 也行。
					// ⚠️ 这个框和详情卡里那个「字」框是**同一套规矩**，别只改一边：
					//    · 不挂 maxLength —— 中文是先把拼音打进框里再换成汉字的，
					//      "zhongguo" 八个字符才换来两个字，挂上限就永远拼不出来
					//    · 拼字期间只改草稿，一个字节都不写设置（写一次就整棵树重画，
					//      那一圈落在拼字中途会把候选冲掉 —— John 在详情卡那个框里报过）
					//    · 上限在**落地之后**按码点裁，见 clampGlyph
					h('input', {
						key: 'own', type: 'text', disabled: !on,
						value: glyph === null ? (String(now).startsWith(CUSTOM) ? String(now).slice(CUSTOM.length) : '') : glyph,
						placeholder: '填字', title: `填几个字当节点，emoji 也行，最多 ${GLYPH_MAX} 个`,
						autoCapitalize: 'off', autoCorrect: 'off',
						style: Object.assign({}, S.own(String(now).startsWith(CUSTOM), on), canHover ? {} : { fontSize: '16px' }),
						onCompositionStart: () => { composing.current = true },
						onCompositionEnd: (event) => {
							composing.current = false
							land(field, event.target.value)
						},
						onBlur: () => { composing.current = false; setGlyph(null) },
						onChange: (event) => {
							if (composing.current) return setGlyph(event.target.value)
							land(field, event.target.value)
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
						shapes(spot.shape, valueOf(spot.shape), color, spot.dashed === true, spot.extra),
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

		/** ⏳ 那句解释。title 和触摸设备上戳开的浮层是同一份，别让它们各写一遍。 */
		const REWIND_TIP = '这条会话正在跑，暂时读不了它的撤回记录 —— 读那个文件会打断正在跑的这一轮。\n树上画的是上一次读到的状态，撤回过的轮次可能还画着。这一轮跑完会自动更正。'

		/** 树本体。 */
		function Rail(props) {
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
			const radius = Number.isFinite(tuned.visibleRadius) ? tuned.visibleRadius : RADIUS.fallback
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
			const hold = react.useCallback(() => clearTimeout(closeTimer.current), [])
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
						railWidth, labels, hold, release, onLock,
						favorites, favIcons, favColors,
						// 卡片上那颗 ☆ 用**这个点自己的**颜色，不是全局那个黄 ——
						// 不然改完颜色，树上变了、卡片上没变，看着像没生效。
						starInk: starSkin(false, dark, undefined, hover === null ? undefined : favColors[hover.node.key], theme).ink,
						// 图标选择器里那几颗预览要按当前明暗上色（`preview` → `paint`）
						dark,
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
			cutPointOf, cutSet, branchAction, forkBlockedWhy, isBranchHead, mergeTargets, blockedWhy, jumpTarget, isFocusedNode, workspaceOf,
			// 图
			buildGraph, elide, fisheye, FADE, anchorNode,
			// 画
			dotStyle, inkOf, fade, shapeSpec, shapeOf, shapeBox, drawnWidth, shapeHeight, polyPoints, polyProps, roleOf, dashedOf, dotSizeOf,
			// 形状怎么算出来的：面积、按面积配齐的放大倍数、正 n 边形、十字
			polyArea, growOf, regularPoly, crossPoly,
			SHAPES, THEME, ROLES, CUSTOM, PICTURE, ICON_EDGE,
			// 自定义字：上限、占几倍宽、该用多大字号
			GLYPH_MAX, GLYPH_SPAN, GLYPH_PAD_X, GLYPH_PAD_Y, GLYPH_BOX, GLYPH_RADIUS, glyphGrow, glyphFont, emWidth, glyphEm, glyphBoxStyle,
			// 收藏：五角星的形状、配色、以及点下去那一下的动画
			STAR, STAR_COLOR, starPoly, starSkin, starAnimation, STAR_ANIM, STAR_ANIM_MS, favShape,
			// 一个色值，按底色自己调明度 —— 明暗两边不再各写一版
			BACKDROP, CONTRAST_MIN, FILL_ALPHA, readable, onAccent, paint, relLuminance, contrastRatio, hexToHsl, hslToHex, fitContrast,
			// 节点上的用户标注（改名 / 收藏）
			readLabels, writeLabel, readFavorites, writeFavorite, nextFavorites,
			readFavIcons, writeFavIcon, nextFavIcons,
			readFavColors, writeFavColor, nextFavColors, isColor,
			// 详情卡里能离线测的那两件事：改没改过、这一下是不是输入法在拼字
			isDirty, isComposingKey, keepsCard, clampGlyph,
			// 焦点被宿主抢走时抢不抢回来
			shouldRefocus, LEAVE_MS, CARD_MARK, FAV_COLORS, FAV_SHAPES, FAV_DROP, PICK, GAP,
			// 配色与明暗
			PALETTE, paletteOf, themeFrom, isDark, isHex,
			// 几何
			reachFor, segments, edgeOrder, nodeAt, hoverNext, railLayout, railRight, railRoom, trimRuns, MIN_RUN,
			// 版式上的共处：正文栏右缘在哪、聊天是不是被别的插件盖住了
			contentRightOf, isCovered, RAIL_MARK,
			// 指针：能不能悬停、手指戳一下算什么、WebKit 上必须补的那几条样式
			tapNext, hasHover, overRail, watchViewport, TAPPABLE, NO_ZOOM,
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

		exports.apply = apply
		exports.inject = inject
		// 纯函数出口，仅供离线测试（cordis 只读 apply/inject）
		exports.__pure = __pure
		return module.exports
	},
})
