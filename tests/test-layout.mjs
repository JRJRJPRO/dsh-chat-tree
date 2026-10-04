/**
 * dsh-chat-tree —— 版式：列距、横向落位、连线去重、跟别的插件共处。
 *
 * 【导读】
 * 干嘛的：钉住这三件肉眼才看得见、代码里却最容易悄悄退化的事。
 *   · 列距要按**画出来最宽的那个形状**留，不是按点的直径留（收藏成星星就会贴脸）
 *   · 树贴着聊天区右缘钉死；横向放不下就压列距，别压到正文上或者从屏幕左边出去
 *   · 聊天被别的插件的浮层整个盖住时，树得跟着收起来
 *   · 同一行上的横段一像素只许画一次（不然一个父节点带几个孩子，横线就忽粗忽细）
 *   · 详情卡锚在**那个点**上，岔路多了也不许被甩到整棵树的左边去
 *   · 自定义字的框向同一行的空格子借地方，不按列距一刀切成「…」
 *
 * 阅读顺序：
 *   第1步  取 client 的真函数
 *   第2步  用例 1：列距跟着最宽的形状走
 *   第3步  用例 2：靠右钉死 + 放不下就压列距
 *   第4步  用例 3：正文右缘怎么量
 *   第5步  用例 4：被盖住的判定
 *   第6步  用例 5：同一行的横段不许重复画
 *   第7步  用例 6：详情卡贴着那个点放，不贴整棵树的左缘
 *   第8步  用例 7：列距被压过之后，自定义字的框不许叠到隔壁列（issue #1）
 *   第9步  用例 8：滚动容器里挂的是别的页签（Trajectory）时，树该收起来
 *   第10步 用例 9：自定义字按"这一行"的空位摊开，邻居之间公平分（T2）
 *
 * 跑法：node tests/test-layout.mjs
 *
 * @module test-layout
 */

import { check, loadClientPure, report } from './test-kit.mjs'

const pure = await loadClientPure()
const { Z, railLayout, railRight, railRoom, drawnWidth, shapeBox, contentRightOf, isCovered, trimRuns, segments, MIN_RUN, SHAPES, STAR, cardAnchor, CARD_GAP } = pure

/** 一个够高够宽的聊天区，免得 rowH 被压到下限、dotSize 跟着缩。 */
const BOX = { top: 0, height: 600, right: 1600 }

// ===== 第2步：用例 1 —— 列距跟着最宽的形状走 =====
{
	console.log('用例 1：列距按"画出来最宽的那个形状"留，不按点的直径留')

	// 全是圆点：最宽就是点本身，下限 Z.lane 说了算 —— 老几何一点没变
	const plain = railLayout(BOX, 100, 12, 2, (size) => size)
	check(plain.lane === Z.lane, `全是圆点时列距该维持 ${Z.lane}，实际 ${plain.lane}`)
	check(plain.edge === Z.hit, `全是圆点时第 0 列该维持 ${Z.hit}，实际 ${plain.edge}`)
	check(plain.railWidth === Z.hit + 2 * Z.lane, `全是圆点时导轨宽该是 ${Z.hit + 2 * Z.lane}，实际 ${plain.railWidth}`)

	// 不传 widestOf 必须和"最宽就是点本身"给出一模一样的结果（老调用方不受影响）
	const bare = railLayout(BOX, 100, 12, 2)
	check(bare.railWidth === plain.railWidth && bare.xOf(1) === plain.xOf(1), '省略 widestOf 时该退回老几何')

	// 收藏成五角星（1.67 倍）：11px 的点画出来 18.4px，塞不进 17px 的列
	const starW = shapeBox(STAR, plain.dotSize)
	check(starW > Z.lane, `这条用例的前提是星星比列宽（星星 ${starW.toFixed(1)}px / 列 ${Z.lane}px），前提没了就该重写用例`)
	const starred = railLayout(BOX, 100, 12, 2, () => starW)
	check(starred.lane >= starW + Z.laneGap, `有星星时列距该至少 ${(starW + Z.laneGap).toFixed(1)}，实际 ${starred.lane.toFixed(1)}`)

	// 这才是 John 报的症状本身：相邻两列的星星之间**必须留得下空白**
	const clear = Math.abs(starred.xOf(0) - starred.xOf(1)) - starW
	check(clear >= Z.laneGap - 1e-9, `两颗相邻的星星之间只剩 ${clear.toFixed(1)}px 空白，至少要 ${Z.laneGap}px`)
	const clearWas = Math.abs(plain.xOf(0) - plain.xOf(1)) - starW
	check(clearWas < 0, `改动前该是"贴上甚至叠上"（算出来 ${clearWas.toFixed(1)}px），否则这条用例抓不到 bug`)

	// 第 0 列也要撑开：不然星星的右半边会探到导轨外面去
	check(starred.railWidth - starred.xOf(0) >= starW / 2, '第 0 列的星星右半边探出了导轨')

	// 最宽的形状是哪个都认，包括以后新加的
	for (const shape of [...SHAPES, STAR]) {
		const wide = drawnWidth(shape, plain.dotSize)
		const laid = railLayout(BOX, 100, 12, 2, () => wide)
		const gap = Math.abs(laid.xOf(0) - laid.xOf(1)) - wide
		check(gap >= Z.laneGap - 1e-9, `形状「${shape.value}」相邻两列只剩 ${gap.toFixed(1)}px 空白`)
	}

	// 菱形是正方形转 45°，横向占的是**对角线**，不是边长
	const diamond = SHAPES.find((item) => item.spin === true)
	check(diamond !== undefined, 'SHAPES 里该有一个 spin 形状（菱形）')
	check(Math.abs(drawnWidth(diamond, 10) - 10 * Math.SQRT2) < 1e-9, `菱形横向该占对角线 ${(10 * Math.SQRT2).toFixed(2)}，实际 ${drawnWidth(diamond, 10).toFixed(2)}`)
	check(drawnWidth(SHAPES[0], 10) === 10, '圆点横向就占直径，不该被 √2 顺手乘上')

	console.log(`  圆点 ${plain.lane}px / 星星 ${starred.lane.toFixed(1)}px；十三种形状相邻两列都留得下 ${Z.laneGap}px`)
}

