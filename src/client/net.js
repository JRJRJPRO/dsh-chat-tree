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
 * 走不走 `remote-web-ui` 的 `/remote` 通道。
 *
 * 【为什么需要这个】host 半的三条路由现在问宿主的 `connection` 要判决，
 * 那道闸是 **loopback-only** 的：Host 不是 127.0.0.1 / localhost 就直接 403。
 * 手机在局域网里开的页面，Host 是局域网 IP —— 直连必然被拒。
 *
 * 宿主给这种情况留的路是 `remote-web-ui` 的 `/remote` 前缀：它做完配对校验，
 * 再以 127.0.0.1 把请求重发进来，于是围栏自然过。那是个**通用前缀转发**
 * （`/remote/<任意路径>`），不限于它自己那几条路由，我们直接借用即可 ——
 * 不碰它任何内部 API。
 *
 * ⚠️ 不能改成"一上来就走 /remote"：桌面端（127.0.0.1）压根没装 remote-web-ui 时
 *    那个前缀是 404。所以是**先直连，被拒了才换路，换成了就记住**。
 */
const REMOTE_PREFIX = '/remote'

/** 已经确认要走 /remote 了吗。一旦为真就不再试直连。 */
let viaRemote = false

/**
 * 现在该用哪个前缀。
 *
 * 给**不走 fetch 的东西**用 —— CSS `url(...)` 里的节点图片就是（`shapes.js` 的 `iconUrl`）。
 * 那类请求没有重试的机会，只能沿用 `send()` 已经试出来的结论。
 * 时序上够用：图片是在 `/outlines` 回来之后才画的，那时 `viaRemote` 已经定了。
 * @returns '' 或 '/remote'
 */
export function apiPrefix() {
	return viaRemote ? REMOTE_PREFIX : ''
}

/**
 * `remote-web-ui` 的免 cookie 设备凭据。
 *
 * 它自己的 fetch 补丁只给**被它改写过**的请求加这个头，而 `/plugins/...` 不在它的
 * 改写名单里 —— 我们自己拼的 `/remote/...` 因此拿不到。cookie 那条路通常够用
 * （同源请求自带），这里是补上无痕模式/跨标签页那种只有 sessionStorage 的情形。
 * 取不到就算了，配对校验自会说话。
 * @returns 设备 id，没有就是 undefined
 */
function deviceId() {
	try {
		return globalThis.sessionStorage?.getItem('dsh-remote-device') || undefined
	} catch {
		return undefined
	}
}

/**
 * 发一次请求；直连被围栏拒掉就改走 `/remote` 再试一次。
 *
 * 只对 401 / 403 重试 —— 那两个码才是"围栏说不行"。404 / 500 是别的毛病，
 * 换条路也一样。重试只发生一次，成了就把 `viaRemote` 钉住，之后不再多跑一个来回。
 * @param path - `API` 之后那一段
 * @param init - fetch 的第二个参数
 * @returns fetch 的答复
 */
async function send(path, init) {
	const device = deviceId()
	const go = (prefix) =>
		fetch(`${prefix}${API}${path}`, {
			...init,
			credentials: 'same-origin',
			headers: {
				...(init && init.headers),
				...(prefix !== '' && device !== undefined ? { 'x-dsh-remote-device': device } : {}),
			},
		})
	if (viaRemote) return go(REMOTE_PREFIX)
	const direct = await go('')
	if (direct.status !== 401 && direct.status !== 403) return direct
	const relayed = await go(REMOTE_PREFIX)
	if (relayed.ok) viaRemote = true
	// 换路也不行：把**直连**那份答复还回去。它的错误信息说的是真正的原因
	// （"没有登录凭据"），而 /remote 的 404 只会让人以为是路由写错了。
	return relayed.ok ? relayed : direct
}

/**
 * GET 一个 JSON。
 * @param path - `API` 之后那一段，比如 `/outlines`
 * @param params - 查询串，值会自己 encode
 * @returns 解析好的 body
 */
export async function getJson(path, params) {
	const query = new URLSearchParams(params || {}).toString()
	return unwrap(await send(`${path}${query === '' ? '' : `?${query}`}`))
}

/**
 * POST 一个 JSON。
 * @param path - `API` 之后那一段，比如 `/shape`
 * @param body - 会被 JSON.stringify 的东西
 * @returns 解析好的 body
 */
export async function postJson(path, body) {
	return unwrap(
		await send(path, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(body),
		}),
	)
}
