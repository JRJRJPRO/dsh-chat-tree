/**
 * 桌面版里一键切换 dsh-chat-tree 的来源：**本地仓库（开发版）** ↔ **npm（用户视角）**。
 *
 * 【为什么不是装两份】dsh 认的是包名：cordis entry id、设置命名空间、`/plugins/dsh-chat-tree/*`
 * 路由、浏览器 bundle id 全是 `dsh-chat-tree` 这一个字串，两份同名包装不进同一个 profile；
 * 改名做一个 `-dev` 副本的话这几处全得跟着参数化，而且两份一起启用就是两棵树互相叠。
 * 所以做成**一条命令切来源**：改 profile 的 package.json 里那一行依赖，用桌面版自带的 pnpm 重装。
 *
 * 用法（应用开着也能跑，但**切完要完全退出再开桌面版**，bundle 变化不热重载）：
 *   node tools/desktop-switch.mjs status    现在用的是哪份
 *   node tools/desktop-switch.mjs local     切到本地仓库（link:，改完 npm run build + Ctrl+R 就见效，host 半要重启）
 *   node tools/desktop-switch.mjs npm       切回 npm 最新发布版（用户视角）
 *
 * 路径都能用环境变量盖掉：DSH_HOME（profile 在 $DSH_HOME/profiles/desktop）、DSH_DESKTOP_APP（安装目录）。
 *
 * @module desktop-switch
 */

import { spawnSync } from 'node:child_process'
import { existsSync, lstatSync, readFileSync, readlinkSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const home = process.env.DSH_HOME || 'E:/Programs/deepseek-harness/home'
const profile = join(home, 'profiles', 'desktop')
const app = process.env.DSH_DESKTOP_APP || 'E:/Programs/DeepSeek-Harness-Desktop'
const electron = join(app, 'DeepSeek Harness.exe')
const pnpm = join(app, 'resources', 'runtime', 'pnpm', 'bin', 'pnpm.mjs')
const NAME = 'dsh-chat-tree'

const mode = process.argv[2]
if (!['status', 'local', 'npm'].includes(mode)) {
	console.error('用法：node tools/desktop-switch.mjs status | local | npm')
	process.exit(2)
}
for (const [what, path] of [['桌面 profile', profile], ['桌面版程序', electron], ['自带 pnpm', pnpm]]) {
	if (!existsSync(path)) {
		console.error(`找不到${what}：${path}（用 DSH_HOME / DSH_DESKTOP_APP 指过去）`)
		process.exit(2)
	}
}

const pkgPath = join(profile, 'package.json')
const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
const spec = (pkg.dependencies || {})[NAME]

function status() {
	const installed = join(profile, 'node_modules', NAME)
	let where = '没装'
	if (existsSync(installed)) {
		const stat = lstatSync(installed)
		const version = JSON.parse(readFileSync(join(installed, 'package.json'), 'utf8')).version
		where = stat.isSymbolicLink() ? `本地仓库 ${readlinkSync(installed)}（版本 ${version}，开发版）` : `npm 发布版 ${version}（用户视角）`
	}
	console.log(`依赖声明：${NAME} = ${spec === undefined ? '（无）' : spec}`)
	console.log(`实际装的：${where}`)
	console.log(`bundles：${(pkg.dsh && pkg.dsh.profile && pkg.dsh.profile.bundles || []).includes(NAME) ? '已登记' : '⚠️ 没登记进 dsh.profile.bundles'}`)
}

if (mode === 'status') {
	status()
	process.exit(0)
}

const want = mode === 'local' ? `link:${repo.replace(/\\/g, '/')}` : `^${JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8')).version.replace(/^(\d+\.\d+)\.\d+.*$/, '$1.0')}`
if (spec === want) console.log(`依赖已经是 ${want}，只重装一遍确认。`)
else {
	pkg.dependencies = Object.assign({}, pkg.dependencies, { [NAME]: want })
	pkg.dsh = pkg.dsh || {}
	pkg.dsh.profile = pkg.dsh.profile || {}
	pkg.dsh.profile.bundles = pkg.dsh.profile.bundles || []
	if (!pkg.dsh.profile.bundles.includes(NAME)) pkg.dsh.profile.bundles.push(NAME)
	writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`)
	console.log(`${NAME}: ${spec} → ${want}`)
}

console.log('用桌面版自带的 pnpm 重装……')
const result = spawnSync(electron, [pnpm, '--dir', profile, 'install'], {
	stdio: 'inherit',
	env: Object.assign({}, process.env, { ELECTRON_RUN_AS_NODE: '1' }),
})
if (result.status !== 0) {
	console.error(`pnpm install 失败（退出码 ${result.status}）。package.json 已改，可以手动重跑或改回去。`)
	process.exit(1)
}
console.log('')
status()
console.log('\n⚠️ 完全退出桌面版（托盘里也退掉）再打开，bundle 变化不热重载。')
if (mode === 'local') console.log('之后改浏览器半：npm run build + 窗口里 Ctrl+R；改 host 半（src/host、index.js）：再重启应用。')
