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
 * 【组件也在这张表里】Detail / SettingsCard / Rail 这些画界面的也挂出去了 —— 测试用
 * tests/kit/react-lite.mjs 那份极简 react 把它们真的挂起来、派事件、看结果
 * （test-kit.mjs 的 `mount`）。所以"碰 react"不再是进不了这张表的理由；
 * 真进不来的只剩直接 fetch 的那几处（net.js 会在 node 里没有 fetch 时抛）。
 */
import { C, DEPTH, RADIUS, SCALE, SETTINGS_NS, Z, scaleZ } from './const.js'
import {
	branchAction,
	blockedWhy,
	conversationOf,
	currentOf,
	cutPointOf,
	deletePlan,
	deleteBlockedWhy,
	escapeFrom,
	cutSet,
	forkBlockedWhy,
	forkCutSeq,
	isBranchHead,
	indexOf,
	isFocusedNode,
	isRootKey,
	jumpTarget,
	keyOf,
	mergeTargets,
	shapeOps,
	treeOf,
	treeOfSession,
	visibleTree,
	withStatus,
	workspaceOf,
	ROOT_KEY,
	rootKeyOf,
} from './tree.js'
import { buildGraph } from './graph.js'
import { OPEN_KEY, foldHeads, foldRows, nextOpen, readOpenTrees, writeOpenTrees } from './fold.js'
import { FOLD_ATTR, FOLD_BUTTON, applyFold, clearFold, foldReport, sessionIdOf, unitOf } from './sidebar.js'
import { FADE, anchorNode, elide, fisheye, layersAway, stepsAway } from './elide.js'
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
	paint,
	FILL_ALPHA,
	readable,
	onAccent,
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
	GLYPH_PAD_X,
	GLYPH_PAD_Y,
	GLYPH_BOX,
	GLYPH_RADIUS,
	emWidth,
	glyphEm,
	glyphBoxStyle,
	GLYPH_STORE_MAX,
	GLYPH_MIN_SCALE,
	GLYPH_FIT_EM,
	glyphFit,
	glyphSpanFor,
	spanOf,
	RARE_SHAPES,
	PICK_SHAPES,
	GLYPH_SPAN,
	STAR,
	STAR_COLOR,
	BACKDROP,
	CONTRAST_MIN,
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
import { CARD_GAP, MIN_RUN, boxShift, cardAnchor, edgeOrder, hoverNext, nodeAt, railLayout, railRight, railRoom, reachFor, rowSlots, segments, shrinkToLane, trimRuns } from './geometry.js'
import { PIN_SETTLE_MS, PIN_SLACK, RAIL_MARK, READ_ANIM, READ_FADE_MS, READ_HOLD_MS, READ_MELT_MS, STAR_ANIM, STAR_ANIM_MS, contentRightOf, isCovered, isRewindPending, listStamp, otherViewShown, nextReadBoundary, nudgePin, pickActiveTurn, pinActiveTurn, pinnedTurn, readAnimation, readPhase, rewindRetryDelay, runningCount, settleDelay, settlePin, starAnimation, tagOutlines, unpinActiveTurn, watchViewport } from './hooks.js'
import { isColor, nextFavColors, nextFavIcons, nextFavorites, readFavColors, readFavIcons, readFavorites, readLabels, writeFavColor, writeFavIcon, writeFavorite, writeLabel } from './labels.js'
import { CARD_MARK, Detail, FAV_COLORS, FAV_DROP, FAV_SHAPES, FavIconRow, GAP, HexField, LEAVE_MS, MergeList, NameField, PICK, clampGlyph, favSwatch, isComposingKey, isDirty, keepsCard, shouldRefocus } from './ui-detail.js'
import { SettingsCard } from './ui-settings.js'
import { Rail } from './rail.js'
import { FIELDS, LAYERS, ROWS, SCALES, STEPS, VISIBLE, hexOf, isHex, isMode, layerText, scaleText, settingsStore, stepText, themeFrom, visibleRange } from './settings-model.js'
import { isDark } from './theme.js'
import { NO_ZOOM, TAPPABLE, hasHover, overRail, tapNext } from './pointer.js'