// ===== 第3步：用例 2 —— 靠右钉死 + 放不下就压列距 =====
{
	console.log('用例 2：导轨贴着聊天区右缘；横向放不下就压列距')

	const view = 1600
	const box = { top: 0, height: 600, right: view, contentRight: 1100 }

	// ① 位置：就是贴着聊天区右缘，和树多宽无关。
	// ⚠️ 中间试过"在空当里居中"，John 试完说还是靠右。别再改回去 —— 居中会让树的横坐标
	//    随树宽浮动，眼睛每次得重新找一遍它在哪。
	const floor = Math.max(0, view - box.right) + Z.gap
	check(railRight(box, 70, view) === floor, `该贴着聊天区右缘（${floor}）`)
	check(railRight(box, 400, view) === railRight(box, 10, view), '位置不许随树宽变 —— 那正是居中的毛病')
	const inset = { top: 0, height: 600, right: 1200, contentRight: 1190 }
	check(railRight(inset, 70, view) === view - 1200 + Z.gap, '聊天区不占满视口时，该跟着聊天区右缘走')

	// ② 剩余空间怎么量：正文右缘到聊天区右缘，两头各让 Z.gap
	check(railRoom(box) === box.right - Z.gap - box.contentRight - Z.gap, 'room 该是正文右缘到聊天区右缘那条空当')
	// 量不到正文右缘时**不能当作"随便长"**：退回"到聊天区左缘为止"，至少挡住越界
	check(railRoom({ top: 0, height: 600, right: 900 }) === 900 - 2 * Z.gap, '量不到正文右缘时该退回到聊天区左缘为止')
	check(railRoom({ top: 0, height: 600, right: 10, contentRight: 500 }) === 0, 'room 不许是负数')

	// ③ 放得下就一点不压 —— 和不设限完全一样
	const roomy = railLayout(BOX, 100, 12, 3, (size) => size, 10000)
	const free = railLayout(BOX, 100, 12, 3, (size) => size)
	check(roomy.lane === free.lane && roomy.railWidth === free.railWidth, '空间够的时候不该压')
	check(railLayout(BOX, 100, 12, 3, (size) => size, undefined).railWidth === free.railWidth, '不传 room 该等于不设限')

	// ④ 放不下就压列距，压到正好塞进去
	const room = 110
	const tight = railLayout(BOX, 100, 12, 6, (size) => size, room)
	check(tight.railWidth <= room + 1e-9, `压完该塞得进 ${room}，实际 ${tight.railWidth.toFixed(1)}`)
	check(tight.lane < free.lane, `压完的列距该比原来窄（${tight.lane.toFixed(1)} vs ${free.lane}）`)
	check(railLayout(BOX, 100, 12, 6, (size) => size).railWidth > room,
		'改动前该是装不下的，否则这条用例抓不到 bug')
	// 压的量要**刚好够**，不许顺手压过头（压过头 = 白白把点挤在一起）
	check(tight.railWidth > room - 1, `压过头了：room ${room}，只用了 ${tight.railWidth.toFixed(1)}`)

	// ⑤ 宽图标把树撑开之后，同样要被 room 拉回来 —— 这才是 John 说的"越界/压到正文"
	const starW = shapeBox(STAR, free.dotSize)
	const wideTree = railLayout(BOX, 100, 12, 8, () => starW)
	check(wideTree.railWidth > 200, `前提：8 列带星星该长得很宽，实际 ${wideTree.railWidth.toFixed(0)}`)
	const held = railLayout(BOX, 100, 12, 8, () => starW, 200)
	check(held.railWidth <= 200 + 1e-9, `带星星的宽树也该被 room 拉回来，实际 ${held.railWidth.toFixed(1)}`)

	// ⑥ 压到底为止：再窄就是两个点叠在一起，压了也白压。
	//    这时候**宁可超出去** —— 一棵糊成一团的树比一棵探出去一截的树更没用。
	const crushed = railLayout(BOX, 100, 12, 20, (size) => size, 30)
	const bottom = Math.min(free.lane, Math.max(Z.rowMin, free.dotSize + 2))
	check(crushed.lane >= bottom - 1e-9,
		`列距不许压到点都分不开（下限 ${bottom.toFixed(0)}，实际 ${crushed.lane.toFixed(1)}）`)
	check(crushed.railWidth > 30, '压到底之后该老老实实超出去，而不是继续压')
	// 第 0 列不许压到点不中
	check(crushed.edge >= Z.hit - 1e-9, `第 0 列不许压到比命中区还窄，实际 ${crushed.edge.toFixed(1)}`)

	console.log(`  位置恒 ${floor}px；room ${railRoom(box)}px；6 列列距 ${free.lane}→${tight.lane.toFixed(1)}px 塞进 ${room}px`)
}

