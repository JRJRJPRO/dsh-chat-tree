/**
 * 路由外壳（src/host/http.js）的用例。
 *
 * 为什么单独测它：三个路由现在共用这一层壳，它错一次就是三个接口一起错。
 * 而它又是**最不容易在界面上看出来**的那种错 —— 比如 405 回成 200、
 * 出错体不是 `{error}`（浏览器半的 `net.js` 就指望这个字段说人话）、
 * 图片走了 JSON 编码（那是一屏乱码，不是一张图）。
 *
 * 不起真的 HTTP 服务：`route()` 要的只是 `ctx.webServer.register`，
 * 给个假的就能把 handler 抠出来，再喂一个假的 req/res。
 *
 * @module test-http
 */

import { check, report } from './test-kit.mjs'
import { inject } from '../index.js'
import { HttpError, MAX_BODY_BYTES, raw, rejectionOf, route } from '../src/host/http.js'

/**
 * 假 ctx：把注册进来的 handler 按路径收起来。
 * @returns `{ctx, handlers}`
 */
function fakeCtx() {
	const handlers = new Map()
	// 宿主 connection 的替身。`fence.verdict` 就是 requestRejection 的返回值：
	// undefined = 放行，数字 = 该回的状态码。用例随时改它。
	const fence = { verdict: undefined }
	const ctx = {
		effect: (run) => run(),
		connection: { requestRejection: () => fence.verdict },
		webServer: {
			register: (spec) => {
				handlers.set(spec.path, spec.handler)
				return () => {}
			},
		},
	}
	return { ctx, handlers, fence }
}

/**
 * 假 req/res，跑一次请求。
 * @param handler - route 注册进去的那个
 * @param method - HTTP 方法
 * @param url - 请求行里的 url
 * @param body - 请求体原文
 * @param headers - 请求头覆盖项（键名小写，Node 就是这么给的）
 * @returns `{status, headers, text, json}`
 */
async function call(handler, method, url, body, headers) {
	const chunks = body === undefined ? [] : [Buffer.from(body)]
	const req = {
		method,
		url,
		// 默认补一个本机 Host 和 JSON content-type：信任围栏要求它们在场，
		// 而用例 1-5 测的是别的事。专门测围栏的用例自己传 headers 覆盖。
		headers: {
			host: '127.0.0.1:3080',
			...(method === 'POST' ? { 'content-type': 'application/json' } : {}),
			...headers,
		},
		async *[Symbol.asyncIterator]() {
			for (const chunk of chunks) yield chunk
		},
	}
	const out = { status: 0, headers: {}, text: '' }
	const res = {
		writeHead: (status, headers) => {
			out.status = status
			out.headers = headers || {}
		},
		end: (payload) => {
			out.text = Buffer.isBuffer(payload) ? payload.toString('binary') : String(payload === undefined ? '' : payload)
		},
	}
	await handler(req, res)
	try {
		out.json = JSON.parse(out.text)
	} catch {
		out.json = undefined
	}
	return out
}

const { ctx, handlers, fence } = fakeCtx()
const seen = []
route(ctx, '/demo', {
	GET: ({ query }) => ({ cwd: query.get('cwd'), who: 'get' }),
	POST: ({ body }) => {
		seen.push(body)
		return { ok: true, got: body }
	},
})
route(ctx, '/boom', {
	GET: () => {
		throw new HttpError(404, '没有这张图')
	},
	POST: () => {
		throw new TypeError('我自己写错了')
	},
})
route(ctx, '/bytes', { GET: () => raw({ 'content-type': 'image/png' }, Buffer.from([0x89, 0x50])) })

const demo = handlers.get('/plugins/dsh-chat-tree/demo')
const boom = handlers.get('/plugins/dsh-chat-tree/boom')
const bytes = handlers.get('/plugins/dsh-chat-tree/bytes')

