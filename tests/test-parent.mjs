/**
 * dsh-chat-tree —— 分支血缘的补记。
 *
 * 【为什么单测这个】桌面版 0.2.2-rc.1 的 `session.fork` 不写 `parentSession`
 * （见 src/host/parents.js 开头），分支树能不能接回父对话全靠这一份补记。
 * 它错了不会报错，只会让树悄悄少半截 —— 所以三条规矩各钉一遍：
 *   ① `parents.json` 读写（坏文件退回空白、原子写、拒绝自环）；
 *   ② 没有记录时按继承前缀猜父亲（轮次号 + turn/start 的 seq + 提问预览）；
 *   ③ `resolveParents` 的优先级：先信自己记的，再猜；认不得的父会话、环，一律断开。
 * 全在临时 DSH_HOME 里跑，不碰真实数据。
 *
 * 跑法：node tests/test-parent.mjs
 * @module test-parent
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { check, report } from './test-kit.mjs'

const was = process.env.DSH_HOME
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-chat-tree-parents-'))
process.env.DSH_HOME = home
const { EMPTY_PARENTS, parentsPath, readParents, rememberParent, inferParent, resolveParents } = await import('../src/host/parents.js')

/** 造一条 collect 形状的会话。 */
const session = (id, createdAt, turns, extra) => Object.assign({ id, createdAt, turns, isSeeded: true }, extra)

/** 造一轮大纲。 */
const turn = (no, seq, prompt, inherited) =>
	Object.assign({ turn: no, seq, prompt }, inherited === true ? { inherited: true } : {})