// ===== 第4步：用例 3 —— 正文右缘怎么量 =====
{
	console.log('用例 3：正文右缘取所有聊天行里最靠右的那条')

	const rows = (list) => ({ querySelectorAll: () => list.map((right) => ({ getBoundingClientRect: () => ({ right, width: right > 0 ? 800 : 0 }) })) })
	check(contentRightOf(rows([1100, 1100, 1100])) === 1100, '整齐的正文栏该给出栏右缘')
	check(contentRightOf(rows([1100, 1240, 1100])) === 1240, '有一行宽代码块溢出时该跟着让到 1240')
	check(contentRightOf(rows([])) === undefined, '一行都没有（空会话）该给 undefined，让调用方退回老位置')
	// 宽度为 0 的行（hidden / 还没布局）不算数，否则会把正文右缘拉到 0
	check(contentRightOf(rows([0, 0])) === undefined, '宽度为 0 的行该被跳过')

	console.log('  整齐 1100 / 溢出 1240 / 空会话 undefined / 零宽行跳过')
}

// ===== 第5步：用例 4 —— 被盖住的判定 =====
{
	console.log('用例 4：聊天被浮层整个盖住时，树该收起来')

	/** 造一个假 DOM 节点。`contains` 只认自己和登记过的子孙。 */
	const make = (name, kids) => {
		const node = {
			name,
			kids: kids || [],
			getBoundingClientRect: () => ({ left: 0, top: 0, width: 1000, height: 800 }),
			closest: () => null,
			contains: (other) => other === node || node.kids.includes(other),
		}
		return node
	}
	const inner = make('聊天里的一行')
	const chat = make('聊天区', [inner])
	const root = make('页面根', [chat])
	root.contains = (other) => other === root || other === chat || other === inner
	const sidebar = make('别人家的侧栏')

	check(isCovered(chat, () => inner) === false, '探针打到聊天自己身上 → 没被盖住')
	check(isCovered(chat, () => root) === false, '探针打到祖先（空白处）→ 没被盖住')
	check(isCovered(chat, () => sidebar) === true, '探针全打到别人家的浮层上 → 判定为被盖住')

	// ⚠️ 只盖住一部分不算。一个气泡提示、一个下拉菜单飘过去就闪掉整棵树是最气人的那种 bug。
	let shot = 0
	check(isCovered(chat, () => (shot++ === 0 ? sidebar : inner)) === false, '只有一个探针被挡住时不该判为被盖住')

	// 自己人不算遮挡：导轨压在探针上时不能把自己判成被盖住，否则会来回闪
	const mine = make('导轨')
	mine.closest = (sel) => (sel === `[${pure.RAIL_MARK}]` ? mine : null)
	check(isCovered(chat, () => mine) === false, '压在探针上的是导轨自己 → 不算遮挡')

	// 尺寸塌成 0（容器 hidden）也当作看不见
	const flat = make('塌了')
	flat.getBoundingClientRect = () => ({ left: 0, top: 0, width: 0, height: 0 })
	check(isCovered(flat, () => flat) === true, '容器尺寸为 0 时该判定为看不见')

	// 探针落到视口外（elementFromPoint 给 null）时这一枪不算数，不能因此判成被盖住
	check(isCovered(chat, () => null) === true, '四枪全落空时保守判定为被盖住')

	console.log('  自己/祖先→露着；别人家浮层→盖住；部分遮挡与导轨自身→不算')
}

