/**
 * 节点上的用户标注：**改名**、**收藏**、收藏图标、收藏颜色。
 *
 * 落盘在宿主那边（`$DSH_HOME/plugins/dsh-tree/labels.json`，见 src/host/labels.js），
 * 换浏览器、上手机都还在。这里的 localStorage 只是**缓存**：每次拉到 `/outlines`
 * 就用宿主那份盖一遍（adoptLabels），写的时候本地先改、再把补丁 POST 给宿主。
 * 宿主是空的而本地有货（老版本留下的）→ 把本地整份送上去一次（seedFromLocal）。
 *
 * 两者的键都是**节点 key**（`<sessionId>:<turn>`，树根是 `root`，见 tree.js），
 * 所以改名和收藏天然对齐到同一个点上。
 */

import { postJson, warn } from './net.js'

export const LS_KEY = 'dsh-tree.labels'

/** 把补丁送给宿主。失败只记一笔：本地缓存已经改了，界面照常。 */
function push(patch) {
	postJson('/labels', patch).catch((error) => warn('标注没存到宿主，只留在了本浏览器', error))
}

const setItem = (key, value) => {
	try {
		localStorage.setItem(key, JSON.stringify(value))
	} catch {
		/* 存不下就算了 */
	}
}

/**
 * 用宿主那份盖掉本地缓存。宿主没给（老版本 host）就什么都不做。
 * @param doc - `/outlines` 里带来的 `labels`
 */
export function adoptLabels(doc) {
	if (doc === null || typeof doc !== 'object' || doc.version !== 1) return
	if (seedFromLocal(doc)) return // 本地的更全，送上去，别用空的把它盖掉
	setItem(LS_KEY, doc.labels || {})
	setItem(FAVORITES_KEY, Array.isArray(doc.favorites) ? doc.favorites : [])
	setItem(FAVICONS_KEY, doc.favIcons || {})
	setItem(FAVCOLORS_KEY, doc.favColors || {})
}

/**
 * 宿主空、本地有 → 把本地整份送上去。只在这一种情况下做，做过一次就不再做。
 * @param doc - 宿主那份
 * @returns 是否送了
 */
export function seedFromLocal(doc) {
	const hostEmpty = Object.keys(doc.labels || {}).length === 0 && (doc.favorites || []).length === 0
		&& Object.keys(doc.favIcons || {}).length === 0 && Object.keys(doc.favColors || {}).length === 0
	if (!hostEmpty) return false
	const labels = readLabels()
	const favorites = readFavorites()
	const favIcons = readFavIcons()
	const favColors = readFavColors()
	if (Object.keys(labels).length === 0 && favorites.size === 0 && Object.keys(favIcons).length === 0 && Object.keys(favColors).length === 0) return false
	const patch = { labels, favorites: {}, favIcons, favColors }
	for (const key of favorites) patch.favorites[key] = true
	push(patch)
	return true
}

/** 收藏清单存哪。和改名分开存：改名是一张字典，收藏是一个集合，混在一起迟早要判类型。 */
export const FAVORITES_KEY = 'dsh-tree.favorites'

/** @returns {Record<string,string>} */
export function readLabels() {
	try {
		return JSON.parse(localStorage.getItem(LS_KEY) || '{}') || {}
	} catch {
		return {}
	}
}

/**
 * @param key - `<sessionId>:<turn>` 或 `root`
 * @param value - 名字；空串 = 删除，回到默认
 */
export function writeLabel(key, value) {
	const all = readLabels()
	if (value) all[key] = value
	else delete all[key]
	setItem(LS_KEY, all)
	push({ labels: { [key]: value || '' } })
}

// ===== 收藏 =====
//
// 存盘格式是个**字符串数组**（不是 `{key: true}`）：它本来就是个集合，
// 存成字典的话早晚有人写出 `favorites[key] === false` 这种"取消收藏"的假动作，
// 于是清单里躺满了取消过的键。数组里没有就是没有。

/**
 * 收藏清单。
 * @returns 节点 key 的集合
 */
export function readFavorites() {
	try {
		const raw = JSON.parse(localStorage.getItem(FAVORITES_KEY) || '[]')
		return new Set(Array.isArray(raw) ? raw.filter((item) => typeof item === 'string' && item.length > 0) : [])
	} catch {
		return new Set()
	}
}

/**
 * 加一个 / 去一个之后的清单。**纯函数**，不碰 localStorage ——
 * 存盘那一下没法在 node 里测，集合算术可以。
 * @param current - 现在的集合
 * @param key - 节点 key
 * @param on - true 收藏、false 取消
 * @returns 新集合（不改原来那个）
 */
export function nextFavorites(current, key, on) {
	const next = new Set(current || [])
	if (typeof key !== 'string' || key.length === 0) return next
	if (on) next.add(key)
	else next.delete(key)
	return next
}

/**
 * 收藏 / 取消收藏并存盘。
 * @param key - 节点 key
 * @param on - true 收藏、false 取消
 * @returns 新集合
 */
export function writeFavorite(key, on) {
	const next = nextFavorites(readFavorites(), key, on)
	setItem(FAVORITES_KEY, [...next])
	push({ favorites: { [key]: on === true } })
	return next
}

