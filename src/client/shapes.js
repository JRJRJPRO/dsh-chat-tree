/**
 * 节点长什么样：形状、颜色、描边、填充。
 *
 * 一个角色（普通 / 当前路径 / 压缩 / 空）对应一组颜色和形状，设置里改的就是这些。
 * ⚠️ 形状归 kind/active，状态归 active/focused，两者**正交** —— 别把状态塞回 kind 里。
 */
import { h } from './runtime.js'
import { C, Z } from './const.js'
import { API, apiPrefix } from './net.js'

/** 自定义形状的两个前缀：`char:★` = 画那个字；`img:<id>` = 画上传的那张图。 */
export const CUSTOM = 'char:'
export const PICTURE = 'img:'

/** 上传的图落在 host 半，这是取它的路径（前缀另算，见 `iconUrl`）。 */
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
 * 自定义字最多几个字符（按**码点**数，emoji 算一个）。
 *
 * ⚠️ 这个数是**输入框和渲染共用**的唯一一份。以前输入框写 `maxLength: 4`、
 *    `shapeSpec` 只认 2 个，于是打到第 3 个字时框里明明有字、树上的图标却悄悄
 *    退回了默认 —— "能输入，但不生效"是最难查的那种（John 报的就是这条）。
 */
export const GLYPH_MAX = 5

/**
 * 字最多摊到点的几倍宽。
 *
 * 封顶是因为列距按画出来最宽的形状留（见 geometry.js 的 railLayout）：
 * 不封的话，某一个节点挂个 5 字标签，**整棵树**的列距都会被它撑开。
 */
export const GLYPH_SPAN = 3

/**
 * 一串字占点的几倍宽。`shapeSpec` 把它塞进 `grow`，于是列距、连线让位
 * 全都自动跟着走，不需要各处再认一次"这是个字"。
 * @param glyph - 那几个字
 * @returns 倍数，1..GLYPH_SPAN
 */
export function glyphGrow(glyph) {
	return Math.min(Math.max(1, [...String(glyph)].length), GLYPH_SPAN)
}

/**
 * 这几个字该用多大的字号。
 *
 * 按**汉字**算（一个字占一个 em）—— 拉丁字母比这窄，算宽一点只会显得小一号，
 * 反过来算窄了就会糊出框外。
 *
 * 小例子（点直径 11）：
 *   1 个字 → 宽 11，字号 11；2 个字 → 宽 22，字号 11；3 个字 → 宽 33，字号 11；
 *   4 个字 → 宽封顶在 33，字号 8.25；5 个字 → 宽 33，字号 6.6（小，但塞得下）。
 * @param glyph - 那几个字
 * @param size - 点的直径
 * @returns 字号（像素）
 */
