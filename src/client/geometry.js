/**
 * 导轨上的几何：连线怎么拐、线在哪儿停、鼠标压着哪个点。
 *
 * 全是纯函数，坐标系一律是"导轨内"（左上角为原点）。
 */
import { scaleZ } from './const.js'
import { dotSizeOf, shapeBox, shapeOf } from './shapes.js'

/**
 * 导轨的一整套尺寸：行高、列宽、点多大、(列,行) 怎么换算成像素。
 *
 * 从渲染里抽出来是因为它**全是纯算术**，却是最容易出"差半个像素"那类毛病的地方；
 * 留在组件里的话，只能靠人眼在浏览器里比对。
 *
 * 小例子（聊天区高 600、缩放 100%、12 行、最宽 2 列）：
 *   available = 600 - 16×2 = 568；rowH = min(24, 568/12) = 24；树高 288；
 *   railWidth = 22 + 2×17 = 56；第 0 列的圆心 x = 56 - 11 = 45。
 *
 * @param box - 聊天区的位置和大小
 * @param scale - 节点缩放百分比
 * @param rows - 省略之后实际要画几行
 * @param maxColumn - 图上最宽到第几列（**不是可见列** —— 省略随滚动变，导轨宽度不该跟着跳）
 * @returns 尺寸表 + 两个换算函数
 */
export function railLayout(box, scale, rows, maxColumn) {
	const z = scaleZ(scale)
	const available = box.height - z.pad * 2
	// 放不下就压行高（下限 rowMin）。鱼眼不额外占行：淡出的那两圈本来就在半径里面，
	// 顶底不再留"放省略号"的空行。
	const rowH = Math.max(z.rowMin, Math.min(z.row, available / Math.max(1, rows)))
	const railWidth = z.hit + maxColumn * z.lane
	return {
		z,
		available,
		rowH,
		treeHeight: rows * rowH,
		railWidth,
		dotSize: Math.max(z.dotMin, Math.min(z.dot, rowH - z.dotPad)),
		/** 第 column 列的圆心 x。列号从右往左长，所以是减。 */
		xOf: (column) => railWidth - z.hit / 2 - column * z.lane,
		/** 第 row 行的圆心 y。 */
		yOf: (row) => row * rowH + rowH / 2,
	}
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
 * @returns 像素，恒大于 0
 */
export function reachFor(kind, active, dotSize, theme, grow) {
	const size = dotSizeOf(kind, dotSize, grow)
	const shape = shapeOf(kind, active, theme)
	// 多边形按它实际画多大让（三角放大了 1.34 倍），不然尖角会戳到线上
	return (shape.spin ? size * 0.71 : shapeBox(shape, size) / 2) + 1
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
export function segments(xFrom, xTo, yFrom, yTo, gapFrom, gapTo) {
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

/**
 * 连线的绘制顺序。
 *
 * ⚠️ 蓝线必须最后画。同一个父节点的几个孩子，横段都贴在父节点那一行，越远的
 *    孩子横段越长 —— 短的会整段盖住长的右半截。谁后画谁赢（都没设 z-index，
 *    DOM 顺序说了算），所以灰的先来，蓝的压在最上面。
 *    别改成给蓝线加 z-index：那会连节点圆点一起盖住。
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
 *    左边每一列（列距 17px < 命中区 22px），沿途每个点都会抢走卡片，
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
