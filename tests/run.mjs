/**
 * 测试运行器：把 `tests/test-*.mjs` 全部跑一遍，**一个都不漏、一个失败也不挡住别的**。
 *
 * 【为什么不用 package.json 里那串 `&&`】
 *   · `&&` 链第一个失败就停，后面十几个文件的结果看不到 —— 修一条跑一次，来回十几趟。
 *   · 新加一个测试文件要记得往那串里登记，忘了就是"写了测试但从来没跑过"。
 *     这里按文件名自动发现，放进 tests/ 就会被跑到。
 *   · 几个 agent 并行干活时，每人只想跑自己那块：`--only card,layout`。
 *
 * 用法：
 *   node tests/run.mjs                 全部跑（并行，默认 4 个进程）
 *   node tests/run.mjs --only card     只跑文件名含 card 的（逗号分隔多个）
 *   node tests/run.mjs --list          只列出会跑哪些
 *   node tests/run.mjs --serial        一个一个跑（排查互相干扰时用）
 *   node tests/run.mjs --verbose       失败的文件把完整输出打出来（默认只打失败那几行）
 *
 * 每个文件在**独立进程**里跑：它们各自改 globalThis（document / window / localStorage），
 * 混在一个进程里会互相污染。退出码非 0 = 这个文件失败。
 *
 * @module run
 */

import { spawn } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { cpus } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')

const argv = process.argv.slice(2)
const flag = (name) => argv.includes(`--${name}`)
const valueOf = (name) => {
	const at = argv.indexOf(`--${name}`)
	if (at >= 0 && argv[at + 1] !== undefined && !argv[at + 1].startsWith('--')) return argv[at + 1]
	const inline = argv.find((one) => one.startsWith(`--${name}=`))
	return inline === undefined ? undefined : inline.slice(name.length + 3)
}

const only = (valueOf('only') || '').split(',').map((one) => one.trim()).filter((one) => one !== '')
const files = readdirSync(here)
	.filter((name) => /^test(-[\w.-]+)?\.mjs$/.test(name) && name !== 'test-kit.mjs')
	.filter((name) => only.length === 0 || only.some((want) => name.includes(want)))
	.sort()

if (flag('list')) {
	for (const name of files) console.log(name)
	process.exit(0)
}
if (files.length === 0) {
	console.error(`没有匹配的测试文件（--only ${only.join(',')}）`)
	process.exit(2)
}

const jobs = flag('serial') ? 1 : Math.max(1, Math.min(Number(valueOf('jobs')) || 4, cpus().length))

/**
 * 跑一个测试文件。
 * @param name - 文件名
 * @returns `{name, code, ms, out}`
 */
function runOne(name) {
	return new Promise((resolve) => {
		const started = Date.now()
		const child = spawn(process.execPath, [join(here, name)], { cwd: root, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] })
		let out = ''
		child.stdout.on('data', (chunk) => { out += chunk })
		child.stderr.on('data', (chunk) => { out += chunk })
		child.on('close', (code) => resolve({ name, code, ms: Date.now() - started, out }))
		child.on('error', (error) => resolve({ name, code: 1, ms: Date.now() - started, out: String(error) }))
	})
}

/**
 * 从输出里挑出值得看的几行：失败的断言（✗ 开头）、异常堆栈的头几行。
 * @param out - 完整输出
 * @returns 摘出来的几行
 */
function digest(out) {
	const lines = out.split(/\r?\n/)
	const picked = lines.filter((line) => /✗|Error|error:|at .*\.mjs/.test(line))
	return (picked.length > 0 ? picked : lines.filter((line) => line.trim() !== '').slice(-12)).slice(0, 40)
}

const queue = files.slice()
const results = []
const started = Date.now()

await Promise.all(
	Array.from({ length: jobs }, async () => {
		while (queue.length > 0) {
			const name = queue.shift()
			const result = await runOne(name)
			results.push(result)
			const mark = result.code === 0 ? '✓' : '✗'
			console.log(`${mark} ${name.padEnd(26)} ${String(result.ms).padStart(6)} ms`)
			if (result.code !== 0) {
				const lines = flag('verbose') ? result.out.split(/\r?\n/) : digest(result.out)
				for (const line of lines) console.log(`    ${line}`)
			}
		}
	}),
)

const failed = results.filter((one) => one.code !== 0)
console.log('')
console.log(`${results.length} 个文件，${results.length - failed.length} 通过，${failed.length} 失败，共 ${((Date.now() - started) / 1000).toFixed(1)}s`)
if (failed.length > 0) {
	console.log(`失败：${failed.map((one) => one.name).join(', ')}`)
	console.log(`单独重跑：node tests/${failed[0].name}`)
}
process.exit(failed.length === 0 ? 0 : 1)
