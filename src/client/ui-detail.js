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
import { h, react } from './runtime.js'
import { C, Z } from './const.js'
import { branchAction, forkBlockedWhy, isBranchHead } from './tree.js'
import { NO_ZOOM, TAPPABLE, useHover } from './pointer.js'
import { CUSTOM, GLYPH_STORE_MAX, PICTURE, RARE_SHAPES, SHAPES, favShape, preview } from './shapes.js'
import { upload } from './icon-upload.js'
import { hexOf } from './settings-model.js'

/**
 * 草稿和现名比，算不算"改过了"。
 *
 * `draft === null` = 还没动过文本框。**这和"改成空串"是两回事**：
 * 空串的意思是"把名字清掉，回到默认"，那是一次真实的修改。
 * @param draft - 文本框里的草稿；null 表示没动过
 * @param text - 现在显示的名字
 * @returns 是否改过
 */
export function isDirty(draft, text) {
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
export function isComposingKey(event, composing) {
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
export function shouldRefocus(inside, byUser, wanted) {
	return wanted === true && byUser !== true && inside !== true
}

/** 用户动作之后多久之内的失焦都算"他自己要走的"。 */
export const LEAVE_MS = 350

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
export function clampGlyph(text) {
	return [...String(text === undefined || text === null ? '' : text)].slice(0, GLYPH_STORE_MAX).join('')
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
export function keepsCard(dirty, typing) {
	return dirty === true || typing === true
}

/** 详情卡最外层那个 div 身上的记号。焦点守卫靠它判断"焦点还在不在卡片里"。 */
export const CARD_MARK = 'data-dsh-chat-tree-card'

/**
 * 六位色值输入框。取色盘旁边那个能直接打 `#FFD43B` 的小框。
 *
 * 为什么要它：`<input type="color">` 只给取色盘和三个十进制数字，
 * 而人手里的颜色几乎都是从别处复制来的六位十六进制 —— 没有这个框就只能
 * 把色值拆成 R/G/B 三个十进制自己换算一遍。
 *
 * 两条规矩：
 *   · **边打边生效，但只在认得出来的时候。** 打到 `#ff` 时什么都不做，
 *     不去猜他要的是 `#ffffff` 还是 `#ff0000`。
 *   · **离开焦点就把草稿丢掉**，显示回真实值。否则框里会永远留着一串
 *     没生效的半截字符，而树上是另一个颜色 —— 又一个"看到的和画的不一样"。
 *
 * ⚠️ 键盘事件必须逐个 stopPropagation：这个框浮在宿主的聊天界面上，
 *    不拦住的话敲的字会漏进聊天输入框（和 NameField 同一个坑）。
 */
export function HexField(props) {
	const [draft, setDraft] = react.useState(null)
	const real = String(props.value === undefined || props.value === null ? '' : props.value).toUpperCase()
	const shown = draft === null ? real : draft
	const good = hexOf(shown) !== undefined
	return h('input', {
		type: 'text', value: shown, spellCheck: false, maxLength: 7,
		placeholder: '#RRGGBB',
		title: '直接填六位色值，比如 #FFD43B（# 可省、大小写不论）',
		disabled: props.disabled === true,
		style: {
			width: '84px', flex: '0 0 auto', boxSizing: 'border-box',
			padding: '0 6px', height: `${props.size || 22}px`,
			background: C.input, color: good ? C.text : C.muted,
			border: `1px solid ${good && draft !== null ? C.accent : C.line}`,
			borderRadius: '6px', outline: 'none',
			font: '11.5px/1 ui-monospace,SFMono-Regular,Consolas,monospace',
			fontVariantNumeric: 'tabular-nums',
			cursor: props.disabled === true ? 'not-allowed' : 'text',
			opacity: props.disabled === true ? 0.45 : 1,
		},
		onChange: (event) => {
			const next = event.target.value
			setDraft(next)
			const ok = hexOf(next)
			if (ok !== undefined && typeof props.onPick === 'function') props.onPick(ok)
		},
		// 走开就把没打完的草稿丢掉，显示回真实值
		onBlur: () => setDraft(null),
		onClick: (event) => event.stopPropagation(),
		onDoubleClick: (event) => event.stopPropagation(),
		onKeyDown: (event) => {
			event.stopPropagation()
			if (event.key === 'Enter' || event.key === 'Escape') {
				setDraft(null)
				event.currentTarget.blur()
			}
		},
		onKeyUp: (event) => event.stopPropagation(),
		onKeyPress: (event) => event.stopPropagation(),
	})
}

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
export function useFocusGuard(wanted) {
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
export function NameField(props) {
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
export const FAV_COLORS = ['', '#f85149', '#ffa657', '#56d364', '#58a6ff', '#bc8cff', '#ff7bb0']

/**
 * 色板上一格该画成什么样。
 *
 * 单独抽出来是为了**能测**（和 `polyProps` / `glyphBoxStyle` 同一个理由）：
 * 第一格是「恢复默认」，它必须把**默认那个色本身**画出来。以前它是个空心虚线圈
 * 加个 ×，于是一排七个格子里看不到默认的黄 —— John 报的"颜色选项里竟然没有默认
 * 收藏的那个黄色"。藏在渲染函数里的话，改回去一条断言都不会响。
 * @param hex - 这一格的值；空串 = 恢复默认
 * @param defaultInk - 当前默认的收藏色
 * @param ownColor - 这个点自己挑过的色；没挑过是 undefined
 * @returns `{shown, picked, reset}`
 */
export function favSwatch(hex, defaultInk, ownColor) {
	const reset = hex === ''
	return {
		// 恢复默认那格画默认色；给不出默认色时宁可画成透明，也别画一个骗人的颜色
		shown: reset ? defaultInk || 'none' : hex,
		picked: reset ? ownColor === undefined : ownColor === hex,
		reset,
	}
}

/** 收藏选择器里每一格多大、格与格之间留多少。全在一行里挤，所以比设置卡那排小一圈。 */
export const PICK = 24
export const GAP = 5

/**
 * 收藏图标能挑哪几种形状。
 *
 * ⚠️ **不是 `SHAPES` 全量**。挑剩下这几种的判据是"在 11px 上分得出来"：
 *    右箭头（chevron）、五边形、六边形在这个尺寸下和圆几乎没差别，
 *    占着格子却提供不了区分度 —— 而这一排要和颜色挤在同一行里，格子很贵。
 *    设置卡那边**不删**：那是给节点配形状的，格子宽松，而且删掉会让已经
 *    存了 hexagon 的设置读出来不合法。
 */
export const FAV_DROP = RARE_SHAPES

/** 实际列出来的那几格。`'star'` 排头 —— 它是默认，也是"恢复默认"那一格。 */
export const FAV_SHAPES = ['star', ...SHAPES.map((one) => one.value).filter((one) => !FAV_DROP.includes(one))]

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
export function FavIconRow(props) {
	const { value, color, onPick, onFail, onColor } = props
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
		style: { display: 'flex', alignItems: 'center', gap: GAP + 'px', flexWrap: 'wrap', width: '100%', marginTop: '10px' },
	}, [
		// ⚠️ 预览一律走 `favShape` 解，不走 `shapeSpec`：`'star'` 不在 SHAPES 里，
		//    交给 shapeSpec 会退回圆 —— 那一格就成了"默认是个圆点"，正好说反。
		...FAV_SHAPES.map((want) =>
			cell('span', want, now === want, {
				title: want === 'star' ? '恢复默认（五角星）' : want,
				onClick: (event) => { event.stopPropagation(); onPick(want === 'star' ? '' : want) },
			}, preview(want, color, PICK - 6, false, favShape(want))),
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
			placeholder: '字', title: '填字当图标，emoji 也行，多少个都收 —— 画不下的会截断加省略号，全文在这个框里',
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
				? preview(now, color, PICK - 4, false, favShape(now))
				// ⚠️ 别再放 emoji。这里一度是 🖼，而它在 John 这台 Windows 上渲染成豆腐块
				//    —— 图标格子里摆一个认不出的字符，比什么都不摆更糟。
				//    `+` 是"加一个"的通用写法，任何字体都有。
				: h('span', { key: 'p', style: { fontSize: `${Math.round(PICK * 0.72)}px`, lineHeight: 1, color: C.muted } }, '+'),
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
		...FAV_COLORS.map((hex) => {
			// ⚠️ 第一格是「恢复默认」，但它**必须把默认那个色本身画出来**。
			//    以前它是个空心虚线圈加个 ×，于是一排七个格子里**看不到默认的黄**——
			//    John 报的"颜色选项里竟然没有默认收藏的那个黄色"就是这条。
			//    虚线边继续留着当"这格是恢复默认"的记号，颜色照画。
			const { shown, picked, reset } = favSwatch(hex, props.defaultInk || color, props.ownColor)
			return h('span', {
				key: 'c' + hex,
				title: reset ? `恢复默认颜色（${shown}）` : hex,
				style: Object.assign({
					display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
					width: PICK + 'px', height: PICK + 'px', boxSizing: 'border-box', flex: '0 0 auto',
					background: shown,
					borderWidth: '2px', borderStyle: reset ? 'dashed' : 'solid',
					// 选中的那颗描一圈亮边；没选中的用中性描边，免得每颗都在抢注意力
					borderColor: picked ? C.text : C.line,
					// ⚠️ 颜色一律画成**圆**、形状一律画成**方**。两组挤在同一行里，
					//    不靠外框区分的话，"这一格是选形状还是选颜色"得逐个试。
					borderRadius: '50%', cursor: 'pointer',
				}, TAPPABLE),
				onClick: (event) => { event.stopPropagation(); if (typeof onColor === 'function') onColor(hex) },
			})
		}),
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
		// 取色盘旁边再给一个能直接打六位色值的框
		h(HexField, {
			key: 'hex',
			value: typeof props.ownColor === 'string' ? props.ownColor : color,
			size: PICK,
			onPick: (value) => { if (typeof onColor === 'function') onColor(value) },
		}),
	])
}

/**
 * 详情条：鼠标停在某个点上时从旁边平移淡入。
 *
 * 向左滑出（导轨贴着聊天区右缘，右边没有空间）。常驻挂载，否则过渡播不出来。
 * 自带 onMouseEnter 取消关闭计时，不然鼠标还没走到 ＋ 就消失了。
 */
export function Detail(props) {
	const { node, y, railWidth, labels, hold, release } = props
	// 卡片锚在那个点上（cardAnchor 算好了送过来），不是锚在整条导轨的左缘。
	// 没人悬停时退回老位置，免得淡出那一下横向滑一段。
	const anchor = Number.isFinite(props.anchor) ? props.anchor : railWidth + 4
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
		// 「恢复默认」那一格要画出默认色本身，而 starInk 已经是"这个点自己的色"了
		defaultInk: props.defaultInk,
		ownColor: (props.favColors || {})[key],
		onColor: (want) => props.onFavColor(key, want),
		onHold: () => setTyping(true),
		onDrop: () => setTyping(false),
		onPick: (want) => props.onFavIcon(key, want),
		onFail: (why) => setNote(`图标没换成：${why}`),
	})

	// ===== 展开档：名字框 + 收藏图标 =====
	//
	// ⚠️ 展开档的留白**故意比收起时大一截**。收起的那条是扫一眼就走的，挤是对的；
	//    而双击展开是个明确动作，这时候注意力全在卡片上，还按"别占地方"的尺寸排，
	//    就成了 John 说的"畏手畏脚" —— 输入框、图标格子挤成一堆，反倒更难点中。
	//    浮层一旦被用户主动打开，就该给足操作空间。
	const ROOM = 10
	// 动作按钮不在这儿 —— 它们全在第一行，展开与否都不动。
	const body = !shown || !expanded ? null : [
		h('div', { key: 'name', style: { display: 'flex', width: '100%', marginTop: `${ROOM}px` } },
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
			style: { display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: `${ROOM}px`, width: '100%', marginTop: `${ROOM}px` },
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
				position: 'absolute', right: `${anchor}px`, top: `${y}px`,
				transform: `translateY(-50%) translateX(${shown ? 0 : 8}px)`,
				opacity: shown ? 1 : 0,
				pointerEvents: shown ? 'auto' : 'none',
				// 展开时加宽加厚（见上面 ROOM 那段）；收起时维持原来的紧凑尺寸
				width: `${expanded ? Z.cardOpen : Z.card}px`, maxWidth: '72vw',
				transition: 'opacity .14s ease, transform .14s ease, width .14s ease, padding .14s ease',
				display: 'flex', flexDirection: 'column', alignItems: 'stretch',
				background: C.card, borderWidth: '1px', borderStyle: 'solid', borderColor: dirty ? C.accent : C.line, borderRadius: '7px',
				boxShadow: '0 6px 20px rgba(0,0,0,.45)', padding: expanded ? '11px 13px' : '6px 8px',
				font: '12.5px/1.45 -apple-system,"Segoe UI","PingFang SC",sans-serif', color: C.text,
				// ⚠️ 这里只能上 NO_ZOOM，不能上整套 TAPPABLE：卡片里有改名输入框，
				//    祖先一旦 user-select:none，iOS 上那个框里的字就选不中、放不了光标。
				//    manipulation 还顺手救了"双击展开"—— 否则那两下被 Safari
				//    当成缩放手势吃掉，dblclick 压根不发，展开档在 iPad 上打不开。
				...NO_ZOOM,
			},
			onMouseEnter: hold,
			// ⚠️ 卡片是**导轨那个 div 的子元素**，而导轨上挂着 hover intent 的 mousemove。
			//    不拦住的话，鼠标在卡片里动一下就会冒泡下去，被当成"你正压着卡片底下那个点"，
			//    restMs 一到目标就换走、卡片跟着挪位置，于是永远点不到它（见 rail.js 的 hold）。
			//    浮层里的指针位置不是导轨的事，这里断掉是本分，不是权宜。
			onMouseMove: (event) => event.stopPropagation(),
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
export function MergeList(props) {
	const { targets, onPick } = props
	return h(
		'div',
		{
			style: {
				// ⚠️ 这张单子是**卡片的子元素**，包含块就是卡片本身 —— 所以是 `right: 0`
				//    贴着卡片右缘挂在它下面，不是 `railWidth + 4`。后者是卡片自己相对
				//    导轨的偏移，抄到这儿等于把单子又往左甩了一整条导轨那么宽。
				position: 'absolute', right: 0, top: '100%', marginTop: '4px',
				width: '100%', maxHeight: '40vh', overflowY: 'auto',
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
