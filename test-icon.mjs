/**
 * dsh-tree —— 自定义节点图片的落盘用例。
 *
 * 【导读】
 * 干嘛的：设置里能传一张图当节点。图存在 host 半（`$DSH_HOME/plugins/dsh-tree/icons/`），
 * 前端存的形状值只是 `img:<id>`。这份用例钉住三件事：
 *   · **只收 PNG**。浏览器半已经把任意格式过了一遍 canvas，到 host 的必然是纯像素；
 *     这里验魔数是防着有人绕开前端直接 POST 一个带脚本的 SVG 上来。
 *   · **id 是内容哈希**。同一张图传两次是同一个文件；而且它要直接拼成文件名，
 *     所以校验必须是白名单（32 位十六进制），不能是"过滤掉 .. 就行"。
 *   · **清理不会清掉正在用的那张**：每次被取走都会刷新 mtime，保留最近 ICON_KEEP 张。
 *
 * 阅读顺序：
 *   第1步  手搓一个最小合法 PNG（不想为了测试装依赖）
 *   第2步  临时 home，绝不碰真实的那份
 *   第3步  三组断言：只收 PNG / 内容哈希与路径安全 / 清理策略
 *
 * 跑法：node test-icon.mjs
 *
 * @module test-icon
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'

let failures = 0

/**
 * 一条断言。
 * @param ok - 条件
 * @param message - 失败时打印什么
 */
function check(ok, message) {
	if (ok) return
	failures += 1
	console.log(`  ✗ ${message}`)
}

// ===== 第 1 步：手搓一个最小合法 PNG =====

/**
 * 造一张 1×1 的纯色 PNG。
 *
 * PNG = 8 字节魔数 + 若干个 `长度|类型|数据|CRC32` 的块。最少要三块：
 * IHDR（尺寸和色彩格式）、IDAT（zlib 压过的像素）、IEND（收尾）。
 * 自己搓是为了不给测试拉一个画图依赖进来。
 * @param red - 红色分量 0..255，用来造出内容不同的两张图
 * @returns PNG 字节
 */
function tinyPng(red) {
	const chunk = (type, body) => {
		const head = Buffer.alloc(4)
		head.writeUInt32BE(body.length)
		const tagged = Buffer.concat([Buffer.from(type, 'ascii'), body])
		const crc = Buffer.alloc(4)
		crc.writeUInt32BE(zlib.crc32 === undefined ? crc32(tagged) : zlib.crc32(tagged))
		return Buffer.concat([head, tagged, crc])
	}
	const ihdr = Buffer.alloc(13)
	ihdr.writeUInt32BE(1, 0) // 宽
	ihdr.writeUInt32BE(1, 4) // 高
	ihdr[8] = 8 // 每通道 8 位
	ihdr[9] = 2 // 真彩色 RGB
	// 一行像素前面要带一个"过滤器类型"字节，这里用 0 = 不过滤
	const raw = Buffer.from([0, red, 0x80, 0x40])
	return Buffer.concat([
		Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
		chunk('IHDR', ihdr),
		chunk('IDAT', zlib.deflateSync(raw)),
		chunk('IEND', Buffer.alloc(0)),
	])
}

/**
 * CRC-32（老版本 node 的 zlib 没有现成的）。
 * @param bytes - 输入
 * @returns 校验和
 */
function crc32(bytes) {
	let value = 0xffffffff
	for (const byte of bytes) {
		value ^= byte
		for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? (value >>> 1) ^ 0xedb88320 : value >>> 1
	}
	return (value ^ 0xffffffff) >>> 0
}

// ===== 第 2 步：临时 home =====

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-tree-icon-'))
process.env.DSH_HOME = home

const host = await import(new URL('./index.js', import.meta.url))
const { putIcon, readIcon, isIconId, iconDir, ICON_KEEP, ICON_MAX } = host.__test

// ===== 第 3 步：断言 =====

