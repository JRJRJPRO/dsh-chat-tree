/**
 * 导轨上的几何：连线怎么拐、线在哪儿停、鼠标压着哪个点。
 *
 * 全是纯函数，坐标系一律是"导轨内"（左上角为原点）。
 */
import { BAND, Z, scaleZ } from './const.js'
import { STAR, dotSizeOf, shapeHeight, shapeOf } from './shapes.js'

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
export function railLayout(box, scale, rows, maxColumn, widestOf, room) {
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
 * 列距压到比一个形状还窄时，这个形状该等比缩到几分之几。
 *
 * `railLayout` 压列距的下限是"两个圆点分得开"（`dotSize + 2`），不看形状有多宽：
 * 星星（1.67 倍）、菱形（1.41 倍）、带框的字（最窄也是 1.7 倍）在那种列距下都会
 * 叠到隔壁列上（youli42 报的 issue #1 的极端情形：窄到普通圆点都快贴上的时候）。
 * 修法：画的时候把它**整个等比缩小**到塞得进 `列距 − 间隙`，但**最小缩到一个圆点那么大**
 * —— 这时它和普通圆点一样只剩两像素缝，看得清是个星星就够了，再小就认不出来了。
 *
 * 没压的时候列距本来就按最宽的形状留，算出来恒为 1，画法一个像素都不变。
 *
 * 小例子（点 11px、间隙 5px）：
 *   星星 18.4px、列距 23.4（没压）→ 房间 max(11, 18.4) = 18.4 → 1，原样；
 *   星星 18.4px、列距 13（压到底）→ 房间 max(11, 8) = 11 → 11/18.4 = 0.6，星星画成 11px。
 * @param wide - 这个形状按当前点直径画出来多宽（`drawnWidth`）
 * @param lane - 压完的列距
 * @param gap - 两列之间至少留多少（`Z.laneGap`）
 * @param dotSize - 点的直径 —— 缩的下限
 * @returns 0..1 的倍数
 */
export function shrinkToLane(wide, lane, gap, dotSize) {
	if (!(wide > 0) || !Number.isFinite(lane)) return 1
	const room = Math.max(dotSize > 0 ? dotSize : 0, lane - (Number.isFinite(gap) ? gap : 0))
	return room > 0 ? Math.min(1, room / wide) : 1
}

/**
 * 同一行上每个节点能摊多宽：自定义字的框向**这一行**的空位借地方（BACKLOG T2）。
 *
 * 【为什么】老规则按列距一刀切：列距一压，每个字框都只剩"列距 − 间隙"那么宽，
 * 2~4 个字的名字全画成「…」。可同一行上往往只有一两格有东西 —— 左右的空位白空着。
 * 这里把一行当成一条线段来分：每个节点圈一块地盘 `[x − left, x + right]`，
 * 相邻两块之间留 `gap`，字框就画在自己的地盘里（不一定居中，见 `boxShift`）。
 *
 * 规矩：
 *   · 每块地盘至少盖住自己的**核心** `[x − coreL, x + coreR]`。圆点 / 星星的核心就是
 *     它自己（半个画宽）；字框的核心是"线从框的平边进出、不戳在圆角上"那么宽。
 *     核心可以不对称：一个节点自己的岔路拐角（横段拐下去的那一列）也算进它的核心 ——
 *     自己的字框可以盖住自己的拐角（线从框底下出去），邻居借不过来。
 *   · 两边都要不够时**公平分**（按宽度对半，谁要的少谁先满足）；一边有富余就让给另一边。
 *     来回扫几遍，富余会顺着一行传过去 —— 夹在中间的那个不会被两头挤成「…」。
 *   · 两边都够时分界线尽量落在"两个框都居中"的位置，空间够的场面一个像素都不挪。
 *   · 连线**不算**占位（别人的拐角除外，见上）。
 *
 * 小例子（三列全是字、每个想要 44px、导轨 [0, 100]、间隙 5、列在 x = 24.5 / 50 / 75.5）：
 *   一刀切的老规则：每个框 ≤ 列距 25.5 − 5 = 20.5px → 只剩「…」；
 *   这里：先按"居中"分出 34.75 / 20.5 / 34.75，再来回扫：两头分给中间，收敛到约 30 / 30 / 30。
 *
 * @param items - 这一行的节点（任意顺序），形如 `{x, coreL, coreR, want}`；
 *                `want` = 它最多想要多宽（字框 = 全宽，圆点 = 自己的宽）
 * @param lo - 左边最远借到哪（导轨坐标，可以是负数 = 借到导轨外的空当里）
 * @param hi - 右边最远借到哪
 * @param gap - 相邻两块地盘之间留多少
 * @returns 和 `items` 同序的 `{left, right}`：地盘从 x 往左 / 往右各多远（恒非负）
 */
export function rowSlots(items, lo, hi, gap) {
	const g = Number.isFinite(gap) ? gap : 0
	const num = (value) => (Number.isFinite(value) ? value : 0)
	const order = items.map((item, at) => ({ item, at })).sort((a, b) => a.item.x - b.item.x)
	const n = order.length
	const x = (k) => order[k].item.x
	const want = (k) => num(order[k].item.want)
	const clamp = (value, low, high) => Math.min(high, Math.max(low, value))
	// 第 k 条分界线（夹在第 k 和第 k+1 个之间）能落的范围：两边的核心都得留住
	const lowOf = (k) => x(k) + num(order[k].item.coreR) + g / 2
	const highOf = (k) => x(k + 1) - num(order[k + 1].item.coreL) - g / 2
	const cut = []
	const stuck = []
	for (let k = 0; k + 1 < n; k += 1) {
		// 两个核心已经挤在一起了（列距压到底）：分界线钉在中间，谁也别借
		stuck[k] = lowOf(k) > highOf(k)
		// 起点：两个框都居中时，它们外缘的中点
		const natural = (x(k) + want(k) / 2 + x(k + 1) - want(k + 1) / 2) / 2
		cut[k] = stuck[k] ? (lowOf(k) + highOf(k)) / 2 : clamp(natural, lowOf(k), highOf(k))
	}
	const from = (k) => (k === 0 ? lo : cut[k - 1] + g / 2)
	const to = (k) => (k === n - 1 ? hi : cut[k] - g / 2)
	// 来回扫：每次只动一条分界线，看它两边那两块地盘该怎么分。
	// 扫的遍数和节点数同阶就够让富余从一头传到另一头。
	for (let sweep = 0; sweep < 2 * n + 2; sweep += 1) {
		for (let step = 0; step + 1 < n; step += 1) {
			const k = sweep % 2 === 0 ? step : n - 2 - step
			if (stuck[k]) continue
			const a = from(k)
			const b = to(k + 1)
			const total = b - a - g
			let next
			// 两个都够：分界线别动，除非动了才能两个都装下
			if (want(k) + want(k + 1) <= total) next = clamp(cut[k], a + want(k) + g / 2, b - want(k + 1) - g / 2)
			// 不够：对半分，谁要的少谁先满足、剩下的归另一个
			else next = a + Math.min(want(k), Math.max(total - want(k + 1), total / 2)) + g / 2
			cut[k] = clamp(next, lowOf(k), highOf(k))
		}
	}
	const out = new Array(n)
	for (let k = 0; k < n; k += 1) out[order[k].at] = { left: Math.max(0, x(k) - from(k)), right: Math.max(0, to(k) - x(k)) }
	return out
}

/**
 * 一个宽 `width` 的框在地盘 `[x − left, x + right]` 里该往哪边挪多少（正 = 往右）。
 *
 * 能居中就居中（返回 0）；居中会出界就贴着那一边，往另一边挪。
 * 比地盘还宽（只在压到底时发生）就居中在地盘里。
 *
 * 小例子（框 44、地盘往左 60、往右 12 —— 第 0 列贴着导轨右缘）：
 *   居中的话右边要 22 > 12 → 往左挪 10，框 = [x − 32, x + 12]。
 * @param width - 框宽
 * @param left - 地盘从 x 往左多远
 * @param right - 地盘从 x 往右多远
 * @returns 框中心相对 x 的偏移
 */
export function boxShift(width, left, right) {
	if (width >= left + right) return (right - left) / 2
	return Math.min(Math.max(0, width / 2 - left), right - width / 2)
}

/**
 * 给树留的带子实际多宽：设置里要多少就多少，但不许超过聊天区的一半，也不许是负的 / 认不得的值。
 *
 * 小例子：设置 240、聊天区 1200 宽 → 240；设置 600、聊天区 900 宽 → 450；设置 'x' → 默认 BAND.fallback。
 * @param want - 设置或拖动给的宽度
 * @param boxWidth - 聊天区宽度；不知道就只按 BAND.max 夹
 * @returns 像素，恒在 [0, min(BAND.max, boxWidth/2)] 内
 */
export function bandWidth(want, boxWidth) {
	const value = Number.isFinite(want) ? want : BAND.fallback
	const cap = Number.isFinite(boxWidth) && boxWidth > 0 ? Math.min(BAND.max, boxWidth / 2) : BAND.max
	return Math.max(0, Math.min(cap, value))
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
export function railRight(box, railWidth, viewWidth, gap) {
	const pad = Number.isFinite(gap) ? gap : Z.gap
	return Math.max(0, viewWidth - box.right) + pad
}

/** 详情卡和它那个点之间留多少空白（px）。 */
export const CARD_GAP = 8

/**
 * 详情卡的 `right`（离导轨**右**缘多远，值越大越靠左）。
 *
 * 规矩：**贴着那个点本身，不是贴着整条导轨的左缘。**
 *
 * 以前这里写死 `railWidth + 4`，也就是不管点在第几列，卡片一律甩到整棵树的
 * 左边去。树只有一列时看不出来；某个点一旦分出五个岔，`maxColumn` 变成 4，
 * 第 0 列（主干，也就是最常悬停的那一列）的卡片就被推到四个列距之外 ——
 * John 的原话是"中间隔了 4 个结点，有点太远了"。
 *
 * 业界做法就一条（Floating UI / Popper 的 `reference` + `offset`，
 * Material、Primer、Ant Design 的 popover 全是这个）：
 * **浮层锚在触发元素上**，中间只留一个固定的小 offset；容器只用来做碰撞检测
 * （flip / shift），不用来当锚点。这里的碰撞检测已经有了 —— 宽度 `maxWidth: 60vw`
 * 加上导轨自己的压列距（railRoom），所以只差"锚回点上"这一步。
 *
 * 代价是卡片会盖住它左边那几条岔路线。这是所有图形界面的 hover 卡片都在付的
 * 代价（GitKraken / VS Code Git Graph / GitHub 的提交图都盖），而且一行最多
 * 只有一个点，被盖住的基本是穿过去的连线，不是别的点。走开就还回去。
 *
 * 小例子（railWidth 116、edge 22、lane 23.4、hitW 23.4、点在第 0 列）：
 *   x = 116 - 11 = 105；right = 116 - 105 + 11.7 + 8 = 30.7
 *   —— 老写法是 116 + 4 = 120，整整近了 89px。
 *   同一棵树里最左那列（第 4 列）：x = 105 - 93.6 = 11.4；right = 124，
 *   和老写法的 120 差不多 —— 说明这一改**只把不该远的拉近，没把该远的推远**。
 *
 * @param railWidth - 导轨宽
 * @param x - 点的圆心 x（导轨内坐标系，左缘为 0）
 * @param hitW - 命中区宽度，卡片从命中区外缘再让 `CARD_GAP`
 * @returns CSS `right` 的像素值
 */
export function cardAnchor(railWidth, x, hitW) {
	return railWidth - x + hitW / 2 + CARD_GAP
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
export function railRoom(box, gap) {
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
export function reachFor(kind, active, dotSize, theme, grow, starred) {
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
 * @param sideFrom - 父这端**横向**让开多少（朝孩子那一侧）。缺省 = `gapFrom`。
 *                   父节点是个横着摊开的字框时，横段得从框边起，不然线从字中间穿过去；
 *                   框一直盖到孩子那一列的话横段整个不画，竖段从框的下沿起。
 * @returns 若干段 `{tag, left, top, width, height}`，长度为 0 的段不返回
 */
export function segments(xFrom, xTo, yFrom, yTo, gapFrom, gapTo, sideFrom) {
	const out = []
	const half = 0.5 // 线宽的一半：把线的中心对齐到节点中心
	const side = Number.isFinite(sideFrom) ? sideFrom : gapFrom
	// 孩子那一列被父节点的框盖住了：当成"不拐弯"，竖段从框的下沿直接下去
	const bent = xTo !== xFrom && side < Math.abs(xTo - xFrom)
	if (bent) {
		const near = xFrom + (xTo > xFrom ? side : -side)
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
export const MIN_RUN = 0.5

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
export function trimRuns(runs) {
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
export function edgeOrder(nodes) {
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
export function hoverNext(hover, at) {
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
export function nodeAt(seats, x, y, w, hgt) {
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