// ===== 第6步：用例 5 —— 同一行的横段不许重复画 =====
{
	console.log('用例 5：一个父节点带好几个孩子时，横线一像素只画一次')

	// 造一个父节点（第 0 列）带三个孩子（第 1/2/3 列）的场面。
	// 走法是先横后竖，所以三条横段都贴在父节点那一行、右端都停在父节点边上，
	// 只是往左伸的长度不同 —— 一组同心嵌套的线段。
	const xOf = (column) => 100 - column * 17
	const parentY = 50
	const made = []
	for (const [column, active] of [[1, false], [2, false], [3, true]]) {
		for (const part of segments(xOf(0), xOf(column), parentY, parentY + 24, 6, 6)) {
			if (part.tag === 'hz') made.push(Object.assign({ key: `c${column}`, active }, part))
		}
	}
	check(made.length === 3, `前提：三个孩子该给出三条横段，实际 ${made.length}`)

	// 改动前的样子：靠父节点那一截被画了三遍
	const overlapAt = (list, x) => list.filter((run) => run.left <= x && x < run.left + run.width).length
	const near = xOf(0) - 8 // 紧挨着父节点的一个点，三条线都盖着这儿
	check(overlapAt(made, near) === 3, `前提：${near} 这个位置改动前该被画 3 遍，实际 ${overlapAt(made, near)}`)

	const kept = trimRuns(made)
	// 这才是症状本身：任何一个横坐标上都不许有第二层
	for (let x = xOf(3) - 2; x <= xOf(0) + 2; x += 0.5) {
		const layers = overlapAt(kept, x)
		if (layers > 1) { check(false, `x=${x.toFixed(1)} 处横线被画了 ${layers} 遍`); break }
	}
	check(overlapAt(kept, near) === 1, '紧挨父节点那一截，去重后该正好画一遍')

	// 覆盖范围一点都不能少：原来画到哪儿，现在还得画到哪儿
	const span = (list) => [Math.min(...list.map((r) => r.left)), Math.max(...list.map((r) => r.left + r.width))]
	const was = span(made)
	const now = span(kept)
	check(Math.abs(was[0] - now[0]) < 1e-9 && Math.abs(was[1] - now[1]) < 1e-9,
		`去重不许把线弄短：原来 [${was[0].toFixed(1)}, ${was[1].toFixed(1)}]，现在 [${now[0].toFixed(1)}, ${now[1].toFixed(1)}]`)
	// 中间也不许留缝
	let gaps = 0
	for (let x = now[0] + 0.25; x < now[1]; x += 0.25) if (overlapAt(kept, x) === 0) gaps += 1
	check(gaps === 0, `去重后线中间裂了 ${gaps} 个缝`)

	// 蓝的（当前路径）先占：靠父节点那一截必须归蓝线，和原来"蓝线压在最上面"看到的一样
	const owner = kept.find((run) => run.left <= near && near < run.left + run.width)
	check(owner !== undefined && owner.active === true, '靠父节点那一截该归蓝线（当前路径）')

	// 嵌套的那几条被完全盖住，一条都不该留下残渣
	check(kept.every((run) => run.width >= MIN_RUN), `去重不该吐出比 ${MIN_RUN}px 还窄的残段`)

	// 不同行之间互不干扰
	const twoRows = [
		{ key: 'a', active: false, tag: 'hz', left: 0, top: 10, width: 50, height: 1 },
		{ key: 'b', active: false, tag: 'hz', left: 0, top: 30, width: 50, height: 1 },
	]
	check(trimRuns(twoRows).length === 2, '不同 top 的横段不该互相裁掉')

	// 部分重叠（不是嵌套）：露出来的那截要留下
	const partial = [
		{ key: 'a', active: false, tag: 'hz', left: 0, top: 10, width: 30, height: 1 },
		{ key: 'b', active: false, tag: 'hz', left: 20, top: 10, width: 30, height: 1 },
	]
	const cut = trimRuns(partial)
	check(Math.abs(cut.reduce((sum, run) => sum + run.width, 0) - 50) < 1e-9,
		`部分重叠时总长该是并集 50，实际 ${cut.reduce((sum, run) => sum + run.width, 0)}`)

	console.log(`  三条嵌套横段 → 去重成 ${kept.length} 条，覆盖范围不变、无缝、靠父节点那截归蓝线`)
}

// ===== 第7步：用例 6 —— 详情卡贴着那个点放 =====
{
	console.log('用例 6：详情卡锚在那个点上，不锚在整条导轨的左缘')

	// 一棵有岔路的树：五个孩子 → maxColumn = 4
	const star = (size) => drawnWidth(STAR, size)
	const L = railLayout(BOX, 100, 12, 4, star, undefined)
	const hitW = Math.max(L.z.hit, L.lane)
	const right = (column) => cardAnchor(L.railWidth, L.xOf(column), hitW)
	const old = L.railWidth + 4   // 老写法：不管点在第几列，一律甩到整棵树左边

	// 1) 主干那列（第 0 列，最常悬停）必须**明显**比老写法近
	check(right(0) < old - L.lane * 3,
		`第 0 列该至少近三个列距，实际 right=${right(0).toFixed(1)}，老写法 ${old.toFixed(1)}`)

	// 2) 但最左那列不许被推得更远 —— 这一改只拉近，不推远
	check(right(4) <= old + L.z.hit,
		`最左列不该被推远，实际 right=${right(4).toFixed(1)}，老写法 ${old.toFixed(1)}`)

	// 3) 列号每大一，卡片正好往左挪一个列距
	for (let column = 1; column <= 4; column += 1) {
		const step = right(column) - right(column - 1)
		check(Math.abs(step - L.lane) < 1e-9,
			`第 ${column} 列该正好差一个列距 ${L.lane.toFixed(2)}，实际 ${step.toFixed(2)}`)
	}

	// 4) 卡片不许压到那个点**自己**的命中区上。压上了就是"浮层盖住自己的触发器"，
	//    鼠标还没走出去就先被自己的命中区吃掉。
	for (let column = 0; column <= 4; column += 1) {
		const gap = right(column) - (L.railWidth - L.xOf(column) + hitW / 2)
		check(Math.abs(gap - CARD_GAP) < 1e-9,
			`第 ${column} 列该离命中区外缘正好 ${CARD_GAP}px，实际 ${gap.toFixed(2)}`)
	}

	console.log(`  五个岔路（maxColumn=4）：第 0 列 right=${right(0).toFixed(1)}，老写法 ${old.toFixed(1)} → 近了 ${(old - right(0)).toFixed(1)}px；最左列 ${right(4).toFixed(1)}`)
}

