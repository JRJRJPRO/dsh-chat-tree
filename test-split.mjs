/**
 * dsh-tree —— 拆开被多个 DSH 会话共用的 Claude 会话（src/host/split.js）。
 *
 * 【导读】
 * 干嘛的：钉住 planSplit / applySplit 的四条边界，全在临时目录里跑，不碰真实 home。
 *   · 只挑"被不止一条会话绑着 + 没武装 pending"的；已武装的、独占的一律不动
 *   · 武装成**它自己**最后一个锚点，不是别人的
 *   · 有 binding 但没锚点 → 报 stuck，不瞎武装
 *   · 落盘只补 pending，其它字段一个字节不动；写前复核，别人刚种的 pending 不覆盖
 *
 * 阅读顺序：
 *   第1步  造一批假旁车
 *   第2步  用例 1：规划
 *   第3步  用例 2：落盘与复核
 *
 * 跑法：node test-split.mjs
 *
 * @module test-split
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { check, report } from './test-kit.mjs'
import { applySplit, planSplit, readSidecarDir } from './src/host/split.js'

// ===== 第1步：造一批假旁车 =====

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-tree-split-'))
const name = (sessionId) => `${Buffer.from(sessionId).toString('base64url')}.json`
const anchor = (turn, uuid) => ({ turn, uuid })
const doc = (claudeSessionId, anchors, extra) => ({
	schemaVersion: 1,
	revision: 3,
	activities: [{ kind: 'text', text: '留着别动' }],
	binding: { claudeSessionId, sdkVersion: '0.3.247', cwd: 'D:/x' },
	rewind: { ranges: [{ start: 1, end: 2 }], anchors, snapshots: [] },
	...extra,
})
const write = (sessionId, document) => fs.writeFileSync(path.join(dir, name(sessionId)), `${JSON.stringify(document)}\n`)

// 共用 A 的三条：一条已武装、两条没武装（各自锚点不同）
write('session-a1', doc('claude-A', [anchor(1, 'a1-t1'), anchor(2, 'a1-t2')], { rewind: { ranges: [], anchors: [anchor(1, 'a1-t1')], snapshots: [], pending: { resumeAt: 'a1-t1' } } }))
write('session-a2', doc('claude-A', [anchor(1, 'a2-t1'), anchor(5, 'a2-t5')]))
write('session-a3', doc('claude-A', [anchor(3, 'a3-t3')]))
// 共用 B 的两条：一条有锚点，一条有 binding 但一轮没跑过
write('session-b1', doc('claude-B', [anchor(2, 'b1-t2')]))
write('session-b2', doc('claude-B', []))
// 独占 C：不该被碰
write('session-c1', doc('claude-C', [anchor(9, 'c1-t9')]))
// 版本不对的：不认
write('session-z1', { ...doc('claude-A', [anchor(1, 'z')]), schemaVersion: 2 })
// 坏 JSON：跳过
fs.writeFileSync(path.join(dir, name('session-bad')), '{not json')

// ===== 第2步：用例 1：规划 =====
{
	console.log('用例 1：只挑共用且没武装的，武装成自己的最后锚点')
	const entries = readSidecarDir(dir)
	check(entries.length === 7, `该读到 7 份（坏 JSON 跳过），实际 ${entries.length}`)
	const plan = planSplit(entries)

	const armed = Object.fromEntries(plan.arm.map((step) => [step.sessionId, step]))
	check(Object.keys(armed).sort().join() === 'session-a2,session-a3,session-b1', `该武装 a2/a3/b1，实际 ${Object.keys(armed).sort().join()}`)
	check(armed['session-a2'].resumeAt === 'a2-t5' && armed['session-a2'].turn === 5, 'a2 该武装成它自己的最后锚点 a2-t5')
	check(armed['session-a3'].resumeAt === 'a3-t3', 'a3 该武装成 a3-t3，不是别人的')
	check(armed['session-b1'].resumeAt === 'b1-t2', 'b1 该武装成 b1-t2')
	check(!('session-a1' in armed), '已武装的 a1 不许再动')
	check(!('session-c1' in armed), '独占 C 的 c1 不该被碰')
	check(!('session-z1' in armed), 'schema 版本不对的不认')

	check(plan.stuck.length === 1 && plan.stuck[0].sessionId === 'session-b2' && plan.stuck[0].why === 'no-anchor', `b2 该报 no-anchor，实际 ${JSON.stringify(plan.stuck)}`)
	check(plan.groups.length === 2, `该有两组共用，实际 ${plan.groups.length}`)
	console.log(`  武装 ${plan.arm.length} 条 / 卡住 ${plan.stuck.length} 条 / 共用组 ${plan.groups.length} 个`)
}

// ===== 第3步：用例 2：落盘与复核 =====
{
	console.log('用例 2：只补 pending，其它字节不动；写前复核')
	const entries = readSidecarDir(dir)
	const plan = planSplit(entries)
	// 规划之后、落盘之前，别人（比如 graft）给 a3 种了一个 pending
	const a3 = path.join(dir, name('session-a3'))
	const a3Doc = JSON.parse(fs.readFileSync(a3, 'utf8'))
	a3Doc.rewind.pending = { resumeAt: 'someone-else' }
	fs.writeFileSync(a3, `${JSON.stringify(a3Doc)}\n`)

	const result = applySplit(entries, plan)
	check(result.written.sort().join() === 'session-a2,session-b1', `该写 a2/b1，实际 ${result.written.sort().join()}`)
	check(result.skipped.length === 1 && result.skipped[0].sessionId === 'session-a3' && result.skipped[0].why === 'already-armed', 'a3 在落盘前被别人武装了，该跳过而不是覆盖')

	const after = JSON.parse(fs.readFileSync(path.join(dir, name('session-a2')), 'utf8'))
	check(after.rewind.pending.resumeAt === 'a2-t5', 'a2 的 pending 没写对')
	check(after.activities[0].text === '留着别动' && after.revision === 3 && after.binding.claudeSessionId === 'claude-A', 'a2 除了 pending 之外有字段被动了')
	check(JSON.stringify(after.rewind.ranges) === '[{"start":1,"end":2}]' && after.rewind.anchors.length === 2, 'a2 的 ranges / anchors 被动了')
	const untouched = JSON.parse(fs.readFileSync(path.join(dir, name('session-a3')), 'utf8'))
	check(untouched.rewind.pending.resumeAt === 'someone-else', 'a3 上别人种的 pending 被覆盖了')
	const c1 = JSON.parse(fs.readFileSync(path.join(dir, name('session-c1')), 'utf8'))
	check(c1.rewind.pending === undefined, '独占的 c1 不该被武装')
	// 幂等：再规划一次，什么都不剩
	const again = planSplit(readSidecarDir(dir))
	check(again.arm.length === 0, `再跑一遍不该还有要武装的，实际 ${again.arm.length}`)
	check(again.stuck.length === 1, 'b2 仍然卡住（它本来就武装不了）')
	console.log(`  写 ${result.written.length} / 跳过 ${result.skipped.length}；第二遍 0 条待武装`)
}

fs.rmSync(dir, { recursive: true, force: true })
report()
