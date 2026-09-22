/**
 * 跨设备适配：能不能悬停、手指戳一下算什么、WebKit 上必须补的那几条样式。
 *
 * 【为什么单开一个文件】这一整套是给**我们手上没有的机器**写的（iPad / iPhone /
 * 触摸屏本 / Safari）。在 Windows + Chrome 上跑，这些代码路径**一条都不会走到** ——
 * 换句话说，改坏了这里，本机上永远发现不了。所以它们必须被离线断言钉住。
 *
 * 只测得到"算"的那半：判据、决策、样式表的内容。真正的手指落点测不了，
 * 但真正会退化的也不是手指，是有人顺手把 `WebkitUserSelect` 当冗余删掉。
 *
 * @module test-pointer
 */
import { readFileSync, readdirSync } from 'node:fs'
import { check, report, loadClientPure } from './test-kit.mjs'

const pure = await loadClientPure()
const { tapNext, hasHover, watchViewport, keepsCard, shouldRefocus, overRail, TAPPABLE, NO_ZOOM } = pure

// ===== 用例 1：手指戳一下，是开卡片还是真跳过去 =====
console.log('用例 1：触摸设备上点一下节点的语义')
{
	const a = { id: 'a' }
	const b = { id: 'b' }
	// 卡片没开 → 第一下只能是"把卡片开出来"。要是这里给 'go'，
	// ＋ / ☆ / 改名就全都够不着了 —— 这正是改动前 iPad 上的样子。
	check(tapNext(null, a) === 'open', '卡片没开时，第一下应该只开卡片')
	check(tapNext(undefined, a) === 'open', 'hovered 是 undefined 时也算没开')
	// 卡片已经停在同一个点上 → 第二下才跳。
	check(tapNext(a, a) === 'go', '戳的是卡片已经停着的那个点，第二下应该跳过去')
	// 卡片停在别的点 → 还是先把卡片挪过来，不能直接跳。
	check(tapNext(a, b) === 'open', '戳的是另一个点时，应该先把卡片挪过去而不是跳')
	check(tapNext(b, a) === 'open', '反过来同理')
}

// ===== 用例 2：能不能悬停，查不出来时必须当作"能" =====
console.log('用例 2：悬停判据查不出来时退回鼠标那套')
{
	const saved = globalThis.window.matchMedia
	delete globalThis.window.matchMedia
	// ⚠️ 这条是方向性的：判错成"不能悬停"，桌面上每个节点都要点两下才跳，
	//    是个所有人都会撞上的退化；判错成"能悬停"只是触摸设备退回原状。
	check(hasHover() === true, '没有 matchMedia 的老浏览器应该当作能悬停')

	globalThis.window.matchMedia = () => { throw new Error('boom') }
	check(hasHover() === true, 'matchMedia 抛异常时也应该当作能悬停，而不是让整条导轨炸掉')

	globalThis.window.matchMedia = (query) => ({ matches: query === '(hover: hover)' })
	check(hasHover() === true, '(hover: hover) 命中时应该返回 true')

	globalThis.window.matchMedia = () => ({ matches: false })
	check(hasHover() === false, '(hover: hover) 不命中时应该返回 false')

	if (saved === undefined) delete globalThis.window.matchMedia
	else globalThis.window.matchMedia = saved
}

// ===== 用例 3：视觉视口的订阅要能退干净 =====
console.log('用例 3：visualViewport 订阅与退订')
{
	const log = []
	const saved = globalThis.window.visualViewport
	// 没有 visualViewport（桌面 Chrome 之外的老浏览器）时不许抛，返回个空函数就行
	delete globalThis.window.visualViewport
	let off = watchViewport(() => {})
	check(typeof off === 'function', '没有 visualViewport 时也得返回一个可调用的退订函数')
	off()

	globalThis.window.visualViewport = {
		addEventListener: (type) => log.push(`+${type}`),
		removeEventListener: (type) => log.push(`-${type}`),
	}
	const schedule = () => {}
	off = watchViewport(schedule)
	check(log.join(',') === '+resize,+scroll', `应该同时订阅 resize 和 scroll，实际是 ${log.join(',')}`)
	off()
	check(log.join(',') === '+resize,+scroll,-resize,-scroll', `退订时两个都要摘掉，实际是 ${log.join(',')}`)

	if (saved === undefined) delete globalThis.window.visualViewport
	else globalThis.window.visualViewport = saved
}

