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
import { HttpError, raw, route } from './src/host/http.js'

/**
 * 假 ctx：把注册进来的 handler 按路径收起来。
 * @returns `{ctx, handlers}`
 */
function fakeCtx() {
	const handlers = new Map()
	const ctx = {
		effect: (run) => run(),
		webServer: {
			register: (spec) => {
				handlers.set(spec.path, spec.handler)
				return () => {}
			},
		},
	}
	return { ctx, handlers }
}

/**
 * 假 req/res，跑一次请求。
 * @param handler - route 注册进去的那个
 * @param method - HTTP 方法
 * @param url - 请求行里的 url
 * @param body - 请求体原文
 * @returns `{status, headers, text, json}`
 */
async function call(handler, method, url, body) {
	const chunks = body === undefined ? [] : [Buffer.from(body)]
	const req = {
		method,
		url,
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

const { ctx, handlers } = fakeCtx()
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

const demo = handlers.get('/plugins/dsh-tree/demo')
const boom = handlers.get('/plugins/dsh-tree/boom')
const bytes = handlers.get('/plugins/dsh-tree/bytes')

console.log('用例 1：路径前缀、查询串、返回值直接当 JSON 发')
{
	check(handlers.size === 3, `注册了 ${handlers.size} 个路由，应该是 3 个`)
	check(
		[...handlers.keys()].every((path) => path.startsWith('/plugins/dsh-tree/')),
		`路径前缀不对：${[...handlers.keys()].join(' ')}`,
	)
	const answer = await call(demo, 'GET', '/plugins/dsh-tree/demo?cwd=D%3A%2Fx')
	check(answer.status === 200, `状态码 ${answer.status}`)
	check(answer.json.cwd === 'D:/x', `查询串没解出来：${JSON.stringify(answer.json)}`)
	check(String(answer.headers['content-type']).includes('application/json'), '答复没标成 JSON')
	check(answer.headers['cache-control'] === 'no-store', '大纲这类东西不许被缓存')
	console.log(`  前缀自动加好；?cwd 解成 ${answer.json.cwd}；带 no-store`)
}

console.log('用例 2：POST 的 body 自动解析，空 body 当 {}')
{
	const answer = await call(demo, 'POST', '/plugins/dsh-tree/demo', '{"session":"s1","group":"t1"}')
	check(answer.json.ok === true, 'POST 没走到 handler')
	check(answer.json.got.session === 's1' && answer.json.got.group === 't1', `body 解错了：${JSON.stringify(answer.json.got)}`)
	const empty = await call(demo, 'POST', '/plugins/dsh-tree/demo', '')
	check(empty.status === 200 && JSON.stringify(empty.json.got) === '{}', `空 body 应该当成 {}，实际 ${empty.text}`)
	const broken = await call(demo, 'POST', '/plugins/dsh-tree/demo', '{不是 json')
	check(broken.status === 400, `坏 body 应该 400，实际 ${broken.status}`)
	check(typeof broken.json.error === 'string', '出错体必须是 {error: string}，浏览器半就指望这个字段')
	console.log(`  正常 body 解到 handler；空 body → {}；坏 body → 400「${broken.json.error}」`)
}

console.log('用例 3：没登记的方法一律 405，而不是当成 GET')
{
	const answer = await call(demo, 'DELETE', '/plugins/dsh-tree/demo')
	check(answer.status === 405, `DELETE 应该 405，实际 ${answer.status}`)
	const onlyGet = await call(bytes, 'POST', '/plugins/dsh-tree/bytes', '{}')
	check(onlyGet.status === 405, `没登记 POST 的路由收到 POST 应该 405，实际 ${onlyGet.status}`)
	console.log(`  DELETE → 405；往只读路由 POST → 405`)
}

console.log('用例 4：说好的失败用它自己的状态码，没说好的一律 500')
{
	const known = await call(boom, 'GET', '/plugins/dsh-tree/boom')
	check(known.status === 404, `HttpError(404) 应该出 404，实际 ${known.status}`)
	check(known.json.error === '没有这张图', `错误信息丢了：${known.text}`)
	const bug = await call(boom, 'POST', '/plugins/dsh-tree/boom', '{}')
	// ⚠️ 这一条是有意义的：把自己的 bug 也回成 400，就等于告诉用户"你传错了"，
	//    然后没人会去看服务端日志。500 才是"我这边坏了"。
	check(bug.status === 500, `没预料到的异常应该 500，实际 ${bug.status}`)
	console.log(`  HttpError → 404「${known.json.error}」；TypeError → 500`)
}

console.log('用例 5：图片走原样字节，不许被 JSON 编码')
{
	const answer = await call(bytes, 'GET', '/plugins/dsh-tree/bytes')
	check(answer.status === 200, `状态码 ${answer.status}`)
	check(answer.headers['content-type'] === 'image/png', `content-type 是 ${answer.headers['content-type']}`)
	check(answer.text === '\x89P', `字节被动过了：${JSON.stringify(answer.text)}`)
	console.log('  PNG 头两个字节原样出去，content-type 是 image/png')
}

report()