console.log('用例 1：路径前缀、查询串、返回值直接当 JSON 发')
{
	check(handlers.size === 3, `注册了 ${handlers.size} 个路由，应该是 3 个`)
	check(
		[...handlers.keys()].every((path) => path.startsWith('/plugins/dsh-chat-tree/')),
		`路径前缀不对：${[...handlers.keys()].join(' ')}`,
	)
	const answer = await call(demo, 'GET', '/plugins/dsh-chat-tree/demo?cwd=D%3A%2Fx')
	check(answer.status === 200, `状态码 ${answer.status}`)
	check(answer.json.cwd === 'D:/x', `查询串没解出来：${JSON.stringify(answer.json)}`)
	check(String(answer.headers['content-type']).includes('application/json'), '答复没标成 JSON')
	check(answer.headers['cache-control'] === 'no-store', '大纲这类东西不许被缓存')
	console.log(`  前缀自动加好；?cwd 解成 ${answer.json.cwd}；带 no-store`)
}

console.log('用例 2：POST 的 body 自动解析，空 body 当 {}')
{
	const answer = await call(demo, 'POST', '/plugins/dsh-chat-tree/demo', '{"session":"s1","group":"t1"}')
	check(answer.json.ok === true, 'POST 没走到 handler')
	check(answer.json.got.session === 's1' && answer.json.got.group === 't1', `body 解错了：${JSON.stringify(answer.json.got)}`)
	const empty = await call(demo, 'POST', '/plugins/dsh-chat-tree/demo', '')
	check(empty.status === 200 && JSON.stringify(empty.json.got) === '{}', `空 body 应该当成 {}，实际 ${empty.text}`)
	const broken = await call(demo, 'POST', '/plugins/dsh-chat-tree/demo', '{不是 json')
	check(broken.status === 400, `坏 body 应该 400，实际 ${broken.status}`)
	check(typeof broken.json.error === 'string', '出错体必须是 {error: string}，浏览器半就指望这个字段')
	console.log(`  正常 body 解到 handler；空 body → {}；坏 body → 400「${broken.json.error}」`)
}

console.log('用例 3：没登记的方法一律 405，而不是当成 GET')
{
	const answer = await call(demo, 'DELETE', '/plugins/dsh-chat-tree/demo')
	check(answer.status === 405, `DELETE 应该 405，实际 ${answer.status}`)
	const onlyGet = await call(bytes, 'POST', '/plugins/dsh-chat-tree/bytes', '{}')
	check(onlyGet.status === 405, `没登记 POST 的路由收到 POST 应该 405，实际 ${onlyGet.status}`)
	console.log(`  DELETE → 405；往只读路由 POST → 405`)
}

console.log('用例 4：说好的失败用它自己的状态码，没说好的一律 500')
{
	const known = await call(boom, 'GET', '/plugins/dsh-chat-tree/boom')
	check(known.status === 404, `HttpError(404) 应该出 404，实际 ${known.status}`)
	check(known.json.error === '没有这张图', `错误信息丢了：${known.text}`)
	const bug = await call(boom, 'POST', '/plugins/dsh-chat-tree/boom', '{}')
	// ⚠️ 这一条是有意义的：把自己的 bug 也回成 400，就等于告诉用户"你传错了"，
	//    然后没人会去看服务端日志。500 才是"我这边坏了"。
	check(bug.status === 500, `没预料到的异常应该 500，实际 ${bug.status}`)
	console.log(`  HttpError → 404「${known.json.error}」；TypeError → 500`)
}

console.log('用例 5：图片走原样字节，不许被 JSON 编码')
{
	const answer = await call(bytes, 'GET', '/plugins/dsh-chat-tree/bytes')
	check(answer.status === 200, `状态码 ${answer.status}`)
	check(answer.headers['content-type'] === 'image/png', `content-type 是 ${answer.headers['content-type']}`)
	check(answer.text === '\x89P', `字节被动过了：${JSON.stringify(answer.text)}`)
	console.log('  PNG 头两个字节原样出去，content-type 是 image/png')
}

