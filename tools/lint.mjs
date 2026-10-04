/**
 * 机械化的规矩检查：ARCHITECTURE.md §4 / AGENTS.md §4 里那几条"不许破"的，能用程序查的都在这儿。
 *
 * 【为什么要有它】这些规矩以前只写在文档里。人会读文档，agent 也会读 —— 但省 token 的
 * 小模型改完一个文件不会回头看全局，"顺手"在 graph.js 里 import 了 react、在 Rail 里
 * 手拼了一个 `${id}:${turn}`，没有任何东西会响。这里把它们变成**跑一下就红**的检查，
 * 零依赖（只用 node 自带的），`npm test` 第二步就是它。
 *
 * 每条规矩都写着"为什么"和"该怎么改"，报错时原样打出来 —— 让改坏的人当场看到那段文档。
 *
 * 用法：node tools/lint.mjs            全查，有一条不过就退出码 1
 *       node tools/lint.mjs --fix-hint 只打印每条规矩的说明（新 agent 上手先看一遍）
 *
 * @module lint
 */

import { spawnSync } from 'node:child_process'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const rel = (file) => relative(root, file).replace(/\\/g, '/')

/** 递归列出一个目录下所有 .js / .mjs。 */
function listJs(dir) {
	const out = []
	for (const name of readdirSync(dir)) {
		const file = join(dir, name)
		if (statSync(file).isDirectory()) out.push(...listJs(file))
		else if (/\.m?js$/.test(name)) out.push(file)
	}
	return out
}

const clientFiles = listJs(join(root, 'src', 'client'))
const hostFiles = listJs(join(root, 'src', 'host'))
const testFiles = readdirSync(join(root, 'tests')).filter((name) => /^test(-[\w.-]+)?\.mjs$/.test(name) && name !== 'test-kit.mjs').map((name) => join(root, 'tests', name))
const allSources = [...clientFiles, ...hostFiles, join(root, 'index.js'), join(root, 'build.mjs'), ...listJs(join(root, 'tools')), ...listJs(join(root, 'tests'))]

