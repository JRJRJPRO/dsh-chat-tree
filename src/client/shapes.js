/**
 * 节点长什么样：形状、颜色、描边、填充。
 *
 * 一个角色（普通 / 当前路径 / 压缩 / 空）对应一组颜色和形状，设置里改的就是这些。
 * ⚠️ 形状归 kind/active，状态归 active/focused，两者**正交** —— 别把状态塞回 kind 里。
 */
import { h } from './runtime.js'
import { C, Z } from './const.js'
import { API } from './net.js'

/** 自定义形状的两个前缀：`char:★` = 画那个字；`img:<id>` = 画上传的那张图。 */
export const CUSTOM = 'char:'
export const PICTURE = 'img:'

/** 上传的图落在 host 半，这是取它的地址。 */
export const ICON_URL = `${API}/icon`

/**
 * 上传的图统一缩成 96×96 再存。
 *
 * 为什么是 96：点最大 `Z.dot(11) × 缩放 250% = 27.5px`，悬停再放大 1.4 倍 ≈ 38.5px，
 * 二倍屏上 77 个物理像素 —— 96 够用且有余，再大纯属白存。
 * （基准尺寸上调前这里是 64。改 Z.dot 时记得回来看一眼。）
 */
export const ICON_EDGE = 96

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
export const SHAPES = [
	{ value: 'circle', radius: '50%', spin: false },
	{ value: 'rounded', radius: '30%', spin: false },
	{ value: 'square', radius: 'px', spin: false },
	{ value: 'diamond', radius: 'px', spin: true },
	{ value: 'triangle', radius: 'px', spin: false, grow: 1.34, poly: [[0, 0.1], [1, 0.1], [0.5, 0.97]] },
]

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
export function polyPoints(points, edge, inset) {
	const span = Math.max(0, edge - inset * 2)
	return points.map(([x, y]) => `${(inset + x * span).toFixed(2)},${(inset + y * span).toFixed(2)}`).join(' ')
}

/**
 * 一个形状画出来占多大。`grow` 是为了让不同形状的**面积**看齐，不是边长。
 * @param shape - shapeSpec 的结果
 * @param size - 点的直径
 * @returns 边长（像素）
 */
export function shapeBox(shape, size) {
	return size * (shape.grow === undefined ? 1 : shape.grow)
}

/**
 * 上传的图的地址。
 * @param id - 图片 id（内容哈希）
 * @returns URL
 */
export function iconUrl(id) {
	return `${ICON_URL}?id=${encodeURIComponent(id)}`
}

/**
 * 四个角色各自的默认颜色与形状。设置里改的就是这张表。
 *
 * 空节点默认跟当前路径同色：它本来就永远在当前路径上，今天画出来就是这个蓝的，
 * 不该因为"多了个设置项"就悄悄换个样子。虚线边是它自己的记号，不跟着配置走。
 */
