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
	// 配色方案。四个角色的颜色**默认跟着它走**，并且亮色/暗色各有一版；
	// 下面那几个 *Color 只有用户亲手改过才算数（见浏览器半的 themeFrom）。
	palette: Schema.string().default('graphite').description('配色方案：graphite 石墨 / teal 青竹；亮暗两套自动切换'),
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
})
