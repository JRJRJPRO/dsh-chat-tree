/**
 * 三个路由共用的壳：读 body、发 JSON、报错怎么变成状态码。
 *
 * 【为什么单独一份】以前三个 `webServer.register` 各自写了一遍
 * "`for await` 收 chunk → `JSON.parse` → try/catch → `writeHead`"，
 * 三处的出错码还不一样（500 / 400 / 400）。加第四个路由时只能挑一份抄 ——
 * 抄哪份都不对，因为没人说得清哪份是对的。
 *
 * 现在的约定：
 *   · handler 返回什么就发什么（对象 → JSON 200）
 *   · 要发别的（图片字节、别的状态码）就返回 `raw(...)`
 *   · 抛 `HttpError` → 用它带的状态码；抛别的 → 500（那是我们自己的 bug）
 *
 * 浏览器那边的对应物是 `src/client/net.js`，两边约定好错误体一律是 `{error: string}`。
 */

/** host 半三个路由的公共前缀。改这里要连着改 `src/client/net.js` 的 `API`。 */
export const API = '/plugins/dsh-tree'

/** 带状态码的错误。handler 想回 4xx 就抛它，别自己写 res。 */
export class HttpError extends Error {
	/**
	 * @param status - HTTP 状态码
	 * @param message - 给用户看的一句话，会原样放进 `{error}`
	 */
	constructor(status, message) {
		super(message)
		this.status = status
	}
}

/**
 * 不是 JSON 的答复（现在只有图片）。
 * @param headers - 响应头
 * @param body - Buffer
 * @returns 一个 handler 可以直接返回的东西
 */
export function raw(headers, body) {
	return { __raw: true, headers, body }
}

/**
 * 回一段 JSON。
 * @param res - Node 响应
 * @param status - HTTP 状态码
 * @param value - 序列化后发出去的东西
 */
export function json(res, status, value) {
	res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
	res.end(JSON.stringify(value))
}

/**
 * 把请求体读成 JSON。空 body 当成 `{}`。
 * @param req - Node 请求
 * @returns 解析出来的东西
 */
async function readJson(req) {
	const chunks = []
	for await (const chunk of req) chunks.push(chunk)
	try {
		return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
	} catch {
		throw new HttpError(400, '请求体不是合法 JSON')
	}
}

/**
 * 注册一个路由。
 *
 * @param ctx - 插件 context
 * @param path - `API` 之后那一段，比如 `/outlines`
 * @param handlers - `{GET, POST}`，签名都是 `({query, body}) => 答复`；
 *                   没登记的方法一律 405
 * @returns 交给 `ctx.effect` 的注册动作
 */
export function route(ctx, path, handlers) {
	return ctx.effect(
		() =>
			ctx.webServer.register({
				kind: 'exact',
				path: `${API}${path}`,
				handler: async (req, res) => {
					try {
						const method = req.method === undefined ? 'GET' : req.method.toUpperCase()
						const run = handlers[method]
						if (run === undefined) throw new HttpError(405, `${path} 不支持 ${method}`)
						// URL 要一个 base 才能解析，随便给一个不会被访问到的
						const url = new URL(req.url || '/', 'http://dsh.invalid')
						const answer = await run({
							query: url.searchParams,
							body: method === 'POST' ? await readJson(req) : undefined,
						})
						if (answer !== null && typeof answer === 'object' && answer.__raw === true) {
							res.writeHead(200, answer.headers)
							return res.end(answer.body)
						}
						return json(res, 200, answer)
					} catch (error) {
						// 自己抛的 HttpError 是"说好的失败"，别的都是 bug —— 后者报 500，
						// 好在浏览器控制台里一眼分得出是"你传错了"还是"我写错了"
						const status = error instanceof HttpError ? error.status : 500
						return json(res, status, { error: String((error && error.message) || error) })
					}
				},
			}),
		`dsh-tree: ${path}`,
	)
}