export const THEME = {
	normalColor: C.dim, normalShape: 'circle',
	currentColor: C.blue, currentShape: 'circle',
	compactColor: C.orange, compactShape: 'triangle',
	emptyColor: C.blue, emptyShape: 'circle',
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
 *   · `ink`  —— 描边色的不透明度；1 = 原色
 *   · `fill` —— 填充色的不透明度；`'bg'` = 不垫色，直接用背景色
 *   · `own`  —— 自带颜色，不随"在不在当前路径上"变（靠颜色表明**自己是什么**，
 *               而不是表明**自己在哪**）
 *   · `dashed` —— 虚线边，"还没说话"的记号；不跟着配置走
 */
export const ROLES = {
	normal: { color: 'normalColor', shape: 'normalShape', ink: 1, fill: 'bg' },
	current: { color: 'currentColor', shape: 'currentShape', ink: 0.9, fill: 0.18 },
	compact: { color: 'compactColor', shape: 'compactShape', ink: 1, fill: 0.3, own: true },
	empty: { color: 'emptyColor', shape: 'emptyShape', ink: 1, fill: 0.15, own: true, dashed: true, plus: 2 },
}

/**
 * 一个节点此刻算哪个角色。
 * @param kind - 节点形态（normal / compact / empty）
 * @param active - 在当前路径上
 * @returns ROLES 的键
 */
export function roleOf(kind, active) {
	if (ROLES[kind] !== undefined && ROLES[kind].own === true) return kind
	return active ? 'current' : 'normal'
}

/**
 * 这个角色画成虚线边吗。
 * @param kind - 节点形态
 * @returns 是否虚线
 */
export function dashedOf(kind) {
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
export function dotSizeOf(kind, dotSize, grow) {
	const role = ROLES[kind]
	const plus = role !== undefined && role.plus !== undefined ? role.plus : 0
	return (dotSize + plus) * (grow === undefined ? 1 : grow)
}

/**
 * 上色：alpha 为 1 时原样返回。
 *
 * ⚠️ 别偷懒写成 `fade(hex, 1)` —— 那会把 `#6e7681` 变成 `rgba(110,118,129,1)`，
 *    颜色一样但字符串不一样，快照类断言会整片红。
 * @param hex - `#rrggbb`
 * @param alpha - 0..1
 */
function tint(hex, alpha) {
	return alpha === 1 ? hex : fade(hex, alpha)
}

/**
 * 给颜色加透明度。主题色是 `#rrggbb`，但路径垫色 / 外发光 / 连线都要半透明，
 * 所以统一在这里转成 rgba —— 用户换了主色，这些派生色自动跟着换。
 * @param hex - `#rrggbb`
 * @param alpha - 0..1
 * @returns rgba() 字符串；认不出来就原样返回
 */
export function fade(hex, alpha) {
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
export function shapeSpec(want) {
	const text = typeof want === 'string' ? want : ''
	if (text.startsWith(CUSTOM)) {
		const glyph = text.slice(CUSTOM.length).trim()
		if (glyph !== '' && [...glyph].length <= 2) return { value: text, radius: 'px', spin: false, glyph }
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
 * @returns 一个 <span>
 */
export function preview(want, color, size, dashed) {
	const spec = shapeSpec(want)
	const skin = { ink: color, fill: fade(color, 0.3), accent: color }
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
	}, dotInside(spec, size, skin, 1.5, dashed))
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
export function shapeOf(kind, active, theme) {
	const role = ROLES[roleOf(kind, active)]
	return shapeSpec((theme || THEME)[role.shape])
}

/**
 * 一个节点此刻用什么描边色、什么填充色。
 *
 * 单独抽出来是因为**有两拨人要用同一套颜色**：方框类的 `dotStyle`，和多边形
 * 那个 `<svg><polygon>`。各算各的必然对不齐，最后就是三角和圆看着不是一套东西。
 * @param kind - normal / compact / empty
 * @param active - 在当前路径上
 * @param focused - 正看着这一轮
 * @param theme - 颜色与形状，缺省用 THEME
 * @returns `{accent, ink, fill}`
 */
export function inkOf(kind, active, focused, theme) {
	const skin = theme || THEME
	const role = ROLES[roleOf(kind, active)]
	const color = skin[role.color]
	// 外发光色 = **这个 kind 在当前路径上时**用的颜色。普通节点借当前路径的蓝，
	// 压缩和空节点用自己的色（它们本来就不随路径变）。
	const accent = skin[ROLES[roleOf(kind, true)].color]
	return {
		accent,
		ink: focused ? accent : tint(color, role.ink),
		fill: focused ? accent : role.fill === 'bg' ? C.bg : tint(color, role.fill),
	}
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
 * @returns 内联样式
 */
export function dotStyle(kind, active, hover, size, focused, theme, alpha) {
	const k = size / Z.dot
	const shape = shapeOf(kind, active, theme)
	const { accent, ink, fill } = inkOf(kind, active, focused, theme)
	// 多边形 / 字 / 图片都不靠这个 <span> 的 border+background 成形：
	// 方框会在图形外面套一圈，所以这三类一律把方框关掉，由里面的内容自己画。
	// 外发光也得换 —— box-shadow 画的是**方框**的光晕，套在三角外面就是个方的光。
	const drawn = shape.poly !== undefined || shape.glyph !== undefined || shape.image !== undefined
	return {
		width: `${size}px`, height: `${size}px`,
		borderRadius: shape.radius === 'px' ? `${1.5 * k}px` : shape.radius,
		borderWidth: drawn ? '0px' : `${1.5 * k}px`,
		borderStyle: dashedOf(kind) ? 'dashed' : 'solid',
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
		opacity: (focused || active ? 1 : 0.4) * (alpha === undefined ? 1 : alpha),
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
export function dotInside(shape, size, skin, stroke, dashed) {
	if (shape.glyph !== undefined) return shape.glyph
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
export function polyProps(shape, size, skin, stroke, dashed) {
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
