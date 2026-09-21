/**
 * dsh-tree —— 版式：列距、横向落位、连线去重、跟别的插件共处。
 *
 * 【导读】
 * 干嘛的：钉住这三件肉眼才看得见、代码里却最容易悄悄退化的事。
 *   · 列距要按**画出来最宽的那个形状**留，不是按点的直径留（收藏成星星就会贴脸）
 *   · 树贴着聊天区右缘钉死；横向放不下就压列距，别压到正文上或者从屏幕左边出去
 *   · 聊天被别的插件的浮层整个盖住时，树得跟着收起来
 *   · 同一行上的横段一像素只许画一次（不然一个父节点带几个孩子，横线就忽粗忽细）
 *   · 详情卡锚在**那个点**上，岔路多了也不许被甩到整棵树的左边去
 *
 * 阅读顺序：
 *   第1步  取 client 的真函数
 *   第2步  用例 1：列距跟着最宽的形状走
 *   第3步  用例 2：靠右钉死 + 放不下就压列距
 *   第4步  用例 3：正文右缘怎么量
 *   第5步  用例 4：被盖住的判定
 *   第6步  用例 5：同一行的横段不许重复画
 *   第7步  用例 6：详情卡贴着那个点放，不贴整棵树的左缘
 *
 * 跑法：node test-layout.mjs
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

report()