/** 去掉注释（`//` 整行、`/* … *\/` 块、以及 `*` 开头的 JSDoc 行）后的代码行，带行号。 */
function codeLines(source) {
	const out = []
	let inBlock = false
	for (const [index, raw] of source.split(/\r?\n/).entries()) {
		let line = raw
		if (inBlock) {
			const end = line.indexOf('*/')
			if (end < 0) continue
			line = line.slice(end + 2)
			inBlock = false
		}
		// 行内块注释
		let open = line.indexOf('/*')
		while (open >= 0) {
			const close = line.indexOf('*/', open + 2)
			if (close < 0) {
				line = line.slice(0, open)
				inBlock = true
				break
			}
			line = line.slice(0, open) + line.slice(close + 2)
			open = line.indexOf('/*')
		}
		const trimmed = line.trim()
		if (trimmed.startsWith('//') || trimmed.startsWith('*')) continue
		// 行尾注释（不处理字符串里的 //，规矩里查的词不会出现在 URL 里）
		const tail = line.indexOf('//')
		if (tail >= 0 && !/https?:\/\//.test(line)) line = line.slice(0, tail)
		if (line.trim() !== '') out.push({ no: index + 1, text: line })
	}
	return out
}

// ===== 规矩表 =====
//
// 每条：`id`、`why`（给人看的理由）、`run(report)`。报一条问题就调 `report(file, line, text)`。

/**
 * 浏览器半里**允许碰 react** 的 part。不在这张表里的文件 import 了 './runtime.js'，
 * 就是把"算"和"画"揉到一起了 —— 纯函数一碰 react 就没法离线测。
 * 新建一个画界面的模块要在这里登记（并想清楚它的逻辑是不是该先拆出一个纯函数文件）。
 */
const UI_PARTS = new Set(['runtime.js', 'pointer.js', 'theme.js', 'hooks.js', 'sidebar.js', 'shapes.js', 'ui-detail.js', 'ui-settings.js', 'rail.js', 'apply.js'])

const RULES = [
	{
		id: 'syntax',
		why: '每个 .js/.mjs 都得能被 node 解析。改坏了语法的话 bundle 整个加载失败，导轨直接消失、什么提示都没有。',
		run(report) {
			for (const file of allSources) {
				const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' })
				if (result.status !== 0) report(file, 0, (result.stderr || '').split('\n').slice(0, 3).join(' | '))
			}
		},
	},
	{
		id: 'ui-only-imports-react',
		why: `浏览器半里只有 ${[...UI_PARTS].join(' / ')} 可以 import './runtime.js'（react）。别的 part 全是纯函数，离线测试直接 import 就能跑；一碰 react 就测不了了。要画界面的新模块先在 tools/lint.mjs 的 UI_PARTS 登记，并把它的逻辑拆到一个不碰 react 的文件里。`,
		run(report) {
			for (const file of clientFiles) {
				const name = rel(file).split('/').pop()
				if (UI_PARTS.has(name)) continue
				for (const line of codeLines(readFileSync(file, 'utf8'))) {
					if (/from\s+'\.\/runtime\.js'/.test(line.text)) report(file, line.no, line.text.trim())
				}
			}
		},
	},
	{
		id: 'node-key-only-from-tree',
		why: "节点 key（`<sessionId>:<turn>`、树根的 ROOT_KEY）只准由 src/client/tree.js 的 keyOf / ROOT_KEY 产出。别处手拼 `${id}:${turn}` 或写 'root' 字面量，key 格式一改就全错（空节点按树区分那条任务改的就是它）。",
		run(report) {
			for (const file of clientFiles) {
				if (rel(file).endsWith('tree.js')) continue
				for (const line of codeLines(readFileSync(file, 'utf8'))) {
					if (/\$\{[^}]*\}:\$\{[^}]*turn[^}]*\}/i.test(line.text)) report(file, line.no, `手拼节点 key：${line.text.trim()}`)
					if (/(^|[^\w])'root'/.test(line.text)) report(file, line.no, `'root' 字面量，用 ROOT_KEY / node.key：${line.text.trim()}`)
				}
			}
		},
	},
	{
		id: 'no-console',
		why: '浏览器半告警一律走 net.js 的 warn()（带 [dsh-chat-tree] 前缀，控制台里一眼捞得出来）；host 半走 ctx.logger。散落的 console.log 是调试残留。',
		run(report) {
			for (const file of [...clientFiles, ...hostFiles, join(root, 'index.js')]) {
				if (rel(file).endsWith('net.js')) continue
				for (const line of codeLines(readFileSync(file, 'utf8'))) {
					if (/\bconsole\.(log|warn|error|info|debug)\(/.test(line.text)) report(file, line.no, line.text.trim())
				}
			}
		},
	},
	{
		id: 'disk-writes-via-paths',
		why: 'host 半写盘一律走 src/host/paths.js 的 atomicWrite（先写 .tmp 再 rename，断电不留半截文件）。别处直接 writeFileSync / renameSync / mkdirSync 就是绕开它。清理旧文件用的 unlinkSync 不在此列。',
		run(report) {
			for (const file of [...hostFiles, join(root, 'index.js')]) {
				if (rel(file).endsWith('paths.js')) continue
				for (const line of codeLines(readFileSync(file, 'utf8'))) {
					if (/\b(writeFileSync|renameSync|mkdirSync|rmSync|appendFileSync)\s*\(/.test(line.text)) report(file, line.no, line.text.trim())
				}
			}
		},
	},
	{
		id: 'routes-via-http',
		why: 'HTTP 路由只准用 src/host/http.js 的 route()。直接 webServer.register 等于绕过 connection.requestRejection 那道鉴权围栏（AGENTS.md §4 第 2 条）。',
		run(report) {
			for (const file of [...hostFiles, join(root, 'index.js')]) {
				if (rel(file).endsWith('http.js')) continue
				for (const line of codeLines(readFileSync(file, 'utf8'))) {
					if (/webServer\.register\s*\(/.test(line.text)) report(file, line.no, line.text.trim())
				}
			}
		},
	},
	{
		id: 'tests-report',
		why: '每个 tests/test-*.mjs 都要 import test-kit 的 check / report，并以 report() 收尾。没有 report() 的脚本退出码永远是 0 —— 一条断言都没跑也算过。',
		run(report) {
			for (const file of testFiles) {
				const source = readFileSync(file, 'utf8')
				if (!/from\s+'\.\/test-kit\.mjs'/.test(source)) report(file, 1, '没有 import ./test-kit.mjs')
				if (!/\breport\(\)/.test(source)) report(file, 1, '没有调用 report()')
				if (!/\bcheck\(/.test(source)) report(file, 1, '一条 check() 都没有')
			}
		},
	},
	{
		id: 'bundle-fresh-and-imports-complete',
		why: 'client.js 必须和 src/client/ 一致（改了 src 要 npm run build），而且每个 part 用到别的 part 的名字都要写 import —— bundle 里看不出来漏了，node 单独 import 那个文件时才炸，离线测试就跑不起来了。',
		run(report) {
			const result = spawnSync(process.execPath, [join(root, 'build.mjs'), '--check', '--strict'], { encoding: 'utf8', cwd: root })
			if (result.status !== 0) report(join(root, 'client.js'), 0, `${result.stdout}${result.stderr}`.trim().split('\n').slice(0, 8).join(' | '))
		},
	},
	{
		id: 'client-parts-documented',
		why: 'src/client/ 里每个 part 都该在 docs/dev/ARCHITECTURE.md §2 的清单里有一行 —— 别人（或别的 agent）要靠那张表知道"改这件事去哪个文件"。',
		run(report) {
			const doc = readFileSync(join(root, 'docs', 'dev', 'ARCHITECTURE.md'), 'utf8')
			for (const file of [...clientFiles, ...hostFiles]) {
				const name = rel(file).split('/').pop()
				if (!doc.includes(`\`${name}\``)) report(file, 0, `ARCHITECTURE.md 的清单里没有 ${name}`)
			}
		},
	},
]

// ===== 跑 =====

if (process.argv.includes('--fix-hint')) {
	for (const rule of RULES) console.log(`[${rule.id}]\n  ${rule.why}\n`)
	process.exit(0)
}

let problems = 0
for (const rule of RULES) {
	const found = []
	rule.run((file, line, text) => found.push({ file, line, text }))
	if (found.length === 0) {
		console.log(`✓ ${rule.id}`)
		continue
	}
	problems += found.length
	console.log(`✗ ${rule.id}`)
	console.log(`    ${rule.why}`)
	for (const one of found) console.log(`    ${rel(one.file)}${one.line > 0 ? `:${one.line}` : ''}  ${one.text}`)
}
console.log(problems === 0 ? '\n✓ 规矩全过' : `\n✗ ${problems} 处违反规矩`)
process.exit(problems === 0 ? 0 : 1)
