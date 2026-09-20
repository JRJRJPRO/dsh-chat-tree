/**
 * 自定义节点图片：浏览器里先光栅化成 PNG，再交给 host 存。
 *
 * ⚠️ 绝不能把用户原文件直接传上去（SVG 里能写脚本）—— 过一遍 canvas 就只剩像素了。
 */
import { postJson } from './net.js'
import { ICON_EDGE, PICTURE } from './shapes.js'

/** 上传前的原图最大多少字节。太大的图光解码就能卡一下。 */
export const ICON_SOURCE_MAX = 4 * 1024 * 1024

/**
 * 把任意图片文件**光栅化**成 `ICON_EDGE` 见方的 PNG。
 *
 * 为什么不原样存用户的文件：
 *   · SVG 里可以写脚本。把它原样挂到同源地址上再当图片引，等于给自己开了个后门 ——
 *     过一遍 canvas 就只剩像素了。
 *   · 节点最大也就 32px 左右，存张 4000×3000 的原图纯属拿内存换零收益。
 * 尺寸**不限制，自动换算**：等比缩放塞进方框（contain），空出来的地方透明补齐，
 * 所以竖图横图都不会被拉变形。
 * @param file - 用户选的文件
 * @param edge - 目标边长
 * @returns PNG 的 base64（不带 `data:` 前缀）
 */
export function shrink(file, edge) {
	return new Promise((resolve, reject) => {
		if (file.size > ICON_SOURCE_MAX) {
			reject(new Error(`图太大了（${Math.round(file.size / 1024 / 1024)}MB），换张 ${ICON_SOURCE_MAX / 1024 / 1024}MB 以内的`))
			return
		}
		const source = URL.createObjectURL(file)
		const image = new Image()
		image.onload = () => {
			URL.revokeObjectURL(source)
			try {
				const canvas = document.createElement('canvas')
				canvas.width = edge
				canvas.height = edge
				const pen = canvas.getContext('2d')
				const zoom = Math.min(edge / image.width, edge / image.height)
				const w = Math.max(1, Math.round(image.width * zoom))
				const hgt = Math.max(1, Math.round(image.height * zoom))
				pen.drawImage(image, Math.round((edge - w) / 2), Math.round((edge - hgt) / 2), w, hgt)
				resolve(canvas.toDataURL('image/png').slice('data:image/png;base64,'.length))
			} catch (error) {
				reject(error)
			}
		}
		image.onerror = () => {
			URL.revokeObjectURL(source)
			reject(new Error('这个文件浏览器读不出来，换个 png / jpg / svg 试试'))
		}
		image.src = source
	})
}

/**
 * 把一张图传给 host 半存起来。
 * @param file - 用户选的文件
 * @returns 形状值 `img:<id>`
 */
export async function upload(file) {
	const data = await shrink(file, ICON_EDGE)
	// 这里**故意不吞异常**：传图是用户按下去的动作，失败了要在卡片上说一句
	// （SettingsCard 的 write() 会把 message 显示出来），而不是悄悄没反应。
	const body = await postJson('/icon', { data })
	if (body === undefined || typeof body.id !== 'string') throw new Error('host 没给回图片 id')
	return PICTURE + body.id
}