// ===== 第8步：用例 7 —— 列距被压过之后，带框的字不许叠到隔壁列 =====
{
	console.log('用例 7：列距被压过之后，自定义字的框按压完的列距重截，相邻两列不叠')
	const { glyphSpanFor, shapeSpec, GLYPH_SPAN, GLYPH_BOX, GLYPH_PAD_X, spanOf } = pure

	// youli42 报的 issue #1：「内容2」和「1」相邻两列，宽框压在窄框上。
	// 场面：两个带字框的收藏点在相邻两列，横向只有 80px，列距被压到比框窄（但还没压到底）。
	const wide = (size) => drawnWidth(shapeSpec('char:内容2'), size)
	const free = railLayout(BOX, 100, 12, 1, wide)
	check(free.lane >= wide(free.dotSize) + Z.laneGap, '前提：没压的时候列距按框宽留')
	const tight = railLayout(BOX, 100, 12, 1, wide, 80)
	check(tight.lane < wide(tight.dotSize), `前提：压完的列距 ${tight.lane.toFixed(1)} 该比框 ${wide(tight.dotSize).toFixed(1)} 窄，否则这条用例抓不到 bug`)
	check(tight.lane >= GLYPH_BOX * tight.dotSize + tight.z.laneGap, '前提：还没压到比最小的框还窄（那是下面单独的一条）')

	// 老画法：框按全宽画 → 两列之间的空白是负的，就是"叠上了"
	const overlapWas = Math.abs(tight.xOf(0) - tight.xOf(1)) - wide(tight.dotSize)
	check(overlapWas < 0, `改动前该是叠上的（算出来 ${overlapWas.toFixed(1)}px），否则这条用例抓不到 bug`)

	// 新画法：按压完的列距给一个更小的 span，框跟着窄回去
	const span = glyphSpanFor(tight.lane, tight.z.laneGap, tight.dotSize)
	check(span < GLYPH_SPAN, `压过之后 span 该小于全宽 ${GLYPH_SPAN}，实际 ${span.toFixed(2)}`)
	const squeezed = shapeSpec('char:内容2', span)
	const boxW = drawnWidth(squeezed, tight.dotSize)
	check(boxW <= tight.lane - tight.z.laneGap + 1e-9, `压完框宽 ${boxW.toFixed(1)} 该 ≤ 列距 − 间隙 ${(tight.lane - tight.z.laneGap).toFixed(1)}`)
	const clear = Math.abs(tight.xOf(0) - tight.xOf(1)) - boxW
	check(clear >= tight.z.laneGap - 1e-9, `相邻两列的字框之间该留得下 ${tight.z.laneGap}px，实际 ${clear.toFixed(1)}px`)
	// 字要让路：先缩字号（到 GLYPH_MIN_SCALE 为止），还装不下才截断加省略号。
	// 这一档只是压窄了些，缩字号就够；原文一个字不动（它是存进设置里的值）
	const shrunk = pure.glyphFont(squeezed.glyph, tight.dotSize, squeezed.span) < pure.glyphFont('内容2', tight.dotSize) - 1e-9
	check(squeezed.glyph.endsWith('…') || shrunk, `压过之后字该缩小或截断，实际画的是「${squeezed.glyph}」、字号没变`)
	check(squeezed.value === 'char:内容2', '截断只许发生在画出来的字上，存的值不能变')
	check(squeezed.span === span, '截过的 spec 要记着自己是按哪个 span 造的（字号按它算）')

	// 再压狠一点（横向只剩 70px）：缩到字号下限还装不下，就截断加省略号
	const tighter = railLayout(BOX, 100, 12, 1, wide, 70)
	const spanT = glyphSpanFor(tighter.lane, tighter.z.laneGap, tighter.dotSize)
	const clipped = shapeSpec('char:内容2', spanT)
	check(clipped.glyph.endsWith('…') && clipped.glyph !== '内容2', `压得更狠时该截断加省略号，实际画的是「${clipped.glyph}」`)
	check(drawnWidth(clipped, tighter.dotSize) <= tighter.lane - tighter.z.laneGap + 1e-9, '截断之后框宽也该 ≤ 列距 − 间隙')
	check(pure.glyphFont(clipped.glyph, tighter.dotSize, spanT) >= pure.GLYPH_MIN_SCALE * tighter.dotSize - 1e-9, '截断之后字号不该低于下限（截断就是为了不再缩）')

	// 没压的时候一个像素都不许变：列距本来就按这个框留的，算出来的 span 装得下全部字，
	// spec 和不给 span 时一模一样（span 数值本身可以小于 GLYPH_SPAN —— 字只有 2.6 em 宽）
	const roomy = glyphSpanFor(free.lane, free.z.laneGap, free.dotSize)
	check(roomy >= pure.glyphEm('内容2') - 1e-9, `没压时 span ${roomy.toFixed(2)} 该装得下 ${pure.glyphEm('内容2')} em 的字`)
	const same = shapeSpec('char:内容2', roomy)
	check(same.glyph === '内容2' && same.grow === shapeSpec('char:内容2').grow, '没压时画法必须和原来逐像素相同')
	// 三个字以上（本来就要缩字号的）同理：列距按它留过，压不压都一样
	const long = 'char:甲乙丙丁'
	const laid = railLayout(BOX, 100, 12, 1, (size) => drawnWidth(shapeSpec(long), size))
	const longSpan = glyphSpanFor(laid.lane, laid.z.laneGap, laid.dotSize)
	check(longSpan === GLYPH_SPAN, `本来就顶到全宽的字，没压时 span 该是 ${GLYPH_SPAN}，实际 ${longSpan}`)
	check(shapeSpec(long, longSpan).glyph === shapeSpec(long).glyph, '顶到全宽的字没压时画法不变')

	// 压到底：截字这一招到此为止 —— 框最窄也就是一个正方块（GLYPH_BOX）
	const floor = glyphSpanFor(1, 0, 11)
	check(Math.abs(floor - (GLYPH_BOX - 2 * GLYPH_PAD_X)) < 1e-9, `压到底的 span 该是 ${(GLYPH_BOX - 2 * GLYPH_PAD_X).toFixed(2)}，实际 ${floor.toFixed(2)}`)
	check(Math.abs(shapeSpec('char:内容2', floor).grow - GLYPH_BOX) < 1e-9, '压到底时框该缩成一个正方块')

	// 再往下（列距压到"两个圆点刚分得开"，比正方块和星星都窄）：整个形状等比缩小，
	// 最小缩到一个圆点那么大 —— 和圆点一样只剩两像素缝，但不叠。John 试出来的极端情形。
	const { shrinkToLane } = pure
	const crushed = railLayout(BOX, 100, 12, 20, () => drawnWidth(STAR, 11), 30)
	check(crushed.lane < GLYPH_BOX * crushed.dotSize && crushed.lane < drawnWidth(STAR, crushed.dotSize), '前提：列距压到比正方块和星星都窄')
	for (const [name, spec] of [['字框', shapeSpec('char:内容2', floor)], ['星星', STAR], ['菱形', SHAPES.find((item) => item.spin === true)]]) {
		const wide = drawnWidth(spec, crushed.dotSize)
		const fit = shrinkToLane(wide, crushed.lane, crushed.z.laneGap, crushed.dotSize)
		check(fit < 1, `${name} 该被缩小，实际倍数 ${fit}`)
		const shown = wide * fit
		check(shown <= Math.max(crushed.dotSize, crushed.lane - crushed.z.laneGap) + 1e-9, `${name} 缩完 ${shown.toFixed(1)}px 还是塞不进列距`)
		check(shown >= crushed.dotSize - 1e-9, `${name} 缩得比圆点还小（${shown.toFixed(1)}px），认不出来了`)
		const between = Math.abs(crushed.xOf(0) - crushed.xOf(1)) - shown
		check(between >= 2 - 1e-9, `${name} 相邻两列之间该像圆点一样至少留 2px，实际 ${between.toFixed(1)}px`)
	}
	// 没压的时候恒为 1：列距本来就按最宽的形状留过
	const starry = railLayout(BOX, 100, 12, 2, (size) => drawnWidth(STAR, size))
	check(shrinkToLane(drawnWidth(STAR, starry.dotSize), starry.lane, starry.z.laneGap, starry.dotSize) === 1, '没压时星星不许被缩')
	check(shrinkToLane(drawnWidth(shapeSpec('char:内容2'), free.dotSize), free.lane, free.z.laneGap, free.dotSize) === 1, '没压时字框不许被缩')
	check(shrinkToLane(0, 13, 5, 11) === 1 && shrinkToLane(20, NaN, 5, 11) === 1, '乱给的参数该退回 1，不许画出 0 大小的点')
	// 乱给的 span 不许把画法搞坏
	check(spanOf(undefined) === GLYPH_SPAN && spanOf(NaN) === GLYPH_SPAN && spanOf(99) === GLYPH_SPAN, '不合法 / 超大的 span 都该夹回全宽')

	console.log(`  列距 ${free.lane.toFixed(1)} → 压到 ${tight.lane.toFixed(1)}：框 ${wide(tight.dotSize).toFixed(1)}px → ${boxW.toFixed(1)}px，画成「${squeezed.glyph}」，两列之间留 ${clear.toFixed(1)}px`)
}

