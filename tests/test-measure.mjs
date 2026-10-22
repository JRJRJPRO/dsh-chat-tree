/**
 * dsh-chat-tree —— 测量节流（「便宜指纹」早退）。
 *
 * 【导读】
 * 干嘛的：Rail 是常驻 overlay，两个测量钩子（useChatBox / useActiveTurn）在任何界面、
 * 每个标签页里都在轮询。以前是 800ms + 400ms 两个 setInterval，**每次**都逐行
 * `getBoundingClientRect`、还要做 4 次 `elementFromPoint`；现在先用「便宜指纹」比一下，
 * 没变就整轮跳过，页面不可见时连下一次都不排（hooks.js 的 sceneKeyOf / pollDelay）。
 *
 * 这里钉三件事：
 *   1. sceneKeyOf：版面一动就会换指纹的字段（尺寸 / 顶边 / 变更计数 / 滚动）必须换；
 *      亚像素抖动不换（否则每个 token 都要重量）。
 *   2. pollDelay：页面不可见 → 0（不排下一次）。
 *   3. 生成物里不许再回到 `setInterval(measure)`：回到定时器硬轮询，这层保护就没了。
 *
 * 跑法：node tests/test-measure.mjs
 *
 * @module test-measure
 */

import { readFileSync } from 'node:fs'
import { check, loadClientPure, report } from './test-kit.mjs'

const pure = await loadClientPure()
const { sceneKeyOf, pollDelay } = pure

console.log('用例 1：便宜指纹 —— 版面一动就必须换')
{
	const base = { top: 10, scrollHeight: 2000, clientHeight: 800, clientWidth: 640, mutations: 3 }
	check(sceneKeyOf(base) === sceneKeyOf({ ...base }), '同样输入两次，指纹相同（空闲时才能一直早退）')
	check(sceneKeyOf(base) !== sceneKeyOf({ ...base, clientWidth: 520 }), '拖动带子 / 侧栏开合改了 BFC 宽度 → 换指纹')
	check(sceneKeyOf(base) !== sceneKeyOf({ ...base, scrollHeight: 2100 }), '流式输出让内容变高 → 换指纹')
	check(sceneKeyOf(base) !== sceneKeyOf({ ...base, clientHeight: 700 }), '窗口变矮 → 换指纹')
	check(sceneKeyOf(base) !== sceneKeyOf({ ...base, top: 40 }), '宿主加了横幅、容器顶边下移 → 换指纹')
	check(sceneKeyOf(base) !== sceneKeyOf({ ...base, mutations: 4 }), '加行 / 换页签（变更计数 +1）→ 换指纹')
	check(sceneKeyOf(base) !== sceneKeyOf({ ...base, scrollTop: 120 }), '滚动（useActiveTurn 会传 scrollTop）→ 换指纹')
}
console.log('用例 2：指纹容差 —— 亚像素抖动不算版面变了')
{
	const a = { top: 10.04, scrollHeight: 2000.02, clientHeight: 800, clientWidth: 640, mutations: 0 }
	const b = { top: 10.0, scrollHeight: 2000.0, clientHeight: 800, clientWidth: 640, mutations: 0 }
	check(sceneKeyOf(a) === sceneKeyOf(b), '0.04px 的抖动算同一版面（否则每个 token 都要重量）')
	check(sceneKeyOf(undefined) === '', '没有状态 → 空串')
}
console.log('用例 3：可见性 —— 页面不可见就不排下一次')
{
	check(pollDelay(true, 1500) === 0, 'document.hidden → 0（不排定时器）')
	check(pollDelay(false, 1500) === 1500, '可见 → 用基础间隔')
	check(pollDelay(false, undefined) === 0, '间隔非法 → 0')
	check(pollDelay(false, 0) === 0, '间隔 0 → 0')
}
console.log('用例 4：生成物里不许再回到 setInterval 硬轮询')
{
	const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
	check(!/setInterval\(\s*measure/.test(source), 'client.js 里不再有 setInterval(measure)')
	check(/scanMs/.test(source) && /turnMs/.test(source), 'client.js 里带着新的轮询间隔常量')
}

report()
