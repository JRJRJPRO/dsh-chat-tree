/**
 * dsh-chat-tree —— 标注（改名 / 收藏 / 图标 / 颜色）存在宿主这边。
 *
 * 【导读】钉住 host 半 labels.json 的读写：坏文件退回空白、补丁按四种语义合并、
 * 恢复默认是删掉那一条、原子写不留半截。全在临时 DSH_HOME 里跑。
 *
 * 跑法：node tests/test-labels.mjs
 * @module test-labels
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { check, report } from './test-kit.mjs'

const was = process.env.DSH_HOME
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-chat-tree-labels-'))
process.env.DSH_HOME = home
const { readLabels, patchLabels, labelsPath, EMPTY_LABELS } = await import('../src/host/labels.js')

try {
	console.log('用例 1：没有文件 / 坏文件 / 版本不对 → 空白，不崩')
	check(JSON.stringify(readLabels()) === JSON.stringify(EMPTY_LABELS), '没有文件该退回空白')
	fs.mkdirSync(path.dirname(labelsPath()), { recursive: true })
	fs.writeFileSync(labelsPath(), '{not json')
	check(JSON.stringify(readLabels()) === JSON.stringify(EMPTY_LABELS), '坏 JSON 该退回空白')
	fs.writeFileSync(labelsPath(), JSON.stringify({ version: 2, labels: { a: 'x' } }))
	check(Object.keys(readLabels().labels).length === 0, '版本不对该退回空白')
	fs.unlinkSync(labelsPath())

	console.log('用例 2：四种补丁各按各的语义合并')
	let doc = patchLabels({ labels: { 'S:1': '开头', 'S:2': '第二轮' }, favorites: { 'S:1': true, 'S:3': true }, favIcons: { 'S:1': 'char:甲' }, favColors: { 'S:1': '#FFD43B' } })
	check(doc.labels['S:1'] === '开头' && doc.labels['S:2'] === '第二轮', '改名没存进去')
	check(doc.favorites.sort().join() === 'S:1,S:3', `收藏该是 S:1,S:3，实际 ${doc.favorites.join()}`)
	check(doc.favIcons['S:1'] === 'char:甲', '图标没存进去')
	check(doc.favColors['S:1'] === '#ffd43b', '颜色该归一成小写')
	doc = patchLabels({ labels: { 'S:2': '' }, favorites: { 'S:3': false }, favIcons: { 'S:1': 'star' }, favColors: { 'S:1': 'red' } })
	check(!('S:2' in doc.labels) && doc.labels['S:1'] === '开头', '空串该删掉那一条，别的不动')
	check(doc.favorites.join() === 'S:1', '取消收藏该从清单里去掉')
	check(!('S:1' in doc.favIcons), "恢复默认（'star'）该删掉那一条，不是存一个 star")
	check(!('S:1' in doc.favColors), '认不得的颜色该当恢复默认，删掉那一条')
	check(JSON.stringify(readLabels()) === JSON.stringify(doc), '写完再读该一模一样')
	check(!fs.readdirSync(path.dirname(labelsPath())).some((name) => name.endsWith('.tmp')), '原子写留下了 .tmp')
	check(patchLabels({ labels: { '': 'x' }, favorites: { '': true } }).favorites.join() === 'S:1', '空 key 该被无视')
	console.log('  改名 / 收藏 / 图标 / 颜色各自合并；恢复默认 = 删条目；坏输入不崩')

	console.log('用例 3：插件改名前存在 plugins/dsh-tree 的数据，第一次读时整个搬到 plugins/dsh-chat-tree')
	const oldHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-chat-tree-legacy-'))
	try {
		const legacy = path.join(oldHome, 'plugins', 'dsh-tree')
		fs.mkdirSync(legacy, { recursive: true })
		fs.writeFileSync(path.join(legacy, 'labels.json'), JSON.stringify({ version: 1, labels: { 'S:9': '老标注' }, favorites: [], favIcons: {}, favColors: {} }))
		process.env.DSH_HOME = oldHome
		check(readLabels().labels['S:9'] === '老标注', '老目录里的标注该被搬过来读到')
		check(!fs.existsSync(legacy) && fs.existsSync(path.join(oldHome, 'plugins', 'dsh-chat-tree', 'labels.json')), '老目录该整个改名成新目录')
		console.log('  老目录整个改名，标注不丢')
	} finally {
		process.env.DSH_HOME = home
		fs.rmSync(oldHome, { recursive: true, force: true })
	}
} finally {
	if (was === undefined) delete process.env.DSH_HOME
	else process.env.DSH_HOME = was
	fs.rmSync(home, { recursive: true, force: true })
}
report()
