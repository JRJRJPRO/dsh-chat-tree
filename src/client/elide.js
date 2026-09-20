/**
 * 省略：只画离你正在看的那一轮若干步以内的节点，最外两圈鱼眼淡出。
 */
import { isFocusedNode } from './tree.js'

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
export const FADE = { rings: 2, scale: [1, 0.74, 0.52], alpha: [1, 0.66, 0.4] }

/**
 * 第 level 圈画多小、多淡。
 * @param level - 0 = 正常，往外每圈 +1；超出 rings 的一律按最外圈算
 * @returns `{scale, alpha}`，两者都 ∈ (0, 1]
 */
export function fisheye(level) {
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
export function elide(nodes, anchor, radius) {
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
export function anchorNode(nodes, activeTurn) {
	const focused = nodes.find((node) => isFocusedNode(node, activeTurn))
	if (focused !== undefined) return focused
	let deepest
	for (const node of nodes) if (node.active === true && (deepest === undefined || node.depth > deepest.depth)) deepest = node
	return deepest || nodes[0]
}
