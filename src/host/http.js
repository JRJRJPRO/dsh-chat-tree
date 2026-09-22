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
export const API = '/plugins/dsh-chat-tree'

// ===== 信任围栏 =====
//
// ⚠️ 宿主的 webserver **不带任何鉴权**，这是它 README 的原话：
//   “No server-wide TLS, authentication, or origin policy — route owners such as
//    `dsh-client-connection` enforce their own request policy.”
// 谁注册谁负责。我们注册了三条：`/outlines` 会把每一轮的提问预览全吐出来，
// `/shape` 和 `/icon` 是写操作。
//
// 【为什么不自己写这道闸】这里一度手写过 Host / Origin 两道检查，判据是
// “它不可能是 DNS rebinding”，于是**放行所有 IP 字面量**。那挡住了浏览器替人发起的
// 两类攻击，却漏掉了最朴素的一种：profile 里 `remote-web-ui` 开着 `lanBind`、
// webserver 绑 `0.0.0.0`，同网段任何人一条 curl 就能读走全部会话的提问预览 ——
// 没有浏览器参与，Origin 和 Host 都随他填。
//
// 现在改成问宿主要判决：`connection.requestRejection(req)`。那是 `/api/*` 用的同一道闸，
// 比手写那版严格得多，而且我们不用自己碰任何密码学：
//   · Host 必须是 loopback 或 `trustedHosts` 里声明过的部署地址（挡 DNS rebinding）
//   · `sec-fetch-site: cross-site` 一律拒；带了 Origin 就必须同源（挡 CSRF ——
//     顺带把 `Origin: null` 也按不同源处理，手写那版是放行的）
//   · 然后才是浏览器鉴权：签名 cookie 对不上回 401
// 返回 `undefined` 表示放行，否则就是该回的状态码。第一方插件
// `@deepseek-ai/dsh-host-open-in-app` 的三条路由用的就是这个写法。
//
// ⚠️ 这道闸是 loopback-only 的，**手机不会因此被锁在门外**：局域网页面的请求本来就该走
//    `remote-web-ui` 的 `/remote` 通道 —— 宿主在那头做完配对校验，再以 127.0.0.1 重发进来。
//    浏览器半的 `src/client/net.js` 负责在直连被拒时改走那条路。两边是一对的，改一边记得改另一边。

/** POST body 上限。形状数据只有几十字节，64 KiB 已经宽得离谱，纯粹是防喂爆内存。 */
export const MAX_BODY_BYTES = 64 * 1024

/**
 * 问宿主的 connection 服务：这个请求该不该被拒。
 *
 * 单独抽出来是为了**离线测试能替**：测试里没有真的 connection 服务，塞个假的就能跑。
 * @param ctx - 插件 context
 * @param req - Node 请求
 * @returns 该回的状态码；放行则 undefined
 */
export function rejectionOf(ctx, req) {
	// connection 的包是浏览器半的，host 这边拿不到它的类型，只能 Reflect 取
	// （第一方的 open-in-app 也是这么写的）
	const connection = Reflect.get(ctx, 'connection')
	if (connection === undefined || typeof connection.requestRejection !== 'function') {
		// 拿不到判决就当拒绝。fail-open 等于把上面那段全白写了。
		return 503
	}
	return connection.requestRejection(req)
}


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
 *
 * ⚠️ 必须**边收边数**、超了当场停。以前是 `for await` 一路 push 到底再 parse ——
 * 那等于把对面发多少就吃多少，一条 `curl -T /dev/zero` 就能把 dsh 喂死。
 * 数完再判没有意义：内存那时已经吃进去了。
 * @param req - Node 请求
 * @returns 解析出来的东西
 */
async function readJson(req) {
	const chunks = []
	let size = 0
	for await (const chunk of req) {
		size += chunk.length
		if (size > MAX_BODY_BYTES) throw new HttpError(413, `请求体超过 ${MAX_BODY_BYTES} 字节`)
		chunks.push(chunk)
	}
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

						// 闸一：宿主的鉴权围栏（Host/Origin + 登录 cookie）。
						// 放在 405 之后是有意的：方法都不对的请求没必要惊动鉴权。
						const rejection = rejectionOf(ctx, req)
						if (rejection !== undefined) {
							throw new HttpError(
								rejection,
								rejection === 401
									? '没有登录凭据。局域网访问要走 /remote 通道，见 src/client/net.js。'
									: `请求被宿主的信任围栏拒绝（${rejection}）。` +
											'走隧道/反代请把域名加进 client-connection 的 trustedHosts 再重启 dsh。',
							)
						}

						if (method === 'POST') {
							// 闸二：只收 application/json。跨站已经被上面那道闸挡了，
							// 这条纯粹是"别把不是 JSON 的东西喂进 JSON.parse"。
							const kind = String(req.headers?.['content-type'] || '')
							if (kind.length > 0 && !/^application\/json\b/i.test(kind)) {
								throw new HttpError(415, `POST 只收 application/json，收到「${kind}」`)
							}
						}
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
		`dsh-chat-tree: ${path}`,
	)
}
