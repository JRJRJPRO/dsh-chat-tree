/**
 * 全局常量：设置命名空间、滑杆档位、基准尺寸、配色。
 *
 * 这些东西**不属于任何一个功能**，谁都要用，所以单独一份。
 * 改 `Z` 之前先看它自己的注释（那张表是 1.2 倍老基准取整出来的）。
 */

/** 设置命名空间。host 半用同名 namespace 注册 schema，两边必须一致。 */
export const SETTINGS_NS = 'dsh-tree'

/** 省略半径。0 = 不省略；滑杆位置就是 [5..30, 0]。 */
export const RADIUS = { min: 5, max: 30, fallback: 12, off: 0 }

/** 节点缩放，百分比。 */
export const SCALE = { min: 50, max: 250, step: 10, fallback: 100 }

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
export const Z = { row: 24, rowMin: 8, dot: 11, dotMin: 7, dotPad: 6, lane: 17, hit: 22, laneGap: 5, pad: 16, card: 270, gap: 20, restMs: 140, graceMs: 600, rewindMs: 2000 }

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
export function scaleZ(percent) {
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
export const C = {
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