// ===== 收藏用哪个图标 =====
//
// 和收藏清单**分开存**，理由和当初把收藏从 labels 里拆出来一样：
// 清单是个集合，图标是张字典，混在一起迟早要判类型。
// 而且取消收藏时**故意不删图标** —— 取消再收藏回来，还是上次那个图标，
// 不用重挑一遍。一个字符串的代价，换掉一次"我刚才选的呢"。

/** 收藏图标存哪。值是形状值：预设 id / `char:<字>` / `img:<id>`。 */
export const FAVICONS_KEY = 'dsh-tree.favicons'

/**
 * 每个收藏点自己挑的图标。
 * @returns {Record<string,string>} 节点 key → 形状值；没挑过的不在里面
 */
export function readFavIcons() {
	try {
		const raw = JSON.parse(localStorage.getItem(FAVICONS_KEY) || '{}')
		if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return {}
		const out = {}
		for (const [key, value] of Object.entries(raw)) {
			if (typeof value === 'string' && value.length > 0) out[key] = value
		}
		return out
	} catch {
		return {}
	}
}

/**
 * 挑一个 / 恢复默认之后的字典。**纯函数**，不碰 localStorage。
 * @param current - 现在的字典
 * @param key - 节点 key
 * @param value - 形状值；空串 / `star` = 恢复默认，直接把这一条删掉
 * @returns 新字典（不改原来那个）
 */
export function nextFavIcons(current, key, value) {
	const next = Object.assign({}, current || {})
	if (typeof key !== 'string' || key.length === 0) return next
	const want = typeof value === 'string' ? value.trim() : ''
	// ⚠️ 恢复默认是**删掉这一条**，不是存一个 'star'。存进去的话，哪天默认记号
	//    换了样子，所有"没改过"的点会被这条陈年记录钉在旧样子上。
	if (want === '' || want === 'star') delete next[key]
	else next[key] = want
	return next
}

/**
 * 挑图标并存盘。
 * @param key - 节点 key
 * @param value - 形状值；空串 = 恢复默认
 * @returns 新字典
 */
export function writeFavIcon(key, value) {
	const next = nextFavIcons(readFavIcons(), key, value)
	setItem(FAVICONS_KEY, next)
	push({ favIcons: { [key]: typeof value === 'string' ? value : '' } })
	return next
}

// ===== 收藏用什么颜色 =====
//
// ⚠️ 这条推翻了原来"收藏恒为那个黄"的硬规矩。当初的理由是"颜色一旦可配，
//    '哪个是收藏'这件一眼能扫出来的事就失效了"，现在仍然成立 —— 所以
//    **默认还是那个黄**，这里存的只是用户显式改过的那几个。没改过的不在字典里。
//
// 和图标分开存，理由和图标当初从收藏清单里拆出来一样：一张字典存一件事。
// 取消收藏同样**不删颜色**，收藏回来还是上次那个。

/** 收藏颜色存哪。值是 `#rrggbb`。 */
export const FAVCOLORS_KEY = 'dsh-tree.favcolors'

/** 认不认这个颜色。只收六位十六进制 —— 它要直接进 CSS，认宽了等于开个注入口子。 */
export function isColor(value) {
	return typeof value === 'string' && /^#[0-9a-fA-F]{6}$/.test(value)
}

/**
 * 每个收藏点自己挑的颜色。
 * @returns {Record<string,string>} 节点 key → `#rrggbb`；没改过的不在里面
 */
export function readFavColors() {
	try {
		const raw = JSON.parse(localStorage.getItem(FAVCOLORS_KEY) || '{}')
		if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return {}
		const out = {}
		for (const [key, value] of Object.entries(raw)) {
			if (isColor(value)) out[key] = value.toLowerCase()
		}
		return out
	} catch {
		return {}
	}
}

/**
 * 改一个 / 恢复默认之后的字典。**纯函数**，不碰 localStorage。
 * @param current - 现在的字典
 * @param key - 节点 key
 * @param value - `#rrggbb`；空串 / 认不得的值 = 恢复默认，把这一条删掉
 * @returns 新字典（不改原来那个）
 */
export function nextFavColors(current, key, value) {
	const next = Object.assign({}, current || {})
	if (typeof key !== 'string' || key.length === 0) return next
	// ⚠️ 恢复默认是**删掉这一条**，不是存一个黄色。存进去的话，哪天默认色换了，
	//    所有"没改过"的点会被这条陈年记录钉在旧颜色上（和 nextFavIcons 同一条）。
	if (!isColor(value)) delete next[key]
	else next[key] = value.toLowerCase()
	return next
}

/**
 * 挑颜色并存盘。
 * @param key - 节点 key
 * @param value - `#rrggbb`；空串 = 恢复默认
 * @returns 新字典
 */
export function writeFavColor(key, value) {
	const next = nextFavColors(readFavColors(), key, value)
	setItem(FAVCOLORS_KEY, next)
	push({ favColors: { [key]: typeof value === 'string' ? value : '' } })
	return next
}