// ===== 用例 4：两张样式表各自的职责 =====
console.log('用例 4：NO_ZOOM 与 TAPPABLE 的分工')
{
	check(NO_ZOOM.touchAction === 'manipulation', 'NO_ZOOM 必须关掉双击缩放（顺带去掉 Safari 那 300ms 的点击延迟）')
	check(NO_ZOOM.WebkitTapHighlightColor === 'transparent', 'NO_ZOOM 必须去掉 iOS 的灰色点击高亮')
	// ⚠️ 这条是 NO_ZOOM 存在的**全部理由**：卡片外壳上只能用它。
	//    真让 user-select:none 盖到含 <input> 的容器上，iOS 里改名框就放不了光标。
	check(NO_ZOOM.userSelect === undefined && NO_ZOOM.WebkitUserSelect === undefined,
		'NO_ZOOM 里绝不能有 user-select —— 它是给含输入框的容器用的')

	check(TAPPABLE.touchAction === 'manipulation' && TAPPABLE.WebkitTapHighlightColor === 'transparent',
		'TAPPABLE 应该包含 NO_ZOOM 的全部')
	check(TAPPABLE.WebkitTouchCallout === 'none', 'TAPPABLE 必须挡掉 iOS 长按弹出的系统菜单')
	// ⚠️ React 的内联样式**不会自动补 vendor 前缀**，而 Safari 16.4 之前只认带前缀的那个。
	//    这两条必须成对出现，谁把带前缀的那条当冗余删掉，Safari 上就会一划选中一片字。
	check(TAPPABLE.userSelect === 'none' && TAPPABLE.WebkitUserSelect === 'none',
		'user-select 必须带前缀和不带前缀各写一份（React 不补前缀，老 Safari 只认带前缀的）')
}

// ===== 用例 5：别绕过 pointer.js 自己手写一份 =====
console.log('用例 5：user-select 只许从 pointer.js 出')
{
	const dir = new URL('../src/client/', import.meta.url)
	const offenders = []
	for (const name of readdirSync(dir)) {
		if (!name.endsWith('.js') || name === 'pointer.js') continue
		const text = readFileSync(new URL(name, dir), 'utf8')
		// 只看代码里真的写了这个 CSS 属性的地方，注释里提一嘴不算
		for (const line of text.split('\n')) {
			if (line.trim().startsWith('*') || line.trim().startsWith('//')) continue
			if (/\buserSelect\s*:/.test(line) && !/WebkitUserSelect/.test(line)) offenders.push(`${name}: ${line.trim()}`)
		}
	}
	check(offenders.length === 0,
		`这些地方自己写了不带前缀的 userSelect，Safari 16.4 之前不认 —— 改成摊开 TAPPABLE：\n    ${offenders.join('\n    ')}`)
}

// ===== 用例 6：输入框在 iOS 上不许把整页放大 =====
console.log('用例 6：输入框字号顶到 16px')
{
	// ⚠️ iOS Safari 的死规矩：聚焦一个字号 < 16px 的输入框，它会把整个页面放大过去，
	//    而且**不会自己缩回来**。导轨是 position:fixed 的，放大之后直接跑到屏幕外。
	//    宿主的 viewport meta 不归我们管，所以只能从字号这一头解。
	for (const name of ['ui-detail.js', 'ui-settings.js']) {
		const text = readFileSync(new URL(`../src/client/${name}`, import.meta.url), 'utf8')
		check(text.includes("'16px'"),
			`${name} 里的输入框丢了 16px 那条兜底 —— iOS 上聚焦它会把整页放大且缩不回来`)
	}
}

// ===== 用例 7：光标在名字框里时，卡片不许自己关掉 =====
console.log('用例 7：名字框里有光标 → 整张卡按住不放')
{
	// John 报的症状：在卡片里改名字，改着改着字跑到聊天框里去了。
	// 路径是「鼠标稍微飘出卡片 → onMouseLeave → 卡片关掉 → 输入框卸载 →
	// 焦点掉回宿主那个 Lexical 编辑器 → 后面敲的字全进聊天框」。
	check(keepsCard(false, true) === true, '光标在框里但还没改动时，也必须按住 —— 这正是出 bug 的那一档')
	check(keepsCard(true, false) === true, '改过了（哪怕鼠标已经不在框里）必须按住')
	check(keepsCard(true, true) === true, '两样都占当然按住')
	// 反面：两样都不占时必须放开，否则卡片永远关不掉，鼠标走了它还杵在那儿
	check(keepsCard(false, false) === false, '没光标也没改动时必须放开，不然卡片关不掉了')
	// 「删回原样」那一下：dirty 翻回 false，可光标还在框里
	check(keepsCard(false, true) === true, '把名字删回原样时 dirty 会翻假，但光标还在框里，仍要按住')
}

