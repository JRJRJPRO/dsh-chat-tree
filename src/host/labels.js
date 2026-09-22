/**
 * 节点标注（改名、收藏、收藏图标、收藏颜色）的落盘。
 *
 * 以前这四样全存浏览器 localStorage：换浏览器、上手机、清缓存就全没了。
 * 现在存 `$DSH_HOME/plugins/dsh-tree/labels.json`，和 shape.json 放一块，
 * 浏览器那份只当缓存（见 src/client/labels.js）。
 *
 * 集合算术（加一个 / 去一个 / 恢复默认）复用浏览器半的那几个纯函数，
 * 两边一套规矩：恢复默认是**删掉这一条**，不是存一个默认值。
 */
import { nextFavColors, nextFavIcons, nextFavorites } from '../client/labels.js'
import { atomicWrite, pluginFile, readJsonFile } from './paths.js'

/** 落盘位置。 */
export function labelsPath() {
	return pluginFile('labels.json')
}

/** 空白文档。 */
export const EMPTY_LABELS = { version: 1, labels: {}, favorites: [], favIcons: {}, favColors: {} }

const dict = (value) => (value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {})
const strings = (value) => (Array.isArray(value) ? value.filter((item) => typeof item === 'string' && item.length > 0) : [])
const stringDict = (value) => {
	const out = {}
	for (const [key, item] of Object.entries(dict(value))) if (typeof item === 'string' && item.length > 0) out[key] = item
	return out
}

/**
 * 读标注。读不到 / 坏了 / 版本对不上一律退回空白 —— 丢了只是标注没了，别把导轨带崩。
 * @returns 标注文档
 */
export function readLabels() {
	const document = readJsonFile(labelsPath())
	if (document === null || typeof document !== 'object' || document.version !== 1) return EMPTY_LABELS
	return {
		version: 1,
		labels: stringDict(document.labels),
		favorites: strings(document.favorites),
		favIcons: stringDict(document.favIcons),
		favColors: stringDict(document.favColors),
	}
}

/**
 * 打一条标注补丁。四个字段各自可选，都是 `{节点 key: 值}`：
 *   labels    值是名字，空串 = 删
 *   favorites 值是 true / false
 *   favIcons  值是形状值，空串 / 'star' = 恢复默认
 *   favColors 值是 #rrggbb，空串 / 认不得 = 恢复默认
 * @param patch - 补丁
 * @returns 打完补丁的文档
 */
export function patchLabels(patch) {
	const current = readLabels()
	const labels = Object.assign({}, current.labels)
	for (const [key, value] of Object.entries(dict(patch?.labels))) {
		if (typeof key !== 'string' || key.length === 0) continue
		if (typeof value === 'string' && value.length > 0) labels[key] = value
		else delete labels[key]
	}
	let favorites = new Set(current.favorites)
	for (const [key, on] of Object.entries(dict(patch?.favorites))) favorites = nextFavorites(favorites, key, on === true)
	let favIcons = current.favIcons
	for (const [key, value] of Object.entries(dict(patch?.favIcons))) favIcons = nextFavIcons(favIcons, key, value)
	let favColors = current.favColors
	for (const [key, value] of Object.entries(dict(patch?.favColors))) favColors = nextFavColors(favColors, key, value)
	const next = { version: 1, labels, favorites: [...favorites], favIcons, favColors }
	atomicWrite(labelsPath(), `${JSON.stringify(next)}\n`)
	return next
}
