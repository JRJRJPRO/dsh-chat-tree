/**
 * dsh-chat-tree —— 拆开被多个 DSH 会话共用的 Claude 会话（src/host/split.js）。
 *
 * 【导读】
 * 干嘛的：钉住"手抄 fork"这条修复路径的边界，全在临时目录里跑，不碰真实 home。
 *   · 锚点的祖先链按文件顺序完整抄出来，sessionId 改成新 id；断链就不抄
 *   · 只 fork 共用的；独占的不碰；没锚点 / 没记录文件 / 断链 → 报 stuck
 *   · 先写记录文件再改旁车；旁车只改 binding.claudeSessionId 并删 pending；binding 中途变了就跳过
 *   · 幂等：fork 完各自独占，第二遍没事可做
 *
 * 阅读顺序：第1步 造数据 → 第2步 用例 1 抄链 → 第3步 用例 2 规划 → 第4步 用例 3 落盘
 *
 * 跑法：node tests/test-split.mjs
 * @module test-split
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { check, report } from './test-kit.mjs'
import { applySplit, bucketOf, chainRecords, currentChain, forkTranscript, planSplit, readSidecarDir } from '../src/host/split.js'

// ===== 第1步：造数据 =====
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-chat-tree-split-'))
const name = (sessionId) => `${Buffer.from(sessionId).toString('base64url')}.json`
const CWD = 'D:\\x\\y'
const doc = (claudeSessionId, anchors) => ({
	schemaVersion: 1, revision: 3, activities: [{ kind: 'text', text: '留着别动' }],
	binding: { claudeSessionId, sdkVersion: '0.3.247', cwd: CWD },
	rewind: { ranges: [{ start: 1, end: 2 }], anchors, snapshots: [], pending: { resumeAt: anchors.length ? anchors[anchors.length - 1].uuid : 'x' } },
})
const write = (sessionId, document) => fs.writeFileSync(path.join(dir, name(sessionId)), `${JSON.stringify(document)}\n`)
// 一份"共用记录文件"：根 r → a1 → a2 → a3（分支 A）；a1 → b2 → b3（分支 B，最后写的，所以当前链是 B）
const row = (uuid, parentUuid, type = 'assistant') => ({ uuid, parentUuid, type, sessionId: 'claude-S', message: { role: type } })
const shared = [
	{ type: 'queue-operation', sessionId: 'claude-S' }, // 无 uuid 的元数据，不该进 fork
	row('r', null, 'user'), row('a1', 'r'), row('a2', 'a1'), row('a3', 'a2'), row('b2', 'a1'), row('b3', 'b2'),
]
const transcripts = new Map([['claude-S', shared], ['claude-Solo', [row('r', null, 'user'), row('s1', 'r')]]])
const io = {
	transcriptOf: (id) => transcripts.get(id),
	transcriptPathOf: (id, cwd) => path.join(dir, 'projects', bucketOf(cwd), `${id}.jsonl`),
}
write('session-A', doc('claude-S', [{ turn: 1, uuid: 'a1' }, { turn: 2, uuid: 'a2' }, { turn: 3, uuid: 'a3' }]))
write('session-B', doc('claude-S', [{ turn: 1, uuid: 'a1' }, { turn: 2, uuid: 'b2' }, { turn: 3, uuid: 'b3' }]))
write('session-C', doc('claude-S', [])) // 一轮没跑过
write('session-D', doc('claude-S', [{ turn: 9, uuid: 'zzz' }])) // 锚点不在文件里
write('session-E', doc('claude-Missing', [{ turn: 1, uuid: 'a1' }])) // 独占（没人和它共用）
write('session-F', doc('claude-Solo', [{ turn: 1, uuid: 's1' }])) // 独占
write('session-Z', { ...doc('claude-S', [{ turn: 1, uuid: 'a1' }]), schemaVersion: 2 })

// ===== 第2步：用例 1 =====
{
	console.log('用例 1：抄链 —— 祖先链按文件顺序完整抄出，不在当前链上也抄得出来')
	check([...currentChain(shared)].sort().join() === 'a1,b2,b3,r', `当前链该是 B 那条，实际 ${[...currentChain(shared)].sort().join()}`)
	const a3 = chainRecords(shared, 'a3')
	check(a3 !== undefined && a3.map((r) => r.uuid).join() === 'r,a1,a2,a3', `a3 的祖先链该是 r,a1,a2,a3，实际 ${a3 && a3.map((r) => r.uuid).join()}`)
	check(!a3.some((r) => r.type === 'queue-operation'), '无 uuid 的元数据混进了链')
	const forked = forkTranscript(shared, 'a3', 'NEW')
	check(forked.count === 4 && forked.last === 'a3', 'fork 出来该 4 条、末条是锚点')
	check(forked.text.split('\n').filter(Boolean).every((line) => JSON.parse(line).sessionId === 'NEW'), 'sessionId 没全改成新 id')
	check(JSON.parse(forked.text.split('\n')[0]).parentUuid === null, '首条该是根（parentUuid null）')
	check(chainRecords(shared, 'zzz') === undefined, '锚点不在文件里该是 undefined')
	check(chainRecords([row('x', 'ghost')], 'x') === undefined, '断链（祖先缺失）该是 undefined，不许抄半条')
	check(chainRecords([row('p', 'q'), row('q', 'p')], 'p') === undefined, '成环该是 undefined')
	check(bucketOf('D:\\JRJ\\DeepSeek-Harness\\INIT') === 'D--JRJ-DeepSeek-Harness-INIT', 'Claude 的记录桶名算错了')
	console.log('  a3 不在当前链上，祖先链照样抄出 r,a1,a2,a3；断链 / 成环 / 缺锚点一律不抄')
}

// ===== 第3步：用例 2 =====
let plan
{
	console.log('用例 2：规划 —— 共用的每条都 fork，独占不碰，三种卡住报出来')
	const entries = readSidecarDir(dir)
	plan = planSplit(entries, io.transcriptOf)
	const forkOf = Object.fromEntries(plan.fork.map((s) => [s.sessionId, s]))
	check(Object.keys(forkOf).sort().join() === 'session-A,session-B', `该 fork A、B，实际 ${Object.keys(forkOf).sort().join()}`)
	check(forkOf['session-A'].anchor === 'a3' && forkOf['session-B'].anchor === 'b3', '该从各自最后一个锚点 fork')
	check(forkOf['session-A'].newId !== forkOf['session-B'].newId && /^[0-9a-f-]{36}$/.test(forkOf['session-A'].newId), '新 id 该是各不相同的 uuid')
	const stuck = Object.fromEntries(plan.stuck.map((s) => [s.sessionId, s.why]))
	check(stuck['session-C'] === 'no-anchor' && stuck['session-D'] === 'broken-chain', `C/D 该分别报 no-anchor / broken-chain，实际 ${JSON.stringify(stuck)}`)
	check(!('session-E' in forkOf) && !('session-E' in stuck) && !('session-F' in forkOf), '独占的 E/F 不该被碰')
	check(!('session-Z' in forkOf) && !('session-Z' in stuck), 'schema 版本不对的不认')
	console.log(`  fork ${plan.fork.length} 条 / 卡住 ${plan.stuck.length} 条 / 共用组 ${plan.groups.length} 个`)
}

// ===== 第4步：用例 3 =====
{
	console.log('用例 3：落盘 —— 先写记录文件再改旁车；只改 binding 和 pending；binding 变了就跳过；幂等')
	const entries = readSidecarDir(dir)
	// 规划之后、落盘之前，B 的 binding 被别人改了
	const bFile = path.join(dir, name('session-B'))
	const bDoc = JSON.parse(fs.readFileSync(bFile, 'utf8'))
	bDoc.binding.claudeSessionId = 'claude-Other'
	fs.writeFileSync(bFile, `${JSON.stringify(bDoc)}\n`)
	const result = applySplit(entries, plan, io)
	check(result.written.length === 1 && result.written[0].sessionId === 'session-A' && result.written[0].count === 4, `该只写 A（4 条），实际 ${JSON.stringify(result.written)}`)
	check(result.skipped.length === 1 && result.skipped[0].why === 'binding-changed', 'B 的 binding 中途变了，该跳过')
	const stepA = plan.fork.find((s) => s.sessionId === 'session-A')
	const newFile = io.transcriptPathOf(stepA.newId, CWD)
	check(fs.existsSync(newFile), '新记录文件没写出来')
	check(newFile.includes(path.join('projects', 'D--x-y')), `记录文件该落在按 cwd 算的桶里，实际 ${newFile}`)
	const after = JSON.parse(fs.readFileSync(path.join(dir, name('session-A')), 'utf8'))
	check(after.binding.claudeSessionId === stepA.newId && after.binding.cwd === CWD && after.binding.sdkVersion === '0.3.247', 'A 的 binding 该只换 claudeSessionId')
	check(after.rewind.pending === undefined, 'pending 该删掉 —— 新文件只有一条链，直接续叶子')
	check(after.activities[0].text === '留着别动' && after.revision === 3 && after.rewind.anchors.length === 3 && JSON.stringify(after.rewind.ranges) === '[{"start":1,"end":2}]', 'A 除了 binding/pending 之外有字段被动了')
	// 幂等：A 已独占，B 指向 claude-Other 也独占 → 第二遍无事可做
	const again = planSplit(readSidecarDir(dir), io.transcriptOf)
	check(again.fork.length === 0, `第二遍不该还有要 fork 的，实际 ${again.fork.length}`)
	console.log(`  写 ${result.written.length} / 跳过 ${result.skipped.length}；第二遍 0 条待 fork`)
}

fs.rmSync(dir, { recursive: true, force: true })
report()
