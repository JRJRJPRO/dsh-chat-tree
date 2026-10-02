/**
 * dsh-chat-tree —— 开岔路的切点、空壳轮、以及 0.2 宿主上树为什么刷得慢。
 *
 * 【导读】
 * 干嘛的：John 在桌面版（dsh 0.2.0-rc.2）报的三件事 —— 分叉就失忆、树和实际对话对不上、
 * 树画出来有延迟。三件事的根都在"两代宿主接口同名不同义"：
 *   · `fork({atSeq})`：0.1.5 取"≥ atSeq 的第一个 turn/end"做边界；0.2 把 atSeq 当精确切点。
 *     插件以前传 turn/start 的 seq，在 0.2 上新分支就只抄到 turn/start，提问和回答都没抄到。
 *   · 切进一轮中间时，0.2 补一条 `{kind:'forked'}` 的 turn/end 把它合上 —— 新分支头上多出一个
 *     没有提问的空壳轮，树把岔路点画在它身上，模型实际只记得到上一轮。
 *   · `sessions.list` 的 `updatedAt`：0.1.5 跟日志走，0.2 只在用户发消息时推进。
 *     以它当重拉指纹，一轮答完树不动，要等下一句。
 *
 * 阅读顺序：
 *   第1步  取两半的真函数
 *   第2步  用例 1：切点 —— 传 turn/end，没有就退回 turn/start
 *   第3步  用例 2-3：空壳轮 —— 从盘上那条真实分支（2026-10-01，TEST 桶）复刻的日志
 *   第4步  用例 4-6：重拉指纹 / 在跑的条数 / 跑完之后的补拉
 *
 * 跑法：node tests/test-cut.mjs
 *
 * @module test-cut
 */

import { check, loadClientPure, report } from './test-kit.mjs'
import { foldOutline, __test } from '../index.js'

// ===== 第 1 步：取两半的真函数 =====

const pure = await loadClientPure()
const { forkCutSeq, listStamp, runningCount, settleDelay, tagOutlines, Z } = pure
const { cacheKeyOf } = __test

// ===== 第 2 步：用例 1 —— 切点 =====

console.log('用例 1：开岔路的切点是这一轮的 turn/end；还没答完就退回 turn/start')
check(forkCutSeq({ turn: 3, seq: 33, endSeq: 40 }) === 40, '有 turn/end 就传 turn/end（0.2 按精确切点抄，整轮才抄得到）')
check(forkCutSeq({ turn: 3, seq: 33 }) === 33, '没有 turn/end（还在跑）退回 turn/start')
check(forkCutSeq({ turn: 3, seq: 33, endSeq: Number.NaN }) === 33, 'endSeq 不是数就当没有')
check(forkCutSeq(undefined) === undefined, '没有轮次就 undefined')

// ===== 第 3 步：用例 2-3 —— 空壳轮 =====

/**
 * 复刻盘上 `session-054a5154`（从 `session-0b66814b` 第 1 轮的 turn/start 处切出来的分支）：
 * 继承段只有 inbox 入队 + turn/start，接着是 end-seed，然后是宿主补的 `forked` turn/end。
 * 之后分支自己跑了第 2 轮。
 */
function stubChild() {
	const human = (text) => ({ content: [{ type: 'text', text }], source: { kind: 'user' }, role: 'user' })
	return [
		{ type: 'agent/inbox/spliced', seq: 5, data: { target: 'next-turn', start: 0, inserted: [{ ...human('在吗'), id: 'm1' }] } },
		{ type: 'turn/start', seq: 6, data: { turn: 1 } },
		{ type: 'session/end-seed', seq: 7, data: { inherited: true } },
		{ type: 'turn/end', seq: 8, data: { turn: 1, reason: { kind: 'forked' } } },
		{ type: 'turn/start', seq: 12, data: { turn: 2 } },
		{ type: 'user/message', seq: 16, data: human('累加3呢'), surfaceOp: 'append' },
		{ type: 'assistant/message', seq: 22, data: { turn: 2, message: { role: 'assistant', content: [{ type: 'text', text: '没有上下文' }] } }, surfaceOp: 'append' },
		{ type: 'turn/end', seq: 30, data: { turn: 2, reason: { kind: 'completed' } } },
	]
}

console.log('用例 2：0.2 宿主补出来的空壳轮（forked 且没有提问）不进大纲，岔路点不落在它身上')
{
	const outline = foldOutline(stubChild())
	check(outline.turns.length === 1, `空壳轮被剔掉，只剩自己那一轮（实际 ${outline.turns.length}）`)
	check(outline.turns[0] && outline.turns[0].turn === 2 && outline.turns[0].inherited === false, '剩下的是第 2 轮，且是自有的')
	check(outline.forkTurn === undefined, '继承段里没有一轮完整的 —— 岔路点 undefined（成图退到父分支自己的挂载点 / 根）')
	check(outline.seeded === true, 'end-seed 在，所以不是半成品：seeded=true，outlineOf 该照常缓存')
}