// ===== 第9步：用例 8 —— 容器里挂的是别的页签（Trajectory）时，树该收起来 =====
{
	console.log('用例 8：滚动容器常驻，里面换成 Trajectory 页签时树收起；空白欢迎页和切会话的空档不算')
	const { otherViewShown } = pure
	// 假 DOM：只给 otherViewShown 用到的三样 —— children / hasAttribute / querySelector（按 [data-xxx] 找子孙）
	const make = (name, attrs, kids) => {
		const node = { name, attrs: attrs || [], children: kids || [] }
		node.hasAttribute = (attr) => node.attrs.includes(attr)
		const walk = (n, want) => (n.attrs.includes(want) ? n : n.children.map((k) => walk(k, want)).find(Boolean))
		node.querySelector = (sel) => node.children.map((k) => walk(k, sel.slice(1, -1))).find(Boolean) || null
		return node
	}
	const composer = () => make('输入框', ['data-composer-seat'])
	const chatFlow = () => make('聊天', [], [make('正文栏', ['data-chat-flow'], [make('一行', ['data-chat-turn'])])])

	const chat = make('滚动容器', [], [make('页签区', [], [chatFlow()]), composer()])
	check(otherViewShown(chat) === false, '挂着聊天页签 → 露着')
	const empty = make('滚动容器', [], [make('页签区', [], [make('聊天', [], [make('正文栏', ['data-chat-flow'])])]), composer()])
	check(otherViewShown(empty) === false, '聊天页签一轮都没有（只有正文栏）→ 也算聊天在，露着')

	const traj = make('滚动容器', [], [make('页签区', [], [make('Trajectory', ['data-trajectory-scroll'])]), composer()])
	check(otherViewShown(traj) === true, '挂着 Trajectory 页签 → 收起')
	const future = make('滚动容器', [], [make('页签区', [], [make('以后再加的什么页签', [])]), composer()])
	check(otherViewShown(future) === true, '挂着不认识的页签 → 同样收起（判法不认具体页签）')

	// ⚠️ 只剩输入框不算别的页签：空白会话的欢迎页、切会话时聊天子树刚卸掉的那几帧，树都该照常在
	check(otherViewShown(make('滚动容器', [], [composer()])) === false, '只剩输入框（欢迎页 / 切会话空档）→ 不算别的页签')
	check(otherViewShown(make('滚动容器', [], [])) === false, '容器空着 → 不算别的页签')
	// 输入框和页签区谁先谁后无所谓
	check(otherViewShown(make('滚动容器', [], [composer(), make('页签区', [], [make('Trajectory', [])])])) === true, '输入框排前面也认得出别的页签')
	check(otherViewShown(make('滚动容器', [], [composer(), make('页签区', [], [chatFlow()])])) === false, '输入框排前面也认得出聊天')

	console.log('  聊天在→露着；Trajectory / 不认识的页签→收起；只剩输入框→不动')
}