console.log('用例 6：鉴权交给宿主的 connection，判决原样照办')
{
	// 【为什么不自己判】这里一度手写过 Host/Origin 两道闸，判据是"它不可能是
	// DNS rebinding"，于是放行**所有 IP 字面量**。那挡住了浏览器替人发起的攻击，
	// 却挡不住同网段的人直接 curl ——	lanBind 开着时，会话预览就是这么漏出去的。
	// 现在这一层只做一件事：把 connection 的判决原样执行。
	fence.verdict = undefined
	const open = await call(demo, 'GET', '/plugins/dsh-chat-tree/demo')
	check(open.status === 200, `放行时应该 200，实际 ${open.status}`)

	fence.verdict = 403
	const fenced = await call(demo, 'GET', '/plugins/dsh-chat-tree/demo')
	check(fenced.status === 403, `围栏说 403 就得是 403，实际 ${fenced.status}`)
	check(fenced.json.error.includes('trustedHosts'), '报错里要写清楚怎么放行，否则走隧道的人只会看到"导轨没了"')

	fence.verdict = 401
	const anon = await call(demo, 'GET', '/plugins/dsh-chat-tree/demo')
	check(anon.status === 401, `围栏说 401 就得是 401，实际 ${anon.status}`)
	// ⚠️ 401 的提示要指向 /remote：局域网页面撞上的就是这个码，
	//    浏览器半靠它改走通道（src/client/net.js 的 send）。
	check(anon.json.error.includes('/remote'), '401 的提示必须指向 /remote 通道')

	// GET 也要过闸 —— /outlines 是读接口，泄露的就是它
	fence.verdict = 403
	check((await call(demo, 'GET', '/plugins/dsh-chat-tree/demo')).status === 403, 'GET 必须同样受围栏管')
	fence.verdict = undefined
	console.log('  放行/403/401 原样照办；GET 同样受管；报错分别指向 trustedHosts 和 /remote')
}

console.log('用例 7：拿不到 connection 就一律拒绝，绝不裸奔')
{
	// fail-open 等于整道围栏白写。宁可树画不出来，也不能把会话预览挂出去。
	check(rejectionOf({}, {}) === 503, '没有 connection 服务时必须拒绝')
	check(rejectionOf({ connection: {} }, {}) === 503, 'connection 在但没有 requestRejection 也必须拒绝')
	check(rejectionOf({ connection: { requestRejection: () => undefined } }, {}) === undefined, '正常的 connection 该放行')
	// ⚠️ 这条钉着"别把 connection 从顶层 inject 里拿掉"。拿掉之后 cordis 给的 ctx 上
	//    没有这个服务，上面那条 503 就会变成线上行为：树整个空白，而日志里什么都不会说。
	check(inject.includes('connection'), 'connection 必须在顶层 inject 里，否则线上拿不到判决，三条路由会全部 503')
	console.log('  没有 connection / 接口对不上 → 503；正常的照常放行；connection 在顶层 inject 里')
}

console.log('用例 8：只收 JSON，且 body 有上限')
{
	const form = await call(demo, 'POST', '/plugins/dsh-chat-tree/demo', '{"a":1}', {
		'content-type': 'application/x-www-form-urlencoded',
	})
	check(form.status === 415, `form 的 content-type 应该 415，实际 ${form.status}`)
	const noType = await call(demo, 'POST', '/plugins/dsh-chat-tree/demo', '{"a":1}', { 'content-type': '' })
	check(noType.status === 200, '没写 content-type 的（curl 默认就不写）不该被拦')
	const charset = await call(demo, 'POST', '/plugins/dsh-chat-tree/demo', '{"a":1}', {
		'content-type': 'application/json; charset=utf-8',
	})
	check(charset.status === 200, '带 charset 的 application/json 应该放行')
	// ⚠️ 上限必须在收的过程中判。等收完再数就晚了 —— 内存那时已经吃进去了。
	const huge = await call(demo, 'POST', '/plugins/dsh-chat-tree/demo', 'x'.repeat(MAX_BODY_BYTES + 1))
	check(huge.status === 413, `超长 body 应该 413，实际 ${huge.status}`)
	console.log(`  非 JSON → 415；无 content-type 放行；超 ${MAX_BODY_BYTES} 字节 → 413`)
}

report()