// ===== 用例 8：收藏图标那个「字」框不许卡住中文输入法 =====
console.log('用例 8：「字」框的输入法规矩')
{
	// John 报的：在收藏图标的「字」框里一输中文就退出。两个原因，两条都在源码里钉住。
	const text = readFileSync(new URL('../src/client/ui-detail.js', import.meta.url), 'utf8')
	// 取 FavIconRow 里那个 key:'char' 的输入框（到下一个 h( 为止够用了）
	const at = text.indexOf("key: 'char'")
	check(at > 0, "找不到「字」那个输入框（key: 'char'），这条用例该跟着改")
	const field = text.slice(at, at + 2600)

	// ① maxLength 会把**拼音**截断。"zhongguo" 八个字符才换来两个汉字，
	//    挂上 5 的上限，拼音打到第六个字母就没了，汉字根本拼不出来。
	check(!/maxLengths*:/.test(field), '「字」框又挂上了 maxLength —— 中文拼音会被当场截断，字打不出来')
	// ② 每敲一下就写存储、再让整条导轨重画，那一圈落在拼字中途会把候选冲掉。
	//    所以必须有草稿 + composition 的两道闸。
	check(/onCompositionStart/.test(field) && /onCompositionEnd/.test(field),
		'「字」框丢了 composition 事件 —— 拼字中途会被当成已经输完')
	check(/composing\.current/.test(field), '「字」框没看 composing 标志，拼音会被当成真的图标写进存储')
	// ③ 框里有光标就得把整张卡按住，否则鼠标一飘出去卡片就关了（和名字框同一条）
	check(/onHold/.test(field) && /onFocus/.test(field), '「字」框没把聚焦报上去 —— 鼠标一飘出卡片就整张关掉')
}

// ===== 用例 9：焦点被宿主抢走就抢回来，但只抢"没有理由"的那一次 =====
console.log('用例 9：焦点守卫的四种局面')
{
	// John 报的：卡片里打字打到一半跑进聊天框；Ctrl+A 想全选节点描述，全选的是聊天区。
	// 两个都是"焦点被别人悄悄拿走了"。宿主什么时候重挂组件我们管不了，只能抢回来。
	// 参数顺序：(焦点现在在卡片里吗, 这次失焦有用户动作能解释吗, 这个框还想要焦点吗)
	check(shouldRefocus(false, false, true) === true, '谁都没动、焦点自己没了 → 必须抢回来，这是整条机制存在的理由')

	// ⚠️ 下面三条是防"焦点陷阱"的。少任何一条，用户就再也点不走这个框 ——
	//    连关掉卡片都做不到，比原来的 bug 更糟。
	check(shouldRefocus(false, true, true) === false, '用户自己点了别处 → 他真的想走，不许抢')
	check(shouldRefocus(true, false, true) === false, '焦点落在卡片里别的东西上 → 自己人，不用抢')
	check(shouldRefocus(false, false, false) === false, '这个框自己已经不想要焦点了（提交/卸载）→ 不许抢')

	// 组合：用户点走 + 框也不想要了，当然不抢
	check(shouldRefocus(true, true, false) === false, '三条理由都在的时候更不该抢')

	// 只抢"最近没有用户动作"的那一次，靠一个时间窗判定
	check(pure.LEAVE_MS >= 150 && pure.LEAVE_MS <= 1000, `用户动作的时间窗 ${pure.LEAVE_MS}ms 不合理 —— 太短挡不住点击，太长等于关掉守卫`)
}

// ===== 用例 10：卡片里的键盘事件不许冒泡给宿主 =====
console.log('用例 10：输入框把键盘事件拦在自己家里')
{
	// John 报的：在节点描述里按 Ctrl+A，结果全选的是聊天区的文字。
	// 宿主在上层挂着自己的快捷键，不拦的话这个框里敲的每一下它都收得到。
	const text = readFileSync(new URL('../src/client/ui-detail.js', import.meta.url), 'utf8')
	for (const [name, at] of [['名字框', text.indexOf('export function NameField')], ['「字」框', text.indexOf("key: 'char'")]]) {
		check(at > 0, `找不到${name}，这条用例该跟着改`)
		const field = text.slice(at, at + 3200)
		const hook = field.indexOf('onKeyDown:')
		check(hook > 0, `${name} 没有 onKeyDown`)
		check(field.slice(hook, hook + 90).includes('event.stopPropagation()'),
			`${name}的 onKeyDown 没有第一时间 stopPropagation —— 宿主的 Ctrl+A / 回车会越过它`)
		check(field.includes('onKeyUp:') && field.includes('stopPropagation'),
			`${name}只拦了 keydown —— 有些快捷键是挂在 keyup 上的`)
	}
}