export function glyphFont(glyph, size) {
	const count = Math.max(1, [...String(glyph)].length)
	return (size * glyphGrow(glyph)) / count
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
export const SHAPES = [
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
export function polyArea(points) {
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
export function growOf(points) {
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
export function regularPoly(sides, turn) {
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
export function crossPoly(thick) {
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
export function drawnWidth(shape, size) {
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
export function shapeHeight(shape, size) {
	if (shape.glyph !== undefined) return size
	return shapeBox(shape, size)
}

/**
 * 上传的图的地址。
 * @param id - 图片 id（内容哈希）
 * @returns URL
 */
export function iconUrl(id) {
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
 * 【现在怎么办】换一条路：**颜色只有一个，分工有两层**。
 *   · 星身（`fill`）—— 一律用这个亮黄本身，负责"这是黄的"
 *   · 描边（`ink`）—— 从它算出来的一个更深的同色，负责"看得见"（见 `starInkOf`）
 * 于是白底上是"深橄榄描边 + 亮黄星身"，一眼是颗黄星；深底上星身自己就够亮。
 *
 * ⚠️ 这个值**亮得几乎没法直接当描边用**（对白底只有 1.16:1）—— 这是故意的。
 *    它只负责填充，对比度整个交给描边扛。想换基色的话记住这条分工，
 *    别挑一个"描边也凑合能用"的中间调：那正好两头都不讨好。
 */
export const STAR_COLOR = '#ffd43b'

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
export const PALETTE = {
	dark: { normalColor: '#6e7681', currentColor: '#58a6ff', compactColor: '#ffa657', emptyColor: '#58a6ff' },
	// 压缩色用的是宿主自己的 amber-600（`--dsw-static-amber-600`），
	// 和界面其它"警示"语义同色；早先那个 #bc4c00 烧焦橙在白底上太闷。
	light: { normalColor: '#8c959f', currentColor: '#1f6feb', compactColor: '#dd8629', emptyColor: '#1f6feb' },
}

/**
 * 形状默认值。颜色跟着 `PALETTE` 走，不写在这儿。
 *
 * `favoriteShape` 在这儿而不在 PALETTE 里，是因为收藏的默认色**不分明暗**
 * （就一个 `STAR_COLOR`，明暗差别整个交给 `starInkOf` 算描边）。
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
export function paletteOf(dark) {
	return Object.assign({}, SHAPE_DEFAULTS, dark === false ? PALETTE.light : PALETTE.dark)
}

/**
 * 默认主题 = 暗色版。
 *
 * 留着它是因为一堆地方要一个"没有设置时也能画"的兜底（`shapeOf(kind, active)`
 * 不传 theme 时用的就是它）。真正画树时 Rail 会按**当前明暗**现算一份。
 */
export const THEME = paletteOf(true)


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
export function starPoly(points, inner) {
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
export const STAR = poly('star', starPoly())

/**
 * 一个收藏节点该用哪个形状。
 *
 * 收藏**可以换图标**（详情卡里那一排）。颜色**默认**恒为那个黄 ——
 * 那是"一眼能扫出来"的全部依据，所以不改的话谁都是黄的；
 * 真要按点分色（比如红=待办、绿=已验证）也给得出，见 `want`。
 * @param want - 用户挑的形状值：预设 id / `char:<字>` / `img:<id>`；空 = 默认
 * @returns 画法；空或认不得一律退回五角星
 */
export function favShape(want) {
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
export const BACKDROP = { dark: '#0d1117', light: '#ffffff' }

/** 图形类元素的对比度下限（WCAG 1.4.11 非文本对比度就是 3:1）。 */
export const CONTRAST_MIN = 3

/**
 * 描边至少要比星身深多少倍，边才描得出来。
 *
 * 深底上星身本来就够亮（`#fbf431` 对深底 16:1），光按"对底色 3:1"算的话描边 = 星身，
 * 那颗星就成了一块没有轮廓的黄斑。所以还要单独跟**星身自己**比一次。
 */
export const STAR_EDGE = 1.6

/**
 * WCAG 相对亮度。
 * @param hex - `#rrggbb`
 * @returns 0..1；认不出来的返回 0
 */
export function relLuminance(hex) {
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
export function contrastRatio(one, other) {
	const a = relLuminance(one)
	const b = relLuminance(other)
	return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)
}

/**
 * `#rrggbb` → HSL（h 0..360，s/l 0..1）。
 * @param hex - `#rrggbb`
 * @returns `{h, s, l}`
 */
export function hexToHsl(hex) {
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
export function hslToHex(hsl) {
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
 * `dir` 给 `'darker'` / `'lighter'` 可以钉死方向 —— 描边就要钉死往深里调，
 * 因为**浅一档的描边读起来像光晕，不像边**（见 `starInkOf`）。
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
export function fitContrast(hex, backdrop, target, dir) {
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
 * 收藏那颗星的描边色。
 * @param seed - 星身那个颜色 `#rrggbb`
 * @param dark - 是不是暗色
 * @returns `#rrggbb`
 */
export function starInkOf(seed, dark) {
	// 描边要**同时**满足两条，不是二选一：
	//   · 对**页面底色**够 3:1 —— 白底上那条说了算（亮黄自己才 1.4:1）
	//   · 对**星身**够 STAR_EDGE —— 深底上那条说了算（星身已经很亮，描边得压下去才看得见边）
	const page = dark === false ? BACKDROP.light : BACKDROP.dark
	const ok = (hex) => contrastRatio(hex, page) >= CONTRAST_MIN - 1e-9 && contrastRatio(hex, seed) >= STAR_EDGE - 1e-9
	// 两步都往**同一个方向**推，所以第二步只会让第一条更宽松，不会把它推回去。
	const push = (way) => fitContrast(fitContrast(seed, seed, STAR_EDGE, way), page, CONTRAST_MIN, way)
	// ⚠️ 先往深里试。浅一档的描边读起来像**光晕**，不像边 —— 只有深的才描得出轮廓。
	const darker = push('darker')
	if (ok(darker)) return darker
	// 深到黑了还够不着（底色本来就比它深，比如用户挑了个近黑色）—— 那只能往亮里让
	const lighter = push('lighter')
	return ok(lighter) ? lighter : darker
}

/**
 * 收藏节点的描边色和填充色。
 *
 * 分工：**星身填那个亮黄，描边扛对比度**（见 STAR_COLOR 和 starInkOf）。
 *
 * ⚠️ "平时空心、走到那一轮才填实"这条**取消了**。原来靠空心/实心区分当前点，
 *    可空心意味着只剩一圈描边，而描边为了对比度必须压深 —— 白底上看到的就是
 *    "一圈黑线"（John 报的"浅色模式下特别黑"）。现在一律填实，
 *    "正看着这一轮"改由**外发光**表示（`dotStyle` 里那条 drop-shadow 本来就只在 focused 时挂）。
 * @param focused - 正看着这一轮（= 当前点）
 * @param dark - 是不是暗色
 * @param icon - 这个点自己挑的图标；空 = 跟着默认走
 * @param want - 这个点自己挑的颜色；空 / 认不得 = 跟着默认走
 * @param theme - 当前主题；收藏的默认色和默认图标在设置里可改，从这儿取
 * @returns `{accent, ink, fill, shape}` —— 前三项和 inkOf 的返回值一致，好喂给同一套画法
 */
export function starSkin(focused, dark, icon, want, theme) {
	const skin = theme || THEME
	// 用户改过这个点就用他挑的；没改过就用设置里的默认；设置也认不得就退回出厂那个黄。
	// 认得严一点：这个字符串要直接进 CSS。
	const ok = (value) => typeof value === 'string' && /^#[0-9a-fA-F]{6}$/.test(value)
	const seed = (ok(want) ? want : ok(skin.favoriteColor) ? skin.favoriteColor : STAR_COLOR).toLowerCase()
	const ink = starInkOf(seed, dark)
	// 外发光用**星身那个亮色**，不用压深过的描边色 —— 深色的光晕看着像脏了一圈
	return {
		accent: seed,
		ink,
		fill: seed,
		shape: favShape(icon === undefined || icon === null || icon === '' ? skin.favoriteShape : icon),
	}
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
		// grow = 横向占几倍宽。挂在 spec 上，列距和连线让位就自动跟着走了。
		if (glyph !== '' && [...glyph].length <= GLYPH_MAX) return { value: text, radius: 'px', spin: false, glyph, grow: glyphGrow(glyph) }
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
 * @param override - 已经解析好的画法。收藏那排要用 `favShape` 解（`'star'` 在
 *                   `shapeSpec` 眼里是认不得的，会退回圆），所以给个口子让调用方
 *                   把解析权拿走 —— 而不是在这里再塞一个"是不是收藏"的开关。
 * @returns 一个 <span>
 */
export function preview(want, color, size, dashed, override) {
	const spec = override === undefined || override === null ? shapeSpec(want) : override
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
 * @param star - `starSkin()` 的结果；给了就整个换成五角星（收藏），不给就照角色画
 * @returns 内联样式
 */
export function dotStyle(kind, active, hover, size, focused, theme, alpha, star) {
	const k = size / Z.dot
	// 收藏过的点整个换成五角星：形状和颜色都由 `star` 说了算，角色那一套全部让位。
	// 之所以传进来一个**算好的 skin** 而不是一个 `starred` 布尔，是因为星星的黄
	// 要分明暗两版，而 dotStyle 手里只有 theme、不知道现在是明是暗。
	// 收藏的形状由 `starSkin` 一起带过来（用户能在详情卡里换图标）；
	// 老调用方只传 `{accent, ink, fill}` 的话退回五角星。
	const shape = star === undefined ? shapeOf(kind, active, theme) : star.shape || STAR
	const { accent, ink, fill } = star === undefined ? inkOf(kind, active, focused, theme) : star
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
export function dotInside(shape, size, skin, stroke, dashed) {
	// ⚠️ 字**不能**直接当 <span> 的文本内容返回。那个 span 是 size×size 的方框，
	//    两个字以上就会从右边糊出去（不是居中溢出）—— 这就是"超过 2 个字就不对劲"的
	//    另一半。和多边形一样绝对居中，字号按字数自己缩，横向往两边等量溢出。
	if (shape.glyph !== undefined) {
		return h('span', {
			style: {
				position: 'absolute', left: '50%', top: '50%', transform: 'translate(-50%, -50%)',
				whiteSpace: 'nowrap', pointerEvents: 'none',
				fontSize: `${glyphFont(shape.glyph, size)}px`, lineHeight: 1,
			},
		}, shape.glyph)
	}
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
