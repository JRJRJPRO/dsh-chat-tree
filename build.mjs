/**
 * 把 `src/client/*.js` 拼成浏览器那一份 `client.js`。
 *
 * 【为什么非得拼】dsh 的客户端模块系统规定「**一个包 = 一个 bundle**」：它只认
 * `package.json` 的 `exports["./client"]` 那一个文件，交给 factory 的 `require`
 * 也只解析**已注册的模块 id**，解析不了相对路径（dsh-client-modules 原话：
 * "the runtime mirror of the bundle purity gate"）。所以浏览器半只能是一个文件 ——
 * 但**源码不必**。
 *
 * 【怎么拼】所有 part 拼进同一个作用域，所以：
 *   · `import { x } from './y.js'` 整行删掉（同一个作用域里本来就看得见）
 *   · `export const/function …` 去掉 `export`
 *   · 顶层名字**全局唯一**，重名直接报错（两个人同时加了 `render` 就会当场撞上）
 * 于是每个 part 既是能被 node 直接 `import` 的正经 ESM（离线测试用），
 * 又能原样拼进 bundle。除了删 import/export，**一个字节都不改**。
 *
 * 用法：
 *   node build.mjs           重新生成 client.js
 *   node build.mjs --check    只检查 client.js 和 src 对不对得上（npm test 会跑）
 *   node build.mjs --watch    改哪个 part 就重拼一次（配合 dsh 的热重载）
 *
 * @module build
 */

import { readFileSync, writeFileSync, readdirSync, watch } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const SRC = join(here, 'src', 'client')
const OUT = join(here, 'client.js')

/**
 * 拼接顺序。**手写的，别改成按文件名排序** —— 顶层 `const` 不提升，
 * `FIELDS` 要用到 `THEME`，`THEME` 又要用到 `C`，顺序错了就是 TDZ 报错。
 * 新增一个 part 必须往这张表里登记：文件在磁盘上而不在表里会直接报错，
 * 免得有人加了文件却发现"改了没反应"。
 */
const PARTS = [
	'const.js',
	'runtime.js',
	'net.js',
	'theme.js',
	'pointer.js',
	'labels.js',
	'tree.js',
	'graph.js',
	'elide.js',
	'shapes.js',
	'geometry.js',
	'icon-upload.js',
	'diagnose.js',
	'hooks.js',
	'settings-model.js',
	'ui-detail.js',
	'ui-settings.js',
	'rail.js',
	'pure.js',
	'apply.js',
]

/** 生成物顶部那段导读。写在这儿是因为它说的是**整个 bundle**，不属于任何一个 part。 */
const BANNER = `/**
 * dsh-chat-tree 浏览器半：贴着聊天区右缘的对话树。
 *
 * ⚠️ 这个文件是 \`node build.mjs\` 从 \`src/client/*.js\` 拼出来的，**别手改**：
 *    下一次构建就会把你的改动冲掉。要改去改 src/client/ 里对应的那个 part。
 *
 * 数据流：host 的 /outlines 给「每个分支的自有轮次」→ 扣掉归档 → 只留当前那棵树
 * → buildGraph 摊成节点算出 (column, depth) → 绝对定位画点和折线。
 *
 * 三条规矩（改之前先看 DESIGN.md §5）：
 *   · y = 树深度，不是行号 —— 同一岔路分出去的两条支线，第一个节点同高度。
 *   · x = 列，**与"当前在哪条分支"无关** —— 切分支只换颜色，图的形状不动。
 *   · 太远的节点省略掉（elide），最外两圈**鱼眼淡出**（越远越小越淡），不画「⋯」这类记号；
 *     半径设为 0 就退回"永远画全"。
 *
 * 高亮两条判据，别混：
 *   边框蓝 ⟺ 节点在当前会话的对话里；填充蓝 ⟺ 边框已蓝 且 轮次 == 现在滑到的那一轮。
 */`

/** 换行一律归成 LF，跟 src 一致；这样在哪台机器上构建出来的都是同一份字节。 */
function lf(text) {
	return text.replace(/\r\n/g, '\n')
}

