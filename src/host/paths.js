/**
 * 落盘位置：dsh home 在哪，我们自己的东西放哪，以及**怎么原子地写文件**。
 *
 * 三处写盘（形状、图片、嫁接出来的 sidecar）以前各写一遍"临时文件 + rename"，
 * 现在统一走 `atomicWrite`。读也一样：读坏了 / 版本不对一律当"没有"，
 * 调用方不必各写一套 try。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'

/**
 * 解析 dsh home（`$DSH_HOME` 优先，否则 `~/.dsh`）。自己算而不 import
 * `dsh-home-paths`，是因为插件装在 profile 之外，解析不到宿主的依赖树。
 * @returns dsh home 绝对路径
 */
export function dshHome() {
	const configured = process.env.DSH_HOME
	return configured && configured.trim().length > 0 ? resolve(configured.trim()) : join(homedir(), '.dsh')
}

/**
 * 插件改名前的落盘目录名。第一次碰到新目录不存在而老目录还在时整个搬过去，
 * 老用户的形状、图片、标注一样不丢。
 */
const LEGACY_DIR = 'dsh-tree'
const migratedRoots = new Set()

/**
 * 我们自己的东西一律放在 `$DSH_HOME/plugins/dsh-chat-tree/` 下面。
 *
 * 放在 home 而不是 localStorage：换浏览器、进手机都还在。
 * @param parts - 目录下的相对路径片段
 * @returns 绝对路径
 */
export function pluginFile(...parts) {
	const root = join(dshHome(), 'plugins', 'dsh-chat-tree')
	if (!migratedRoots.has(root)) {
		migratedRoots.add(root)
		const legacy = join(dshHome(), 'plugins', LEGACY_DIR)
		if (!existsSync(root) && existsSync(legacy)) {
			try {
				renameSync(legacy, root)
			} catch {
				// 搬不动（比如权限）就当没有老数据，别把宿主带崩
			}
		}
	}
	return join(root, ...parts)
}

/**
 * 树形关系的落盘位置。
 *
 * dsh 自己只记 fork 血缘（parentSession），而"哪几条独立对话算同一棵树"
 * 和"哪条支线被手动拆出去了"是我们自己的概念，它不在任何日志里，只能自己存。
 * @returns 绝对路径
 */
export function shapePath() {
	return pluginFile('shape.json')
}

/**
 * 自定义节点图片的落盘目录。和 shape.json 放一块，换浏览器也还在。
 * @returns 绝对路径
 */
export function iconDir() {
	return pluginFile('icons')
}

/**
 * sidecar 路径。文件名是会话 id 原样 base64url。
 * @param sessionId - dsh 会话 id
 * @returns 绝对路径
 */
export function sidecarPath(sessionId) {
	return join(dshHome(), 'plugins', 'dsh-claude', 'sessions', `${Buffer.from(sessionId).toString('base64url')}.json`)
}

/** 我们认得的 dsh-claude sidecar 版本。对不上就不碰。 */
export const SIDECAR_SCHEMA_VERSION = 1

/**
 * 原子写一个文件：先写临时文件，再 rename 盖上去。
 *
 * 【为什么统一在这里】三处写盘（形状 / 图片 / 嫁接出来的 sidecar）以前各写一遍，
 * 权限位、临时名、要不要建目录三处各不相同。**这不是洁癖**：临时名撞车会让两个
 * 进程互相盖，权限写宽了就是把会话内容暴露给同机其它用户。只留一份就只有一处会错。
 *
 * ⚠️ 临时名里带 pid + uuid：同一个 home 可能有好几个 dsh 进程。
 * ⚠️ 用 `wx` 开临时文件（存在就报错），万一真撞上了宁可失败也不要静悄悄覆盖别人。
 * ⚠️ Windows 上 rename 覆盖一个**正被别人读着**的文件会 EPERM —— 这正是
 *    `rewind.js` 那一整段警告的由来。我们自己写的这几个文件没人长期持有句柄。
 * @param target - 最终路径
 * @param data - 字符串或 Buffer
 * @param options - `{dirMode}`：要新建目录时用的权限（默认跟随 umask）
 */
export function atomicWrite(target, data, options) {
	const dirMode = options !== undefined ? options.dirMode : undefined
	mkdirSync(dirname(target), dirMode === undefined ? { recursive: true } : { recursive: true, mode: dirMode })
	const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`
	writeFileSync(temporary, data, { mode: 0o600, flag: 'wx' })
	renameSync(temporary, target)
}

/**
 * 读一个 JSON 文件。**读不到 / 读坏了一律 undefined** —— 三个调用方的结论都一样
 * （退回默认值 / 当成没有），各写一套 try 只会让人以为它们不一样。
 * @param file - 绝对路径
 * @returns 解析出来的东西，或 undefined
 */
export function readJsonFile(file) {
	try {
		return JSON.parse(readFileSync(file, 'utf8'))
	} catch {
		return undefined
	}
}
