/**
 * 和 host 半说话的唯一出口：三个路由的地址、两个 fetch、一个 warn。
 *
 * 【为什么单独一份】以前三处各写一遍 `fetch(...).then(r => r.ok ? r.json() : reject)`，
 * 三处的出错处理各不相同（一处吞掉、一处抛、一处 console.warn），加第四个路由时
 * 还得挑一份抄。现在的约定只有一条：
 *
 *   **失败一律 throw**，要不要吞由调用方决定（画树的吞，上传图片的不吞）。
 *
 * host 那边的对应物是 `src/host/http.js`，两边的错误体格式都是 `{error: string}`。
 */

/** host 半三个路由的公共前缀。改路由只改这一行（host 的 `src/host/http.js` 里有同一个常量）。 */
export const API = '/plugins/dsh-tree'

/**
 * 统一的告警。前缀固定成 `[dsh-tree]`，好在一屏控制台里一眼捞出来是谁在叫。
 * @param what - 人话，说清楚是哪件事没成
 * @param error - 原始错误
 */
export function warn(what, error) {
	console.warn(`[dsh-tree] ${what}`, error)
}

/**
 * 把答复解出来；HTTP 不是 2xx 就抛。
 *
 * 错误信息优先取 body 里的 `error` 字段 —— host 半出错时回的就是 `{error: '…'}`，
 * 直接把那句话摆给用户看，比 "400" 有用得多。
 * @param response - fetch 的答复
 * @returns 解析好的 body
 */
async function unwrap(response) {
	const body = await response.json().catch(() => undefined)
	if (!response.ok) throw new Error((body && body.error) || `HTTP ${response.status}`)
	return body
}

/**
 * GET 一个 JSON。
 * @param path - `API` 之后那一段，比如 `/outlines`
 * @param params - 查询串，值会自己 encode
 * @returns 解析好的 body
 */
export async function getJson(path, params) {
	const query = new URLSearchParams(params || {}).toString()
	return unwrap(await fetch(`${API}${path}${query === '' ? '' : `?${query}`}`, { credentials: 'same-origin' }))
}

/**
 * POST 一个 JSON。
 * @param path - `API` 之后那一段，比如 `/shape`
 * @param body - 会被 JSON.stringify 的东西
 * @returns 解析好的 body
 */
export async function postJson(path, body) {
	return unwrap(
		await fetch(`${API}${path}`, {
			method: 'POST',
			credentials: 'same-origin',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(body),
		}),
	)
}
