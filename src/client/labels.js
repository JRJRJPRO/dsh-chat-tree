/**
 * 节点改名：存 localStorage。
 *
 * ⚠️ **这是个半成品**：换浏览器就没了，也进不了手机。真正的落点应该是 host 半的
 * `shape.json` 旁边（那儿已经有 `$DSH_HOME/plugins/dsh-tree/`），接口保持成
 * `readLabels()/writeLabel()` 两个函数就是为了那天只改这一个文件。
 */

export const LS_KEY = 'dsh-tree.labels'

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
	try {
		localStorage.setItem(LS_KEY, JSON.stringify(all))
	} catch {
		/* 存不下就算了 */
	}
}
