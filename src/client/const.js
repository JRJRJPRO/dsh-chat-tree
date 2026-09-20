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

// hit = 命中区宽度，同时也是导轨右侧留给第 0 列的宽度（圆心在 hit/2 处）。
// 以前 18 和 9 是散在渲染里的魔数，收进来才能跟着缩放一起动。
/**
 * 基准尺寸。滑杆上的 100% 指的就是这张表。
 *
 * 前八项（`scaleZ` 会缩的那些）是**老基准的 1.2 倍再取整** —— 原来要调到 120%
 * 才顺眼，那就把 120% 挪成默认的 100%。取整是为了 1px 描边落在整像素上不发虚，
 * 代价是各项相对老基准差 ±2% 以内。
 * 老基准：row 20 / rowMin 7 / dot 9 / dotMin 6 / dotPad 5 / lane 14 / hit 18
 */
export const Z = { row: 24, rowMin: 8, dot: 11, dotMin: 7, dotPad: 6, lane: 17, hit: 22, pad: 16, card: 270, gap: 20, restMs: 140, graceMs: 600, rewindMs: 2000 }

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
	for (const key of ['row', 'rowMin', 'dot', 'dotMin', 'dotPad', 'lane', 'hit']) out[key] = Z[key] * k
	return out
}

export const C = {
	line: '#30363d', lineActive: 'rgba(88,166,255,.6)',
	dim: '#6e7681', dimActive: 'rgba(88,166,255,.9)',
	muted: '#8b949e', text: '#c9d1d9',
	blue: '#58a6ff', orange: '#ffa657', bg: '#161b22',
}