try {
	console.log('用例 1：没有文件 → 空白，不崩')
	check(JSON.stringify(readParents()) === JSON.stringify(EMPTY_PARENTS), '没有 parents.json 该是空白')

	console.log('用例 2：记一笔就落盘，读回来一模一样')
	const doc = rememberParent({ session: 'session-child', parent: 'session-parent' })
	check(doc.parents['session-child'] === 'session-parent', '返回的文档里该有这一条')
	check(JSON.parse(fs.readFileSync(parentsPath(), 'utf8')).parents['session-child'] === 'session-parent', '该真的落盘')
	check(JSON.stringify(readParents().parents) === JSON.stringify({ 'session-child': 'session-parent' }), '读回来该一模一样')

	console.log('用例 3：坏文件 / 版本不对 / 脏条目 → 退回空白或只留干净的那几条')
	fs.writeFileSync(parentsPath(), '{not json')
	check(JSON.stringify(readParents()) === JSON.stringify(EMPTY_PARENTS), '坏 JSON 该退回空白')
	fs.writeFileSync(parentsPath(), JSON.stringify({ version: 2, parents: { a: 'b' } }))
	check(JSON.stringify(readParents()) === JSON.stringify(EMPTY_PARENTS), '版本不对该退回空白')
	fs.writeFileSync(parentsPath(), JSON.stringify({ version: 1, parents: { a: 'a', '': 'x', b: 3, c: 'd' } }))
	check(JSON.stringify(readParents().parents) === JSON.stringify({ c: 'd' }), `自环 / 空 key / 非字符串都该丢掉，实际 ${JSON.stringify(readParents().parents)}`)

	console.log('用例 4：空 id、自环一律拒绝')
	const rejects = (run) => {
		try {
			run()
			return false
		} catch {
			return true
		}
	}
	check(rejects(() => rememberParent({ session: '', parent: 'p' })), '空 child 该拒绝')
	check(rejects(() => rememberParent({ session: 'c', parent: '' })), '空 parent 该拒绝')
	check(rejects(() => rememberParent({ session: 'c', parent: 'c' })), '自己当父亲该拒绝')
	check(rejects(() => rememberParent(undefined)), 'undefined 该拒绝')

	console.log('用例 5：没有记录时按继承前缀猜父亲')
	const parent = session('session-p', 100, [turn(1, 4, '甲'), turn(2, 9, '乙'), turn(3, 30, '丙')])
	const child = session('session-c', 300, [turn(1, 4, '甲', true), turn(2, 9, '乙', true), turn(3, 50, '丁')])
	// 轮次号一样、seq 和提问不一样：不是它父亲
	const decoy = session('session-d', 200, [turn(1, 4, '甲'), turn(2, 11, '乙'), turn(3, 40, '戊')])
	check(inferParent(child, [parent, decoy, child]) === 'session-p', 'seq 与提问都对得上的才是父亲')
	check(inferParent(child, [decoy, child]) === undefined, '对不上就猜不出，别乱认')
	const later = session('session-late', 400, [turn(1, 4, '甲'), turn(2, 9, '乙')])
	check(inferParent(child, [parent, later, child]) === 'session-p', '比孩子晚出生的不许当父亲')
	check(inferParent(session('session-x', 500, [turn(1, 1, '甲')]), [parent]) === undefined, '没有继承轮就没有可猜的')

	console.log('用例 6：resolveParents 只补该补的，猜到的落盘，下回不再猜')
	fs.rmSync(parentsPath(), { force: true })
	const p = session('session-p2', 100, [turn(1, 4, '甲'), turn(2, 9, '乙')])
	const c = session('session-c2', 300, [turn(1, 4, '甲', true), turn(2, 9, '乙', true), turn(3, 50, '丁')])
	const linked = session('session-linked', 500, [], { parentId: 'session-elsewhere' })
	const fixed = resolveParents([p, c, linked])
	check(c.parentId === 'session-p2', `没有记录时该按继承前缀补上，实际 ${String(c.parentId)}`)
	check(fixed === 1, `该补 1 条，实际 ${fixed}`)
	check(JSON.parse(fs.readFileSync(parentsPath(), 'utf8')).parents['session-c2'] === 'session-p2', '猜出来的该落盘')
	check(linked.parentId === 'session-elsewhere', '已经带 parentId 的一律不动')

	console.log('用例 7：自己记过的优先，记的父会话不在了就别硬连')
	fs.rmSync(parentsPath(), { force: true })
	const p3 = session('session-p3', 100, [turn(1, 4, '甲')])
	const c3 = session('session-c3', 300, [turn(1, 4, '甲', true)])
	rememberParent({ session: 'session-c3', parent: 'session-p3' })
	resolveParents([p3, c3])
	check(c3.parentId === 'session-p3', '自己记过的该直接用')
	const p4 = session('session-p4', 100, [turn(1, 4, '甲')])
	const c4 = session('session-c4', 300, [turn(1, 4, '甲', true)])
	rememberParent({ session: 'session-c4', parent: 'session-gone' })
	resolveParents([p4, c4])
	check(c4.parentId !== 'session-gone', '父会话已经不在了就别硬连')

	console.log('用例 8：补出来的父链不许有环')
	fs.rmSync(parentsPath(), { force: true })
	const a = session('session-a', 100, [])
	const b = session('session-b', 200, [])
	rememberParent({ session: 'session-a', parent: 'session-b' })
	rememberParent({ session: 'session-b', parent: 'session-a' })
	resolveParents([a, b])
	const byId = new Map([[a.id, a], [b.id, b]])
	const seen = new Set()
	let at = a.parentId
	let looped = false
	while (typeof at === 'string') {
		if (seen.has(at)) {
			looped = true
			break
		}
		seen.add(at)
		at = byId.get(at) === undefined ? undefined : byId.get(at).parentId
	}
	check(!looped, `补出来的父链不许有环，实际 a→${String(a.parentId)} b→${String(b.parentId)}`)

	console.log('用例 9：collect 真的会把补出来的父亲写进 /outlines 的响应体')
	const parentEvents = [
		{ type: 'session', id: 'session-p5', cwd: '/w', createdAt: 100 },
		{ seq: 0, type: 'turn/start', data: { turn: 1 } },
		{ seq: 1, type: 'user/message', data: { content: [{ type: 'text', text: '甲' }], source: { kind: 'user' } } },
		{ seq: 2, type: 'assistant/message', data: { content: [{ type: 'text', text: '答' }] } },
		{ seq: 3, type: 'turn/end', data: { reason: { kind: 'completed' } } },
	]
	// 子会话：header 故意**没有 parentSession**（桌面版 0.2.2 的 fork 就是这样），
	// 前面 4 条是逐字节抄来的前缀，end-seed 之后才是自己的轮次。
	const childEvents = [
		{ type: 'session', id: 'session-c5', cwd: '/w', createdAt: 200, isSeeded: true },
		...parentEvents.slice(1),
		{ seq: 4, type: 'session/end-seed', data: { inherited: true } },
	]
	fs.rmSync(parentsPath(), { force: true })
	const logs = { 'session-p5': parentEvents, 'session-c5': childEvents }
	const ctx = {
		sessionPersistence: {
			list: async () => [{ header: parentEvents[0], revision: 'r-p' }, { header: childEvents[0], revision: 'r-c' }],
			open: async (id) => ({ read: async () => ({ events: logs[id] }), close: async () => {} }),
		},
		logger: { info() {}, warn() {} },
	}
	const { collect } = await import('../src/host/collect.js')
	const body = await collect(ctx, '/w')
	const got = body.sessions.find((item) => item.id === 'session-c5')
	check(got !== undefined && got.parentId === 'session-p5', `/outlines 里这条分支该带上父亲，实际 ${JSON.stringify(got && got.parentId)}`)

	console.log('用例 10：原子写不留 .tmp')
	const leftovers = fs.readdirSync(path.join(home, 'plugins', 'dsh-chat-tree')).filter((name) => name.endsWith('.tmp'))
	check(leftovers.length === 0, `留下了临时文件：${leftovers.join(', ')}`)
} finally {
	if (was === undefined) delete process.env.DSH_HOME
	else process.env.DSH_HOME = was
	fs.rmSync(home, { recursive: true, force: true })
}

report()