console.log('用例 1：只收 PNG')
{
	const png = tinyPng(0xff).toString('base64')
	const id = putIcon(png)
	check(isIconId(id), `存完该拿到一个合法 id，实际 ${id}`)

	// 不是 PNG 的一律拒。SVG 是重点：原样落盘再当同源图片引，里面的 <script> 会跟着跑
	const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>').toString('base64')
	let refused = false
	try {
		putIcon(svg)
	} catch {
		refused = true
	}
	check(refused, 'SVG 被原样存下来了 —— 这是个后门，必须拒')

	for (const [label, bad] of [['空', ''], ['非 base64', '!!!'], ['不是图', Buffer.from('hello world').toString('base64')]]) {
		let stopped = false
		try {
			putIcon(bad)
		} catch {
			stopped = true
		}
		check(stopped, `${label} 的输入没被拦下`)
	}

	// 超大的也要拒 —— 前端缩完才两三 KB，超一个数量级就是绕过了前端
	const huge = Buffer.concat([tinyPng(1), Buffer.alloc(ICON_MAX)]).toString('base64')
	let capped = false
	try {
		putIcon(huge)
	} catch {
		capped = true
	}
	check(capped, `超过 ${ICON_MAX} 字节的图没被拦下`)
	console.log(`  PNG 收下（id ${putIcon(png)}）；SVG / 空 / 乱码 / 超大全部拒掉`)
}

console.log('\n用例 2：id 是内容哈希，且只认白名单')
{
	const same = putIcon(tinyPng(0x10).toString('base64'))
	const again = putIcon(tinyPng(0x10).toString('base64'))
	const other = putIcon(tinyPng(0x20).toString('base64'))
	check(same === again, '同一张图传两次该是同一个 id')
	check(same !== other, '两张不同的图撞成了同一个 id')

	// id 要直接拼成文件名。放宽一点就是任人读盘上任意文件
	for (const bad of ['../../../etc/passwd', '..\\..\\windows\\win.ini', 'a'.repeat(31), 'a'.repeat(33), 'A'.repeat(32), 'z'.repeat(32), '', null, undefined]) {
		check(!isIconId(bad), `${JSON.stringify(bad)} 不该算合法 id`)
		check(readIcon(bad) === undefined, `${JSON.stringify(bad)} 居然读出东西来了`)
	}
	check(readIcon('0'.repeat(32)) === undefined, '不存在的 id 该读出 undefined 而不是抛')

	const bytes = readIcon(same)
	check(Buffer.isBuffer(bytes) && bytes.subarray(1, 4).toString('ascii') === 'PNG', '读回来的不是 PNG')
	console.log(`  同图同 id（${same}）；穿越 / 大小写 / 长度不符全部拒掉`)
}

console.log('\n用例 3：清理不会清掉正在用的那张')
{
	// 先存一张"正在用的"，再塞满 ICON_KEEP 张新的
	const mine = putIcon(tinyPng(0x01).toString('base64'))
	for (let i = 0; i < ICON_KEEP + 4; i += 1) {
		// 每存一张就取一次"正在用的"，模拟页面刷新时浏览器来拉图 —— 这会刷新它的 mtime
		check(readIcon(mine) !== undefined, `存到第 ${i} 张时，正在用的那张已经被清掉了`)
		putIcon(tinyPng(0x40 + i).toString('base64'))
	}
	const left = fs.readdirSync(iconDir()).filter((name) => name.endsWith('.png'))
	check(left.length <= ICON_KEEP, `该只留 ${ICON_KEEP} 张，实际 ${left.length} 张`)
	check(readIcon(mine) !== undefined, '一直在用的那张被清掉了 —— mtime 没跟着刷新')
	console.log(`  连存 ${ICON_KEEP + 4} 张后只剩 ${left.length} 张，一直在用的那张还在`)
}

fs.rmSync(home, { recursive: true, force: true })
console.log(failures === 0 ? '\n✓ 全部断言通过' : `\n✗ ${failures} 条断言失败`)
process.exit(failures === 0 ? 0 : 1)
