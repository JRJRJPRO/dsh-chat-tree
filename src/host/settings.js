/**
 * 设置：命名空间 + schema。前端 `src/client/settings-model.js` 的 FIELDS 必须和这里对得上。
 *
 * 同一份 schema 喂给两代宿主（DESIGN.md「设置：两代宿主」）：
 *   · dsh 0.1.5：`settings.register(SETTINGS_NS, SETTINGS_SCHEMA)`，值存 `settings.yaml`
 *   · dsh 0.2（桌面版起）：插件 `export const Config`，宿主按它自动出表单，
 *     值存进 profile `cordis.patch.yml` 里我们这个 entry 的 `config`
 */
import Schema from 'schemastery'

/**
 * 设置命名空间。client.js 里的 SETTINGS_NS 必须和它一字不差。
 *
 * ⚠️ 0.2 起它同时还是 **cordis entry id**（`cordis.patch.yml` 里 `insert` 的那个 id）：
 *    宿主的设置表单按 entry id 分组，浏览器半 `configForms.get(SETTINGS_NS)` 要的也是它。
 *    三处（这里 / const.js / cordis.patch.yml）改一处就全断。
 */
export const SETTINGS_NS = 'dsh-chat-tree'

/**
 * 标成「在线可改」。
 *
 * 0.2 的宿主只把 `meta.volatile` 的字段投影成表单（dsh-settings 的 `volatileForm`），
 * 没标的字段既不显示、写了也被拒（"Config field … is not volatile"）。标了之后改值
 * **不会重挂插件** —— 我们 host 半根本不读 config（值全由浏览器半自己拉），所以
 * 每一项都能标。@deepseek-ai 那份 schemastery 有 `.volatile()`，npm 版没有，
 * 但两边读的都是 `meta.volatile`，用 `extra` 写进去效果一样。
 * @param schema - 一个字段
 * @returns 同一个字段，带 volatile 标记
 */
const live = (schema) => schema.extra('volatile', true)

/**
 * 显示范围是**三个字段**：量法 + 两种量法各自的上限。
 * 两个上限各记各的，来回切换量法不会把对方的值冲掉。
 * 前端滑杆只给这几档，但设置文件是人可以手改的，所以边界还是写在 schema 里。
 */
const FIELDS = {
	// 合法值由浏览器半的 FIELDS.accept 把关（和下面那几个 *Shape 一个道理）：
	// 手改进来一个认不得的量法不该把树搞崩，退回默认就行。
	visibleMode: Schema.string().default('depth').description('显示范围怎么量：depth = 按层高差，step = 按树上的无向步数'),
	// ⚠️ 上限 / 默认值和浏览器半 const.js 的 DEPTH / RADIUS 必须一致（test-contract.mjs 逐项核对）
	visibleDepth: Schema.natural().max(30).default(18).description('和当前这一轮差几层以内的节点才画出来；0 = 不省略'),
	visibleRadius: Schema.natural().max(60).default(30).description('离当前这一轮多少步以内的节点才画出来；0 = 不省略'),
	nodeScale: Schema.natural().min(50).max(250).default(100).description('节点、连线、列间距的整体缩放百分比'),
	sidebarFold: Schema.boolean().default(true).description('左侧会话列表按对话树折叠：一棵树一行，分支收在树头底下'),
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
	unreadColor: Schema.string().default('#3fb950').description('未读节点的颜色：别的分支跑完了你还没看的那一轮'),
	unreadShape: Schema.string().default('circle').description('未读节点形状'),
	emptyShape: Schema.string().default('circle').description('空节点形状；边框恒为虚线'),
	// 收藏不是第五个角色，但它的默认样子同样该能调。
	// ⚠️ 这两项**不分明暗**：这个色值上屏前会过一遍 `readable`（对当前底色不足 3:1
	// 就推到刚好够），所以一个色值就够，不需要亮色/暗色两版。
	favoriteColor: Schema.string().default('#ffd43b').description('收藏节点的默认颜色；描边和填充都是它，填充只是半透明版'),
	favoriteShape: Schema.string().default('star').description('收藏节点的默认图标；star = 五角星，也可以填预设形状 / char:<字> / img:<哈希>'),
}

export const SETTINGS_SCHEMA = Schema.object(Object.fromEntries(Object.entries(FIELDS).map(([name, field]) => [name, live(field)])))