// ===== 用例 11：拼字中途一个按键都不许动 =====
console.log('用例 11：两个框都得先问一句"是不是在拼字"')
{
	// John 报的：在收藏图标的「字」框里打 "ceshiyixia"，还没选词就变成了那串英文。
	// 微软拼音**用空格或回车选词**，那一下会先派一个 keydown{key:'Enter', isComposing:true}；
	// 老写法看见 Enter 就 blur()，浏览器当场掐掉这次合成，把**拼音原文**当结果落进框里。
	const text = readFileSync(new URL('../src/client/ui-detail.js', import.meta.url), 'utf8')
	// 设置卡里那个「填字」框是同一套规矩的第二份，别只改一边
	const card = readFileSync(new URL('../src/client/ui-settings.js', import.meta.url), 'utf8')
	const own = card.indexOf("key: 'own'")
	check(own > 0, "找不到设置卡里那个「填字」框（key: 'own'）")
	const ownField = card.slice(own, own + 1800)
	check(!/maxLength\s*:/.test(ownField), '设置卡的「填字」框挂了 maxLength —— 中文拼音会被当场截断')
	check(/onCompositionStart/.test(ownField) && /composing\.current/.test(ownField),
		'设置卡的「填字」框没认拼字 —— 每敲一下就写设置、整棵树重画，候选会被冲掉')

	for (const [name, at] of [['名字框', text.indexOf('export function NameField')], ['「字」框', text.indexOf("key: 'char'")]]) {
		check(at > 0, `找不到${name}，这条用例该跟着改`)
		const field = text.slice(at, at + 3600)
		const hook = field.indexOf('onKeyDown:')
		const guard = field.indexOf('isComposingKey', hook)
		// 找的是**代码**里第一次对这几个键动手的地方，不是注释里提到它们的地方
		const acts = Math.min(
			...['Enter', 'Escape', 'Tab'].map((key) => {
				const found = field.indexOf(`event.key === '${key}'`, hook)
				return found === -1 ? Number.POSITIVE_INFINITY : found
			}),
		)
		check(hook > 0 && guard > hook, `${name}的 onKeyDown 没问"是不是在拼字"`)
		check(guard < acts, `${name}在问"是不是在拼字"之前就对 Enter/Esc/Tab 动手了 —— 中文选词会被掐掉`)
	}
}

// ===== 用例 12：关卡片之前先复核鼠标真的走了 =====
console.log('用例 12：mouseleave 说了不算，回到现场问一句')
{
	// John 报的：卡片展开着，点一下"取消收藏"，卡片自己收起来了（有时还不收）。
	// 那一下会改版式 —— 图标排整个消失、导轨宽度也变，而卡片是竖直居中的，
	// 变矮就等于内容在鼠标底下挪走了。鼠标一动没动，浏览器照样派 mouseleave 过来。
	const make = (kids) => {
		const node = { kids: kids || [], contains: (other) => other === node || node.kids.includes(other) }
		return node
	}
	const card = make()
	const shell = make([card])
	const chat = make()
	const at = { x: 100, y: 200 }

	check(overRail(shell, at, () => card) === true, '鼠标底下是卡片（导轨的子孙）→ 还在导轨上，不许关')
	check(overRail(shell, at, () => shell) === true, '鼠标底下就是导轨本身 → 不许关')
	check(overRail(shell, at, () => chat) === false, '鼠标底下是聊天区 → 真的走了，该关')

	// ⚠️ 几何上卡片浮在导轨框的**左边**，在框外。所以判据必须是 DOM 包含关系，
	//    不是矩形命中 —— 按矩形算的话，鼠标一挪到卡片上就被判成"走了"。
	check(overRail(shell, at, () => card) === true, '卡片在导轨框外面，但它是导轨的子孙，得算"还在"')

	// 退化情形：一律"该关就关"，否则卡片会永远挂在那儿
	check(overRail(null, at, () => card) === false, '没有导轨元素时该关')
	check(overRail(shell, null, () => card) === false, '还没收到过 mousemove 时该关')
	check(overRail(shell, at, () => null) === false, '那个坐标上什么都没有（划到视口外）时该关')
}

report()
