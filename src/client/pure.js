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
	drawnWidth,
	shapeHeight,
	glyphGrow,
	glyphFont,
	GLYPH_MAX,
	GLYPH_SPAN,
	STAR,
	STAR_COLOR,
	BACKDROP,
	CONTRAST_MIN,
	STAR_EDGE,
	starInkOf,
	relLuminance,
	contrastRatio,
	hexToHsl,
	hslToHex,
	fitContrast,
	crossPoly,
	favShape,
	growOf,
	polyArea,
	regularPoly,
	starPoly,
	starSkin,
} from './shapes.js'
import { MIN_RUN, edgeOrder, hoverNext, nodeAt, railLayout, railRight, railRoom, reachFor, segments, trimRuns } from './geometry.js'
import { RAIL_MARK, STAR_ANIM, STAR_ANIM_MS, contentRightOf, isCovered, isRewindPending, rewindRetryDelay, starAnimation, watchViewport } from './hooks.js'
import { isColor, nextFavColors, nextFavIcons, nextFavorites, readFavColors, readFavIcons, readFavorites, readLabels, writeFavColor, writeFavIcon, writeFavorite, writeLabel } from './labels.js'
import { CARD_MARK, FAV_COLORS, FAV_DROP, FAV_SHAPES, GAP, LEAVE_MS, PICK, clampGlyph, isComposingKey, isDirty, keepsCard, shouldRefocus } from './ui-detail.js'
import { FIELDS, ROWS, SCALES, STEPS, isHex, scaleText, settingsStore, stepText, themeFrom } from './settings-model.js'
import { isDark } from './theme.js'
import { NO_ZOOM, TAPPABLE, hasHover, overRail, tapNext } from './pointer.js'

export const __pure = {
	// 选树、归组、节点上能做什么
	visibleTree, conversationOf, treeOf, treeOfSession, indexOf, keyOf, ROOT_KEY, shapeOps,
	cutPointOf, cutSet, branchAction, forkBlockedWhy, isBranchHead, mergeTargets, blockedWhy, jumpTarget, isFocusedNode, workspaceOf,
	// 图
	buildGraph, elide, fisheye, FADE, anchorNode,
	// 画
	dotStyle, inkOf, fade, shapeSpec, shapeOf, shapeBox, drawnWidth, shapeHeight, polyPoints, polyProps, roleOf, dashedOf, dotSizeOf,
	// 形状怎么算出来的：面积、按面积配齐的放大倍数、正 n 边形、十字
	polyArea, growOf, regularPoly, crossPoly,
	SHAPES, THEME, ROLES, CUSTOM, PICTURE, ICON_EDGE,
	// 自定义字：上限、占几倍宽、该用多大字号
	GLYPH_MAX, GLYPH_SPAN, glyphGrow, glyphFont,
	// 收藏：五角星的形状、配色、以及点下去那一下的动画
	STAR, STAR_COLOR, starPoly, starSkin, starAnimation, STAR_ANIM, STAR_ANIM_MS, favShape,
	// 一个色值，按底色自己调明度 —— 明暗两边不再各写一版
	BACKDROP, CONTRAST_MIN, STAR_EDGE, starInkOf, relLuminance, contrastRatio, hexToHsl, hslToHex, fitContrast,
	// 节点上的用户标注（改名 / 收藏）
	readLabels, writeLabel, readFavorites, writeFavorite, nextFavorites,
	readFavIcons, writeFavIcon, nextFavIcons,
	readFavColors, writeFavColor, nextFavColors, isColor,
	// 详情卡里能离线测的那两件事：改没改过、这一下是不是输入法在拼字
	isDirty, isComposingKey, keepsCard, clampGlyph,
	// 焦点被宿主抢走时抢不抢回来
	shouldRefocus, LEAVE_MS, CARD_MARK, FAV_COLORS, FAV_SHAPES, FAV_DROP, PICK, GAP,
	// 配色与明暗
	PALETTE, paletteOf, themeFrom, isDark, isHex,
	// 几何
	reachFor, segments, edgeOrder, nodeAt, hoverNext, railLayout, railRight, railRoom, trimRuns, MIN_RUN,
	// 版式上的共处：正文栏右缘在哪、聊天是不是被别的插件盖住了
	contentRightOf, isCovered, RAIL_MARK,
	// 指针：能不能悬停、手指戳一下算什么、WebKit 上必须补的那几条样式
	tapNext, hasHover, overRail, watchViewport, TAPPABLE, NO_ZOOM,
	// 撤回的重拉节奏
	isRewindPending, rewindRetryDelay,
	// 设置
	settingsStore, stepText, scaleText, scaleZ, STEPS, SCALES, RADIUS, SCALE, FIELDS, ROWS, Z,
}
