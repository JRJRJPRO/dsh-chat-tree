/**
 * 浏览器半和 host 半之间那条线（src/client/net.js）的用例。
 *
 * 【为什么要测这个】host 半的三条路由现在问宿主的 `connection` 要判决，那道闸是
 * **loopback-only** 的。手机在局域网里开的页面，Host 是局域网 IP，直连必然被拒 ——
 * 于是 `net.js` 要在被拒时改走 `remote-web-ui` 的 `/remote` 通道。
 *
 * 这条换路逻辑的失败方式全是静默的：
 *   · 不换路 → 手机上整棵树空白，控制台只有一行 401，没人知道该怎么办
 *   · 无脑换路 → 桌面端（没装 remote-web-ui）撞上 `/remote` 的 404，反而全挂
 *   · 换成了不记住 → 此后每次请求都多跑一个注定失败的来回
 *   · 换路也失败时把 `/remote` 的错还回去 → 用户看到 "404"，真正的原因
 *     （"没有登录凭据"）被盖掉了
 * 所以四件事各有一条断言钉着。
 *
 * ⚠️ `viaRemote` 是模块级状态、一旦钉住就不回头，所以用例**有顺序**：
 *    先测不该换路的情形，最后才测换路并锁定。
 *
 * @module test-net
 */

import { check, report } from './test-kit.mjs'

// ===== 第 1 步：把 fetch 换成记账的假货 =====

/** 每次调用记一笔 `{url, headers}`，答复由 `plan` 按顺序给。 */
const calls = []
let plan = []

globalThis.fetch = async (url, init) => {
	calls.push({ url: String(url), headers: (init && init.headers) || {} })
	const next = plan.shift()
	const status = next === undefined ? 200 : next
	return {
		ok: status >= 200 && status < 300,
		status,
		json: async () => (status >= 200 && status < 300 ? { fine: true } : { error: `说好的 ${status}` }),
	}
}

/** 每个用例开头清账。 */
function reset(statuses) {
	calls.length = 0
	plan = statuses.slice()
}

// sessionStorage 的替身：装着 remote-web-ui 那把免 cookie 设备凭据
globalThis.sessionStorage = {
	getItem: (key) => (key === 'dsh-remote-device' ? 'dev-42' : null),
}

const { apiPrefix, getJson, postJson } = await import('../src/client/net.js')

// ===== 第 2 步：用例 =====

console.log('用例 1：直连能通就不碰 /remote')
{
	reset([200])
	await getJson('/outlines', { cwd: 'D:/x' })
	check(calls.length === 1, `不该有第二次请求，实际发了 ${calls.length} 次`)
	check(calls[0].url === '/plugins/dsh-tree/outlines?cwd=D%3A%2Fx', `地址不对：${calls[0].url}`)
	check(apiPrefix() === '', '没换路时前缀必须是空的')
	console.log('  一次请求、原地址、前缀为空')
}

console.log('用例 2：404 / 500 不触发换路 —— 只有围栏那两个码才换')
{
	// ⚠️ 这条钉着"别对所有失败都换路"：404 是路由写错了，换条路照样 404，
	//    白跑一趟不说，还会把真正的错误信息换成 /remote 的那份。
	reset([404])
	await getJson('/shape').catch(() => {})
	check(calls.length === 1, `404 不该重试，实际发了 ${calls.length} 次`)
	reset([500])
	await getJson('/shape').catch(() => {})
	check(calls.length === 1, `500 不该重试，实际发了 ${calls.length} 次`)
	check(apiPrefix() === '', '404/500 之后不该换路')
	console.log('  404 和 500 都只发一次，前缀不变')
}

console.log('用例 3：换路也不通时，还回去的是【直连】那份错')
{
	// 直连 401（"没有登录凭据"）→ 试 /remote → 404（这台机器没装 remote-web-ui）。
	// 要是把 404 还回去，用户看到的是"路由不存在"，跟真正的原因差着十万八千里。
	reset([401, 404])
	const error = await getJson('/shape').then(
		() => undefined,
		(e) => e,
	)
	check(calls.length === 2, `应该试两次，实际 ${calls.length} 次`)
	check(String(error.message).includes('401'), `还回来的该是直连那份 401，实际是：${error.message}`)
	check(apiPrefix() === '', '换路没成功就不该记住')
	console.log('  试了两次；报的是 401 不是 404；没有误记')
}

console.log('用例 4：被围栏拒了就改走 /remote，成了就记住')
{
	reset([403, 200])
	await getJson('/outlines', { cwd: 'D:/x' })
	check(calls.length === 2, `应该先直连再换路，实际 ${calls.length} 次`)
	check(calls[0].url.startsWith('/plugins/'), `第一次该是直连：${calls[0].url}`)
	check(calls[1].url === '/remote/plugins/dsh-tree/outlines?cwd=D%3A%2Fx', `换路地址不对：${calls[1].url}`)
	// remote-web-ui 的 fetch 补丁只给它自己改写过的请求加设备头，
	// `/plugins/...` 不在它的名单里 —— 我们自己拼的这条得自己带上。
	check(calls[1].headers['x-dsh-remote-device'] === 'dev-42', '换路的请求要带上设备凭据')
	check(calls[0].headers['x-dsh-remote-device'] === undefined, '直连不该带设备头')
	check(apiPrefix() === '/remote', `换路成功后前缀该是 /remote，实际「${apiPrefix()}」`)

	// 记住了就别再试直连
	reset([200])
	await postJson('/shape', { a: 1 })
	check(calls.length === 1, `记住之后只该发一次，实际 ${calls.length} 次`)
	check(calls[0].url === '/remote/plugins/dsh-tree/shape', `地址不对：${calls[0].url}`)
	check(calls[0].headers['content-type'] === 'application/json', 'POST 的 content-type 不能在换路时掉了')
	console.log('  403 → 换路 → 带设备头 → 记住；此后只发一次')
}

report()
