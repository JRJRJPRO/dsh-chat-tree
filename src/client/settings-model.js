/**
 * 设置项总表 + 设置 store。
 *
 * **加一项设置只动三个地方**：host 的 SETTINGS_SCHEMA、这里的 FIELDS、以及（外观类的）ROWS。
 * 卡片和 store 都是按表渲染的，不用改。
 */
import { RADIUS, SCALE, SETTINGS_NS } from './const.js'
import { warn } from './net.js'
import { ROLES, THEME, shapeSpec } from './shapes.js'

/** 省略半径的档位：5..30，最后一格是"不省略"。 */
export const STEPS = Array.from({ length: RADIUS.max - RADIUS.min + 1 }, (_, i) => RADIUS.min + i).concat([RADIUS.off])

/** 缩放的档位：50%..250%，每档 10。 */
export const SCALES = Array.from({ length: (SCALE.max - SCALE.min) / SCALE.step + 1 }, (_, i) => SCALE.min + i * SCALE.step)

/**
 * 一档的人话。
 * @param step - 档位值
 */
export function stepText(step) {
	return step === RADIUS.off ? '不省略' : `${step} 步`
}

/**
 * 缩放档位的人话。
 * @param step - 百分比
 */
export function scaleText(step) {
	return `${step}%`
}

export const isHex = (value) => typeof value === 'string' && /^#[0-9a-fA-F]{6}$/.test(value)

export const isShape = (value) => typeof value === 'string' && shapeSpec(value).value === value

/**
 * 卡片上的外观分组：一个角色一行，**左边颜色右边形状**，不再一项占一行。
 * 颜色和形状是同一个角色的两面，拆成两行既浪费竖直空间又要来回对照。
 */
export const ROWS = [
	{ key: 'normal', label: '普通节点', hint: '不在当前路径上的节点。' },
	{ key: 'current', label: '当前路径', hint: '当前这条路径的节点、连线，以及"正看着这一轮"的实心填充，都跟着这个颜色走。' },
	{ key: 'compact', label: '压缩节点', hint: '被 /compact 压缩掉的那一轮。四个角色的形状各自独立，设成一样就分不出来了。' },
	{
		key: 'empty',
		label: '空节点',
		hint: '树根那个"新对话"占位，在它上面按 ＋ 可以在同一棵树里再开一条。边框永远是虚线 —— 那是"还没说话"的记号，不跟着配置走。',
	},
	// `key` 就是 shapes.js 里的角色名，所以改哪两个设置字段、要不要画虚线，
	// 一律从 ROLES 查，不在这儿重写一遍
].map((row) =>
	Object.assign({}, row, {
		color: ROLES[row.key].color,
		shape: ROLES[row.key].shape,
		dashed: ROLES[row.key].dashed === true,
	}),
)

/**
 * 设置项总表。卡片按表渲染、store 按表取值 —— 加一项只改这张表和 host 的 schema。
 * `kind` 决定用哪种控件；`accept` 决定什么样的值算数（host 那边存的是任意 JSON）。
 */
export const FIELDS = [
	{ field: 'visibleRadius', kind: 'range', label: '显示范围', steps: STEPS, text: stepText, fallback: RADIUS.fallback, accept: Number.isFinite,
		hint: '离你正在看的那一轮多少步以内的节点才画出来。父节点算 1 步，父节点的另一个孩子算 2 步。' },
	{ field: 'nodeScale', kind: 'range', label: '节点大小', steps: SCALES, text: scaleText, fallback: SCALE.fallback, accept: Number.isFinite,
		hint: '点、连线、列间距、命中区一起等比例缩放。树太高时行距仍会被自动压扁。' },
	// 外观那八项是**算出来的**：每个角色两项（颜色 + 形状），字段名从 ROLES 查。
	// 以前这八行是手写的，于是同一个字段名在 ROLES / FIELDS / ROWS 里各写一遍，
	// 加第五个角色要改三处还不报错 —— 漏掉哪一处都是"设置里改了没反应"。
	...ROWS.flatMap((row) => [
		{ field: row.color, kind: 'color', label: `${row.label}颜色`, fallback: THEME[row.color], accept: isHex, hint: '' },
		{ field: row.shape, kind: 'shape', label: `${row.label}形状`, fallback: THEME[row.shape], accept: isShape, hint: '' },
	]),
]

/**
 * 半径的唯一来源。host 注册了 namespace 就跟着设置走，没有就用默认值。
 * 快照形状和宿主的 ObservableSnapshot 一样，好直接喂给 useObservable。
 *
 * ⚠️ 别在 `writable === false` 时把 `set` 删掉：第一帧几乎必然是
 *    `status:'loading'` + `writable:false`，删了就再也加不回来，滑杆永远是灰的。
 *    可写与否交给快照逐帧说了算，别做成一次性的。
 * @param ctx - 浏览器根 context
 */
export function settingsStore(ctx) {
	let scope
	const blank = () => {
		const values = {}
		const user = {}
		for (const spec of FIELDS) {
			values[spec.field] = spec.fallback
			user[spec.field] = false
		}
		return { values, user, writable: false, status: undefined, mode: undefined }
	}
	let state = blank()
	const listeners = new Set()
	const need = () => (scope === undefined ? Promise.reject(new Error('设置服务还没就绪')) : undefined)
	const store = {
		getSnapshot: () => state,
		subscribe: (fn) => {
			listeners.add(fn)
			return () => listeners.delete(fn)
		},
		set: (field, next) => need() || scope.set(field, next),
		reset: (field) => need() || scope.unset(field),
	}
	const same = (a, b) =>
		a.writable === b.writable && a.status === b.status && a.mode === b.mode &&
		FIELDS.every((spec) => a.values[spec.field] === b.values[spec.field] && a.user[spec.field] === b.user[spec.field])
	try {
		ctx.inject(['settingsScope'], (scoped) => {
			scope = scoped.settingsScope.bind({ namespace: SETTINGS_NS })
			const pull = () => {
				const snapshot = scope.getSnapshot() || {}
				const from = snapshot.value !== null && typeof snapshot.value === 'object' ? snapshot.value : {}
				const raw = snapshot.user !== null && typeof snapshot.user === 'object' ? snapshot.user : {}
				const next = blank()
				next.writable = snapshot.writable === true
				next.status = snapshot.status
				next.mode = snapshot.mode
				for (const spec of FIELDS) {
					if (spec.accept(from[spec.field])) next.values[spec.field] = from[spec.field]
					next.user[spec.field] = spec.field in raw
				}
				if (same(next, state)) return
				state = next
				for (const fn of listeners) fn()
			}
			pull()
			// 订阅要挂在 fiber 的 effect 上 —— ctx.inject 的回调返回值不当 disposer 用
			scoped.effect(() => scope.subscribe(pull), 'dsh-tree: 设置订阅')
		})
	} catch (error) {
		warn('设置服务不可用，按默认值画', error)
	}
	return store
}