export const __pure = {
	// 选树、归组、节点上能做什么
	visibleTree, conversationOf, treeOf, treeOfSession, indexOf, keyOf, ROOT_KEY, rootKeyOf, isRootKey, shapeOps,
	// 两代宿主的会话列表差异：当前会话在哪、跑完未读在哪
	currentOf, withStatus,
	cutPointOf, cutSet, branchAction, forkBlockedWhy, forkCutSeq, isBranchHead, mergeTargets, blockedWhy, jumpTarget, isFocusedNode, workspaceOf,
	// 删除 = 归档整条支线：删哪些、为什么删不了、删之前先切到哪
	deletePlan, deleteBlockedWhy, escapeFrom,
	// 图
	buildGraph, elide, fisheye, FADE, anchorNode,
	// 左侧会话列表怎么折：算座位的纯函数，以及往宿主行上贴记号的那半（测试用假 DOM 喂它）
	foldHeads, foldRows, nextOpen, readOpenTrees, writeOpenTrees, OPEN_KEY,
	applyFold, clearFold, foldReport, sessionIdOf, unitOf, FOLD_ATTR, FOLD_BUTTON,
	// 画
	dotStyle, inkOf, fade, shapeSpec, shapeOf, shapeBox, drawnWidth, shapeHeight, polyPoints, polyProps, roleOf, dashedOf, dotSizeOf,
	// 形状怎么算出来的：面积、按面积配齐的放大倍数、正 n 边形、十字
	polyArea, growOf, regularPoly, crossPoly,
	SHAPES, THEME, ROLES, CUSTOM, PICTURE, ICON_EDGE,
	// 自定义字：上限、占几倍宽、该用多大字号
	GLYPH_STORE_MAX, GLYPH_MIN_SCALE, GLYPH_FIT_EM, glyphFit, glyphSpanFor, spanOf, RARE_SHAPES, PICK_SHAPES, GLYPH_SPAN, GLYPH_PAD_X, GLYPH_PAD_Y, GLYPH_BOX, GLYPH_RADIUS, glyphGrow, glyphFont, emWidth, glyphEm, glyphBoxStyle,
	// 收藏：五角星的形状、配色、以及点下去那一下的动画
	STAR, STAR_COLOR, starPoly, starSkin, starAnimation, STAR_ANIM, STAR_ANIM_MS, favShape,
	// 一个色值，按底色自己调明度 —— 明暗两边不再各写一版
	BACKDROP, CONTRAST_MIN, FILL_ALPHA, readable, onAccent, paint, relLuminance, contrastRatio, hexToHsl, hslToHex, fitContrast,
	// 节点上的用户标注（改名 / 收藏）
	readLabels, writeLabel, readFavorites, writeFavorite, nextFavorites,
	readFavIcons, writeFavIcon, nextFavIcons,
	readFavColors, writeFavColor, nextFavColors, isColor,
	// 详情卡里能离线测的那两件事：改没改过、这一下是不是输入法在拼字
	isDirty, isComposingKey, keepsCard, clampGlyph,
	// 焦点被宿主抢走时抢不抢回来
	shouldRefocus, LEAVE_MS, CARD_MARK, FAV_COLORS, FAV_SHAPES, FAV_DROP, PICK, GAP, favSwatch,
	// 配色与明暗
	PALETTE, paletteOf, themeFrom, isDark, isHex, hexOf,
	// 几何
	reachFor, segments, edgeOrder, nodeAt, hoverNext, railLayout, railRight, railRoom, shrinkToLane, trimRuns, MIN_RUN, cardAnchor, CARD_GAP, rowSlots, boxShift,
	// 版式上的共处：正文栏右缘在哪、聊天是不是被别的插件盖住了、容器里挂的是不是别的页签
	contentRightOf, isCovered, otherViewShown, RAIL_MARK,
	// 指针：能不能悬停、手指戳一下算什么、WebKit 上必须补的那几条样式
	tapNext, hasHover, overRail, watchViewport, TAPPABLE, NO_ZOOM,
	// 撤回的重拉节奏；会话列表的指纹（0.2 宿主上 updatedAt 不跟回答走，得把 running 算进去）；跑完之后的补拉
	isRewindPending, rewindRetryDelay, listStamp, runningCount, settleDelay, tagOutlines,
	// 现在看到的是第几轮：按位置挑，以及点击之后的钉住
	pickActiveTurn, pinActiveTurn, unpinActiveTurn, pinnedTurn, settlePin, nudgePin, PIN_SLACK, PIN_SETTLE_MS,
	// 未读节点读过之后的三段式节奏
	readPhase, readAnimation, nextReadBoundary, READ_ANIM, READ_HOLD_MS, READ_FADE_MS, READ_MELT_MS,
	// 设置（SETTINGS_NS 同时是 0.2 宿主眼里的 entry id，测试要核它）
	SETTINGS_NS, settingsStore, stepText, layerText, scaleText, scaleZ, STEPS, LAYERS, SCALES, RADIUS, DEPTH, SCALE, FIELDS, ROWS, Z, C,
	VISIBLE, isMode, visibleRange, stepsAway, layersAway,
	// 组件：离线测试用 react-lite 挂起来测交互（tests/test-card.mjs 是例子）
	Detail, NameField, FavIconRow, HexField, MergeList, SettingsCard, Rail,
}
