/**
 * 设置：命名空间 + schema。前端 `src/client/settings-model.js` 的 FIELDS 必须和这里对得上。
 */
import Schema from 'schemastery'

/** 设置命名空间。client.js 里的 SETTINGS_NS 必须和它一字不差。 */
export const SETTINGS_NS = 'dsh-tree'

/**
 * 只有一个字段：省略半径。0 = 不省略，否则 5..30。
 * 前端滑杆只给这几档，但设置文件是人可以手改的，所以边界还是写在 schema 里。
 */
export const SETTINGS_SCHEMA = Schema.object({
	visibleRadius: Schema.natural().max(30).default(12).description('离当前这一轮多少步以内的节点才画出来；0 = 不省略'),
	nodeScale: Schema.natural().min(50).max(250).default(100).description('节点、连线、列间距的整体缩放百分比'),
	// ⚠️ 下面这几个 *Color 的 default 只是"存进配置文件时的样子"。
	// 真正画树用的是浏览器半的 themeFrom：**没被用户亲手改过的，跟着亮色/暗色现算**。
	// 颜色存 `#rrggbb`，形状存 circle / rounded / square / diamond。
	// 这里只声明成字符串，合法值由浏览器半的 FIELDS.accept 把关 ——
	// 存进来一个认不得的值不该把树搞崩，而是退回默认。
	normalColor: Schema.string().default('#6e7681').description('不在当前路径上的节点颜色'),
	normalShape: Schema.string().default('circle').description('普通节点形状'),
	currentColor: Schema.string().default('#58a6ff').description('当前路径的节点、连线与当前轮填充色'),
	currentShape: Schema.string().default('circle').description('当前路径的节点形状'),
	compactColor: Schema.string().default('#ffa657').description('压缩节点颜色'),
	compactShape: Schema.string().default('triangle').description('压缩节点形状；也可以填 char:<字> 用任意字符当节点'),
	emptyColor: Schema.string().default('#58a6ff').description('树根那个"新对话"空节点的颜色'),
	emptyShape: Schema.string().default('circle').description('空节点形状；边框恒为虚线'),
	// 收藏不是第五个角色，但它的默认样子同样该能调。
	// ⚠️ 这两项**不分明暗**：这个色值上屏前会过一遍 `readable`（对当前底色不足 3:1
	// 就推到刚好够），所以一个色值就够，不需要亮色/暗色两版。
	favoriteColor: Schema.string().default('#ffd43b').description('收藏节点的默认颜色；描边和填充都是它，填充只是半透明版'),
	favoriteShape: Schema.string().default('star').description('收藏节点的默认图标；star = 五角星，也可以填预设形状 / char:<字> / img:<哈希>'),
})