/**
 * 把源码里"能当标识符用"的词挑出来。
 *
 * 跳过注释和字符串；模板串只留 `${}` 里的部分（`${Z.card}px` 里的 `Z` 是真引用，
 * 外面那个 `px` 不是）；`a.b` 里的 `b` 是属性名不算引用。
 * 用来检查"引用了别的 part 的东西却忘了 import" —— 这个错在 bundle 里**看不出来**
 * （全在一个作用域），只有 node 直接 import 这个 part 时才炸，容易漏到很后面。
 * @param source - 一个 part 的源码
 * @returns 出现过的标识符
 */
function words(source) {
	const out = new Set()
	let i = 0
	let token = ''
	let dotted = false
	const stack = [] // 模板串嵌套：'t' = 在模板串里，'x' = 在 ${} 里
	const push = () => {
		if (token !== '' && !dotted && !/^\d/.test(token)) out.add(token)
		token = ''
	}
	while (i < source.length) {
		const ch = source[i]
		const two = source.slice(i, i + 2)
		const inTemplate = stack[stack.length - 1] === 't'
		if (!inTemplate && two === '//') {
			push()
			i = source.indexOf('\n', i)
			if (i < 0) break
			continue
		}
		if (!inTemplate && two === '/*') {
			push()
			i = source.indexOf('*/', i) + 2
			continue
		}
		if (!inTemplate && (ch === '"' || ch === "'")) {
			push()
			i += 1
			while (i < source.length && source[i] !== ch) i += source[i] === '\\' ? 2 : 1
			i += 1
			continue
		}
		if (ch === '`') {
			push()
			if (inTemplate) stack.pop()
			else stack.push('t')
			i += 1
			continue
		}
		if (inTemplate) {
			if (two === '${') {
				stack.push('x')
				i += 2
				continue
			}
			i += source[i] === '\\' ? 2 : 1
			continue
		}
		if (ch === '}' && stack[stack.length - 1] === 'x') {
			push()
			stack.pop()
			i += 1
			continue
		}
		if (/[A-Za-z0-9_$]/.test(ch)) {
			if (token === '') dotted = source[i - 1] === '.'
			token += ch
			i += 1
			continue
		}
		push()
		i += 1
	}
	push()
	return out
}

const IMPORT = /^import\s+\{([^}]*)\}\s+from\s+'\.\/([\w.-]+)'\s*$/
const EXPORTED = /^export\s+(?:async\s+function|function|const|let|var|class)\s+([A-Za-z_$][\w$]*)/

/**
 * 读一个 part，去掉 import / export，顺便把它声明的顶层名字报上来。
 * @param name - 文件名
 * @returns `{code, names}`
 */