// ===== 第10步：用例 9 —— 字框按"这一行"的空位摊开，不按列距一刀切（T2） =====
{
	console.log('用例 9：自定义字向同一行的空位借地方；邻居之间公平分，不叠、不越过圆点')
	const { rowSlots, boxShift, shapeSpec, GLYPH_BOX, GLYPH_RADIUS, glyphSpanFor } = pure

	// 场面：三列（maxColumn = 2），横向放不下、列距被压过 —— John 报"只剩 …"时就是这个样子。
	const want = (size) => drawnWidth(shapeSpec('char:甲乙丙'), size)
	const L = railLayout(BOX, 100, 12, 2, want, 100)
	const size = L.dotSize
	const g = L.z.laneGap
	const full = want(size)
	check(L.railWidth < 3 * (full + g), '前提：三列装不下三个全宽的字框，否则这条用例抓不到 bug')
	check(drawnWidth(shapeSpec('char:甲乙丙', glyphSpanFor(L.lane, g, size)), size) < full - 1e-9, '前提：老规则按压完的列距截，字框画不全')
	// 字框：中心附近至少盖住一个圆角那么宽（线从框的平边进出，不戳在圆角上）
	const glyphCore = GLYPH_BOX * size * GLYPH_RADIUS + 1
	const glyph = (column) => ({ x: L.xOf(column), coreL: glyphCore, coreR: glyphCore, want: full })
	const dot = (column) => ({ x: L.xOf(column), coreL: size / 2, coreR: size / 2, want: size })
	const box = (item, slot, w) => {
		const shift = boxShift(w, slot.left, slot.right)
		return [item.x + shift - w / 2, item.x + shift + w / 2]
	}

	// ① 一行里只有第 0 列有字，第 1、2 列空着 → 能摊到的宽度 ≥ 3 个列距减间隙
	{
		const [slot] = rowSlots([glyph(0)], 0, L.railWidth, g)
		check(slot.left + slot.right >= 3 * L.lane - g - 1e-9, `独占一行的字框只摊到 ${(slot.left + slot.right).toFixed(1)}px，该 ≥ ${(3 * L.lane - g).toFixed(1)}`)
		const w = Math.min(full, slot.left + slot.right)
		check(w >= full - 1e-9, `独占一行时该画全（${w.toFixed(1)} / ${full.toFixed(1)}）`)
		const [a, b] = box(glyph(0), slot, w)
		check(a >= -1e-9 && b <= L.railWidth + 1e-9, `框 [${a.toFixed(1)}, ${b.toFixed(1)}] 不许出导轨 [0, ${L.railWidth.toFixed(1)}]`)
		check(a + glyphCore <= L.xOf(0) + 1e-9 && L.xOf(0) <= b - glyphCore + 1e-9, '第 0 列贴着右缘：框往左借，但还得盖住自己那一列')
	}

	// ② 第 0 列和第 1 列都有字 → 两个框互不重叠、各自盖住自己那一列；空间不够时两边公平分
	{
		const items = [glyph(0), glyph(1)]
		const slots = rowSlots(items, 0, L.railWidth, g)
		const boxes = items.map((item, at) => box(item, slots[at], Math.min(full, slots[at].left + slots[at].right)))
		const [r0, r1] = boxes
		check(r1[1] + g <= r0[0] + 1e-9, `相邻两个字框之间该留 ${g}px，实际 ${(r0[0] - r1[1]).toFixed(1)}px`)
		boxes.forEach((r, at) => check(r[0] + glyphCore <= items[at].x + 1e-9 && items[at].x <= r[1] - glyphCore + 1e-9, `第 ${at} 列的框没盖住自己那一列`))
		const w0 = r0[1] - r0[0]
		const w1 = r1[1] - r1[0]
		check(w0 + w1 > 2 * (L.lane - g) + 1e-9, `两个框加起来 ${(w0 + w1).toFixed(1)}px，不比老规则（各一个列距减间隙）宽，等于没借到`)
	}

	// ③ 第 0 列有字、第 2 列是普通圆点 → 字框可以越过第 1 列，但要在圆点前停住
	{
		const items = [glyph(0), dot(2)]
		const slots = rowSlots(items, 0, L.railWidth, g)
		const [a, b] = box(items[0], slots[0], Math.min(full, slots[0].left + slots[0].right))
		// 地盘越过第 1 列就算"能越过"；框本身装得下就照样居中，不会无故挪过去
		check(items[0].x - slots[0].left < L.xOf(1), `字框的地盘该越过第 1 列（地盘左缘 ${(items[0].x - slots[0].left).toFixed(1)}，第 1 列 ${L.xOf(1).toFixed(1)}）`)
		check(a >= L.xOf(2) + size / 2 + g - 1e-9, `字框该在第 2 列的圆点前停住（框左缘 ${a.toFixed(1)}，圆点右缘 + 间隙 ${(L.xOf(2) + size / 2 + g).toFixed(1)}）`)
		check(b <= L.railWidth + 1e-9, '也不许从导轨右缘探出去')
		check(slots[1].left >= size / 2 - 1e-9 && slots[1].right >= size / 2 - 1e-9, '圆点自己那一块不许被借走')
	}

	// ④ 三列全是字（John 的原场面）：三个框不叠，**中间那个不许被两头挤成「…」** ——
	//    两头靠导轨边上那点空，中间夹着的那个也得分到差不多的一份
	{
		const items = [glyph(0), glyph(1), glyph(2)]
		const slots = rowSlots(items, 0, L.railWidth, g)
		const widths = slots.map((slot) => Math.min(full, slot.left + slot.right))
		const boxes = items.map((item, at) => box(item, slots[at], widths[at]))
		for (let at = 0; at + 1 < boxes.length; at += 1) {
			check(boxes[at + 1][1] + g <= boxes[at][0] + 1e-9, `第 ${at + 1}、${at} 列的框叠上了`)
		}
		const narrow = Math.min(...widths)
		check(narrow >= (L.railWidth - 2 * g) / 3 - 2 * glyphCore, `最窄的框只有 ${narrow.toFixed(1)}px，三家分 ${L.railWidth.toFixed(1)}px 该接近 ${((L.railWidth - 2 * g) / 3).toFixed(1)}`)
		check(narrow > L.lane - g + 1e-9, `中间那个框 ${narrow.toFixed(1)}px，不比老规则的 ${(L.lane - g).toFixed(1)}px 宽`)
		console.log(`  三列都有字：列距 ${L.lane.toFixed(1)}px，老规则每个框 ${(L.lane - g).toFixed(1)}px → 现在 ${widths.map((w) => w.toFixed(1)).join(' / ')}px`)
	}

	// ⑤ 空间够的时候一个像素都不动：框就居中画在自己那一列
	{
		const roomy = railLayout(BOX, 100, 12, 2, want)
		const items = [0, 1, 2].map((column) => ({ x: roomy.xOf(column), coreL: glyphCore, coreR: glyphCore, want: full }))
		const slots = rowSlots(items, 0, roomy.railWidth, g)
		slots.forEach((slot, at) => {
			check(slot.left + slot.right >= full - 1e-9, `空间够时第 ${at} 列该画全`)
			check(boxShift(full, slot.left, slot.right) === 0, `空间够时第 ${at} 列不该挪位置`)
		})
	}

	// ⑥ 导轨左边还有空（树没占满 railRoom）：最左那列可以往导轨外面借，但不许借进正文
	{
		const [slot] = rowSlots([{ x: 10, coreL: glyphCore, coreR: glyphCore, want: full }], -30, 40, g)
		check(slot.left === 40 && slot.right === 30, `往左可借到 -30，实际 left=${slot.left}`)
	}

	// ⑦ 别人的岔路拐角也算占位（核心可以不对称）：自己的拐角被核心盖住，邻居借不过去
	{
		const items = [{ x: 50, coreL: 30, coreR: 5, want: 10 }, { x: 0, coreL: 5, coreR: 5, want: 200 }]
		const slots = rowSlots(items, -100, 100, 4)
		check(slots[1].right <= 50 - 30 - 4 + 1e-9, `邻居的框越过了别人的拐角（right=${slots[1].right.toFixed(1)}）`)
	}

	// ⑧ 连线：父节点是个往左摊开的字框时，横段从框边起；框一直盖到孩子那一列，横段就整个不画
	{
		const out = segments(100, 60, 50, 74, 9, 6, 15)
		const hz = out.find((part) => part.tag === 'hz')
		check(hz !== undefined && Math.abs(hz.left + hz.width - 0.5 - (100 - 15)) < 1e-9, '横段该从框的左缘起，不是从半个框高起')
		const covered = segments(100, 60, 50, 74, 9, 6, 45)
		check(covered.every((part) => part.tag !== 'hz'), '框盖住了孩子那一列：不该再画横段（会从字中间穿过去）')
		const down = covered.find((part) => part.tag === 'v')
		check(down !== undefined && Math.abs(down.top - (50 + 9)) < 1e-9, '框盖住孩子那列时，竖段从框的下沿起')
		check(JSON.stringify(segments(100, 60, 50, 74, 9, 6)) === JSON.stringify(segments(100, 60, 50, 74, 9, 6, undefined)), '不给第 7 个参数时和老画法一样')
	}
}

// ===== 给树留的带子：宽度怎么夹 =====
console.log('用例 带子：设置多少给多少，但不超过聊天区一半、不超过 BAND.max、认不得就默认')
{
	const { bandWidth, BAND } = pure
	check(bandWidth(240, 1200) === 240, '设置 240、聊天区 1200 → 240')
	check(bandWidth(600, 900) === 450, `设置 600、聊天区 900 → 夹到一半 450，实际 ${bandWidth(600, 900)}`)
	check(bandWidth(9999, 4000) === BAND.max, `再大也不超过 BAND.max=${BAND.max}`)
	check(bandWidth(-5, 1200) === 0, '负数夹到 0')
	check(bandWidth('x', 1200) === BAND.fallback, '认不得的值退回默认')
	check(bandWidth(300) === 300, '不知道聊天区宽度时只按 BAND.max 夹')
	check(pure.BANDS.includes(BAND.fallback) && pure.BANDS[0] === 0, '默认档在档位表里，第一档是 0（不占位）')
	check(pure.bandText(0) === '不占位' && pure.bandText(240) === '240px', '读数')
}

report()
