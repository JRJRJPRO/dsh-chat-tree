/**
 * 自定义节点图片的存取。只收 PNG，文件名取内容哈希，只留最近 32 张。
 */
import { createHash } from 'node:crypto'
import { readFileSync, readdirSync, statSync, unlinkSync, utimesSync } from 'node:fs'
import { join } from 'node:path'
import { atomicWrite, iconDir } from './paths.js'

/** 最多留几张自定义图片。一张 96×96 的 PNG 也就几 KB，留够用就行。 */
export const ICON_KEEP = 32

/** 一张图最多多少字节。浏览器半已经缩成 96×96（`ICON_EDGE`），正常几 KB —— 超一个数量级就是不对劲。 */
export const ICON_MAX = 256 * 1024

/** PNG 的魔数。只认这个。 */
export const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

/**
 * 校验一个图片 id。id 是内容哈希，样子固定。
 *
 * ⚠️ 这东西要直接拼成文件名。放宽一点就是任人读盘上任意文件的路径穿越，
 *    别改成"过滤掉 ..  就行"之类的黑名单写法。
 * @param id - 待查的 id
 * @returns 是不是一个合法 id
 */
export function isIconId(id) {
	return typeof id === 'string' && /^[0-9a-f]{32}$/.test(id)
}

/**
 * 存一张自定义节点图片。
 *
 * ⚠️ 只收 PNG，而且只收浏览器半 canvas 出来的那种。**绝不能直接落用户原文件**：
 *    SVG 里可以写 <script>，原样挂到同源地址上再当图引就是个后门。浏览器半
 *    已经过了一遍 canvas，到这儿的必然是纯像素 —— 这里验魔数是为了防绕过前端直接 POST。
 *
 * 文件名取内容哈希：同一张图传两次是同一个文件，换个颜色再传回来也不会堆出两份。
 * @param base64 - PNG 的 base64（不带 data: 前缀）
 * @returns 图片 id
 */
export function putIcon(base64) {
	if (typeof base64 !== 'string' || base64.length === 0) throw new Error('没收到图片数据')
	const bytes = Buffer.from(base64, 'base64')
	if (bytes.length === 0) throw new Error('图片数据不是合法的 base64')
	if (bytes.length > ICON_MAX) throw new Error(`图片太大（${bytes.length} 字节）`)
	if (!bytes.subarray(0, PNG_MAGIC.length).equals(PNG_MAGIC)) throw new Error('只收 PNG（浏览器半会先把任意格式转成 PNG）')

	const id = createHash('sha256').update(bytes).digest('hex').slice(0, 32)
	const folder = iconDir()
	atomicWrite(join(folder, `${id}.png`), bytes)
	pruneIcons(folder)
	return id
}

/**
 * 只留最近用过的那几张。
 *
 * 按 mtime 排，而**每次被取走都会刷新 mtime**（见 readIcon）—— 所以"正在用的"那几张
 * 每次开页面都会浮到最前面，不会被这里清掉。真清错了也只是节点画不出来，重传一次就好。
 * @param folder - 目录
 */
export function pruneIcons(folder) {
	try {
		const files = readdirSync(folder)
			.filter((name) => name.endsWith('.png'))
			.map((name) => ({ name, at: statSync(join(folder, name)).mtimeMs }))
			.sort((a, b) => b.at - a.at)
		for (const stale of files.slice(ICON_KEEP)) unlinkSync(join(folder, stale.name))
	} catch {
		// 清不掉不算错 —— 大不了多占几十 KB
	}
}

/**
 * 取一张自定义节点图片，顺手把 mtime 刷新一下当"最近用过"。
 * @param id - 图片 id
 * @returns PNG 字节，没有就 undefined
 */
export function readIcon(id) {
	if (!isIconId(id)) return undefined
	const target = join(iconDir(), `${id}.png`)
	try {
		const bytes = readFileSync(target)
		try {
			const now = new Date()
			utimesSync(target, now, now)
		} catch {
			// 刷不动就算了，顶多早一点被 pruneIcons 清掉
		}
		return bytes
	} catch {
		return undefined
	}
}
