/**
 * 离线测试的出口。
 *
 * 浏览器半是个 `__ModuleLoader__` bundle，node 里没法直接 import，所以测试是这么干的：
 * 塞一个假的 loader 和假的 react 骗 factory 跑完，再从 `exports.__pure` 把函数拿出来
 * （见 test-kit.mjs）—— **测的是真代码，不是复制品**。
 *
 * 【加了新纯函数怎么办】往这张表里加一行。不加也能跑，只是测不到；
 * 而测不到的代码，改坏了没有任何一条断言会响。
 *
 * 【什么东西不该进这张表】碰 DOM / react / fetch 的。那些在 node 里跑不起来，
 * 要测就得先把"算"从"画"里拆出来 —— 拆出来的那半才进这里。
 */
import { RADIUS, SCALE, Z, scaleZ } from './const.js'
import {
	branchAction,
	blockedWhy,
	conversationOf,
	cutPointOf,
	cutSet,
	forkBlockedWhy,
	isBranchHead,
	indexOf,
	isFocusedNode,
	jumpTarget,
	keyOf,
	mergeTargets,
	shapeOps,
	treeOf,
	treeOfSession,
	visibleTree,
	workspaceOf,
	ROOT_KEY,
} from './tree.js'
import { buildGraph } from './graph.js'
import { FADE, anchorNode, elide, fisheye } from './elide.js'
import {
	CUSTOM,
	ICON_EDGE,
	PICTURE,
	PALETTE,
	ROLES,
	paletteOf,
	SHAPES,
	THEME,
	dashedOf,
	dotSizeOf,
	dotStyle,
	fade,
	inkOf,
	polyPoints,
	polyProps,
	roleOf,
	shapeBox,
	shapeOf,
	shapeSpec,
} from './shapes.js'
import { edgeOrder, hoverNext, nodeAt, railLayout, reachFor, segments } from './geometry.js'
import { isRewindPending, rewindRetryDelay } from './hooks.js'
import { FIELDS, ROWS, SCALES, STEPS, isHex, scaleText, settingsStore, stepText, themeFrom } from './settings-model.js'
import { isDark } from './theme.js'

export const __pure = {
	// 选树、归组、节点上能做什么
	visibleTree, conversationOf, treeOf, treeOfSession, indexOf, keyOf, ROOT_KEY, shapeOps,
	cutPointOf, cutSet, branchAction, forkBlockedWhy, isBranchHead, mergeTargets, blockedWhy, jumpTarget, isFocusedNode, workspaceOf,
	// 图
	buildGraph, elide, fisheye, FADE, anchorNode,
	// 画
	dotStyle, inkOf, fade, shapeSpec, shapeOf, shapeBox, polyPoints, polyProps, roleOf, dashedOf, dotSizeOf,
	SHAPES, THEME, ROLES, CUSTOM, PICTURE, ICON_EDGE,
	// 配色与明暗
	PALETTE, paletteOf, themeFrom, isDark, isHex,
	// 几何
	reachFor, segments, edgeOrder, nodeAt, hoverNext, railLayout,
	// 撤回的重拉节奏
	isRewindPending, rewindRetryDelay,
	// 设置
	settingsStore, stepText, scaleText, scaleZ, STEPS, SCALES, RADIUS, SCALE, FIELDS, ROWS, Z,
}