console.log('用例 3：切在提问之后的半截轮不是空壳 —— 有提问就留着；别的 reason 也不剔')
{
	const human = (text) => ({ content: [{ type: 'text', text }], source: { kind: 'user' }, role: 'user' })
	const events = [
		{ type: 'turn/start', seq: 1, data: { turn: 1 } },
		{ type: 'user/message', seq: 2, data: human('第一问'), surfaceOp: 'append' },
		{ type: 'turn/end', seq: 3, data: { turn: 1, reason: { kind: 'completed' } } },
		{ type: 'turn/start', seq: 4, data: { turn: 2 } },
		{ type: 'user/message', seq: 5, data: human('第二问'), surfaceOp: 'append' },
		{ type: 'session/end-seed', seq: 6, data: { inherited: true } },
		{ type: 'turn/end', seq: 7, data: { turn: 2, reason: { kind: 'forked' } } },
		{ type: 'turn/start', seq: 8, data: { turn: 3 } },
		{ type: 'turn/end', seq: 9, data: { turn: 3, reason: { kind: 'aborted' } } },
	]
	const outline = foldOutline(events)
	check(outline.turns.map((entry) => entry.turn).join(',') === '1,2,3', `有提问的 forked 半截轮和 aborted 轮都留着（实际 ${outline.turns.map((entry) => entry.turn).join(',')}）`)
	check(outline.turns[1].done === false && outline.turns[1].endReason === 'forked', '半截轮：done=false，endReason=forked')
	check(outline.forkTurn === 2, '岔路点落在那条半截轮上（它在继承段里）')
	const plain = foldOutline(events.slice(0, 3))
	check(plain.seeded === false && plain.forkTurn === undefined, '没有 end-seed：seeded=false')
}

// ===== 第 4 步：用例 4-6 —— 重拉指纹 =====

console.log('用例 4：会话列表的指纹要把 running / completed 算进去（0.2 的 updatedAt 不跟回答走）')
{
	const base = { ids: ['a', 'b'], byId: { a: { updatedAt: 10 }, b: { updatedAt: 20 } } }
	const running = { ids: ['a', 'b'], byId: { a: { updatedAt: 10, running: true }, b: { updatedAt: 20 } } }
	const done = { ids: ['a', 'b'], byId: { a: { updatedAt: 10, completed: true }, b: { updatedAt: 20 } } }
	check(listStamp(base) !== listStamp(running), '一轮开始（running 翻成 true）指纹要变')
	check(listStamp(running) !== listStamp(base), '一轮结束（running 翻回 false）指纹要变')
	check(listStamp(done) !== listStamp(base), '跑完未读（completed）指纹要变')
	check(listStamp(base) === listStamp({ ids: ['a', 'b'], byId: { a: { updatedAt: 10 }, b: { updatedAt: 20 } } }), '内容一样指纹一样，别白刷')
	check(listStamp(undefined) === '' && listStamp({}) === '0:undefined:', '没有快照 / 空快照不崩')
	const moved = { ids: ['a', 'b'], byId: { a: { updatedAt: 11 }, b: { updatedAt: 20 } } }
	check(listStamp(moved) !== listStamp(base), '0.1.5 的老路（updatedAt 动了）照样触发')
}

console.log('用例 5：在跑的条数')
check(runningCount({ ids: ['a', 'b', 'c'], byId: { a: { running: true }, b: {}, c: { running: true } } }) === 2, '数对 running=true 的')
check(runningCount(undefined) === 0 && runningCount({ ids: ['x'], byId: {} }) === 0, '没有快照 / 列表项缺失 → 0')

console.log('用例 6：有会话刚跑完才补拉一次；开始跑、没变化、没有数都不补')
check(settleDelay(1, 0) === Z.settleMs && Z.settleMs > 0, `1 → 0：等 ${Z.settleMs}ms 再拉一次（日志落盘比状态表慢半拍）`)
check(settleDelay(2, 1) === Z.settleMs, '2 → 1 也补')
check(settleDelay(0, 1) === 0, '0 → 1（开始跑）不补：turn/start 早就写好了')
check(settleDelay(1, 1) === 0, '没变化不补')
check(settleDelay(undefined, 0) === 0 && settleDelay(1, undefined) === 0, '没有数不补')

// ===== 第 5 步：用例 7-8 —— 切目录时树为什么卡在旧的 =====

console.log('用例 7：大纲缓存键去掉 0.2 宿主给 v3 会话附加的语料库哈希（任何会话一写盘它就变）')
{
	const file = '2049:281474976711113:9502:1759146585123456789:1759146585123456789'
	const corpus = 'a'.repeat(32) + '0123456789abcdef0123456789abcdef'
	check(cacheKeyOf(`${file}:${corpus}`) === file, 'v3 会话：`<文件 stat>:<sha256>` → 只留文件 stat')
	check(cacheKeyOf(file) === file, 'v4 会话：没有那截哈希，原样')
	check(cacheKeyOf(`${file}:${corpus.slice(0, 63)}`) === `${file}:${corpus.slice(0, 63)}`, '不是 64 位十六进制就不动（别误伤别的格式）')
	check(cacheKeyOf(`memory:web:7`) === 'memory:web:7', '内存后端的 revision 原样')
	check(cacheKeyOf(undefined) === undefined, '没有 revision 不崩')
}

console.log('用例 8：大纲盖上目录；Rail 据此分清"没数据"和"数据是别的目录的"')
{
	const body = { sessions: [{ id: 'a' }], shape: {} }
	const tagged = tagOutlines(body, 'D:\\x')
	check(tagged.cwd === 'D:\\x' && tagged.sessions === body.sessions, '盖上 cwd，别的字段原样')
	check(body.cwd === undefined, '不改传入的对象')
	check(tagOutlines(undefined, 'D:\\x') === undefined, '没有 body 原样返回')
}

report()