function compile(name) {
	const source = readFileSync(join(SRC, name), 'utf8')
	const lines = source.split(/\r?\n/)
	const names = []
	const imported = new Set()
	const out = []
	let pending = '' // 跨行的 import 攒在这儿（prettier 会把长 import 拆成好几行）
	for (const [index, line] of lines.entries()) {
		const at = `src/client/${name}:${index + 1}`
		if (pending !== '' || line.startsWith('import ')) {
			pending = `${pending} ${line.trim()}`.trim()
			if (!pending.includes("'")) continue // 还没写到 from './x.js'
			const matched = IMPORT.exec(pending)
			if (matched === null) throw new Error(`${at}: import 只支持 \`import { a, b } from './x.js'\`（拼接时要整段删掉），不支持默认导入 / 改名 / 裸 import`)
			if (!PARTS.includes(matched[2])) throw new Error(`${at}: import 的 './${matched[2]}' 不在 build.mjs 的 PARTS 里`)
			for (const one of matched[1].split(',')) if (one.trim() !== '') imported.add(one.trim())
			pending = ''
			continue
		}
		if (line.startsWith('export ')) {
			const matched = EXPORTED.exec(line)
			if (matched === null) throw new Error(`${at}: 只支持 \`export const/let/function/class 名字\`，不支持 default / 重导出`)
			names.push(matched[1])
			out.push(line.slice('export '.length))
			continue
		}
		if (/^\s*export[\s{]/.test(line)) throw new Error(`${at}: export 必须顶格写`)
		out.push(line)
	}
	return { code: out.join('\n').trim(), names, imported, used: words(source) }
}

/**
 * 每个 part 的 import 对不对得上。
 *
 * **只提醒，不拦着**：这套判断是拿正则扫出来的，扫错了不该把构建卡死。
 * 但真漏了 import 的话，bundle 照样能跑（所有 part 共用一个作用域），
 * 只有 node 单独 import 这个文件时才会炸 —— 所以这个提醒得够响。
 * @param parts - 编译结果，文件名 → `{imported, used, names}`
 * @param owner - 名字 → 谁声明的
 */
function crossCheck(parts, owner) {
	const notes = []
	for (const [name, part] of parts) {
		const mine = new Set(part.names)
		for (const word of part.used) {
			const from = owner.get(word)
			if (from === undefined || from === name || mine.has(word) || part.imported.has(word)) continue
			notes.push(`${name} 用了 ${from} 的 ${word}，却没 import —— bundle 里看不出来，node 直接 import 这个文件时会炸`)
		}
		for (const word of part.imported) {
			if (!part.used.has(word)) notes.push(`${name} import 了 ${word} 但没用到`)
		}
	}
	for (const note of notes) console.error(`  ⚠ ${note}`)
	return notes.length
}

/** 拼出完整的 client.js。 */
function bundle() {
	const onDisk = readdirSync(SRC).filter((name) => name.endsWith('.js'))
	const stray = onDisk.filter((name) => !PARTS.includes(name))
	if (stray.length > 0) throw new Error(`src/client/ 里有没登记的文件：${stray.join(', ')} —— 加进 build.mjs 的 PARTS 才会被拼进去`)

	const seen = new Map()
	const bodies = []
	const compiled = new Map()
	for (const name of PARTS) {
		const part = compile(name)
		const { code, names } = part
		compiled.set(name, part)
		for (const symbol of names) {
			// 所有 part 共用一个作用域，重名不是"覆盖"而是当场语法错误 —— 与其让它在
			// 浏览器里炸，不如构建时就指名道姓说清楚是哪两个文件撞了
			if (seen.has(symbol)) throw new Error(`顶层名字撞了：${symbol} 同时在 ${seen.get(symbol)} 和 ${name} 里声明`)
			seen.set(symbol, name)
		}
		bodies.push(`\t\t// ===== ${name} ${'='.repeat(Math.max(0, 56 - name.length))}\n\n${code.split('\n').map((line) => (line === '' ? '' : `\t\t${line}`)).join('\n')}`)
	}
	crossCheck(compiled, seen)

	return lf(
		[
			BANNER,
			'',
			"window.__ModuleLoader__.load({",
			"\tid: 'dsh-chat-tree',",
			'\tfactory: (require) => {',
			'\t\tvar module = { exports: {} }',
			'\t\tvar exports = module.exports',
			"\t\tObject.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })",
			'',
			bodies.join('\n\n'),
			'',
			'\t\texports.apply = apply',
			'\t\texports.inject = inject',
			'\t\t// 纯函数出口，仅供离线测试（cordis 只读 apply/inject）',
			'\t\texports.__pure = __pure',
			'\t\treturn module.exports',
			'\t},',
			'})',
			'',
		].join('\n'),
	)
}

const argv = new Set(process.argv.slice(2))
const built = bundle()

if (argv.has('--check')) {
	const now = readFileSync(OUT, 'utf8')
	if (now === built) console.log(`client.js 与 src/client/ 一致（${PARTS.length} 个 part）`)
	else {
		console.error('client.js 和 src/client/ 对不上 —— 有人改了 src 却没重新构建。跑一下 `npm run build`。')
		process.exit(1)
	}
} else {
	writeFileSync(OUT, built)
	console.log(`client.js ← ${PARTS.length} 个 part，${built.split('\n').length} 行`)
	if (argv.has('--watch')) {
		console.log('盯着 src/client/ …（Ctrl-C 退出）')
		let pending = 0
		watch(SRC, () => {
			clearTimeout(pending)
			pending = setTimeout(() => {
				try {
					writeFileSync(OUT, bundle())
					console.log(`[${new Date().toLocaleTimeString()}] 重拼完成`)
				} catch (error) {
					console.error(String(error.message || error))
				}
			}, 80)
		})
	}
}
