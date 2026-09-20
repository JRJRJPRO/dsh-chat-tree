/**
 * 设置 → 插件 → 插件配置 里的那张卡。
 *
 * 容器归我们自己画：宿主只铺一个 `<ul>` 再按 namespace 派发，所以根元素**必须是 `<li>`**。
 */
import { h, react } from './runtime.js'
import { CUSTOM, ICON_EDGE, PICTURE, preview } from './shapes.js'
import { upload } from './icon-upload.js'
import { useObservable } from './hooks.js'
import { useColorScheme } from './theme.js'
import { FIELDS, ROWS, themeFrom } from './settings-model.js'

/**
 * 宿主设置卡片的设计令牌，照抄 ui-settings-plugins 的 PluginCard / fields。
 * 值全是 `--dsw-alias-*` 变量而不是写死的色号 —— 换主题时跟着一起变。
 */
export const S = {
	card: (open, hover) => ({
		listStyle: 'none', borderWidth: '.5px', borderStyle: 'solid',
		borderColor: open || hover ? 'var(--dsw-alias-label-dimmed)' : 'var(--dsw-alias-border-l4)',
		background: open ? 'var(--dsw-alias-bg-layer-2)' : 'var(--dsw-alias-bg-layer-3)',
		borderRadius: '16px', transition: 'border-color .16s, background .16s',
	}),
	header: {
		appearance: 'none', width: '100%', font: 'inherit', color: 'inherit', textAlign: 'left',
		cursor: 'pointer', background: 'none', border: 0, borderRadius: '12px',
		display: 'flex', alignItems: 'center', gap: '12px', padding: '14px 16px',
	},
	headText: { display: 'flex', flexDirection: 'column', flex: 1, gap: '4px', minWidth: 0 },
	name: { color: 'var(--dsw-alias-label-primary)', fontSize: '15px', fontWeight: 600, lineHeight: 1.4 },
	description: { color: 'var(--dsw-alias-label-tertiary)', fontSize: '13px', lineHeight: 1.5 },
	chevron: (open) => ({ flex: 'none', color: 'var(--dsw-alias-label-tertiary)', transition: 'transform .16s', transform: open ? 'rotate(180deg)' : 'rotate(0deg)' }),
	body: { borderTop: '.5px solid var(--dsw-alias-border-l2)', margin: '0 16px', paddingBottom: '8px' },
	field: { display: 'flex', flexDirection: 'column', gap: '6px', padding: '12px 0' },
	fieldHead: { display: 'flex', alignItems: 'center', gap: '8px' },
	label: { flex: 1, minWidth: 0, color: 'var(--dsw-alias-label-primary)', fontSize: '13px', fontWeight: 500, lineHeight: 1.5 },
	value: { color: 'var(--dsw-alias-label-primary)', fontSize: '13px', fontVariantNumeric: 'tabular-nums' },
	tag: { border: '.5px solid var(--dsw-alias-border-l4)', borderRadius: '6px', padding: '0 6px', fontSize: '11px', lineHeight: '18px', color: 'var(--dsw-alias-label-secondary)' },
	reset: { font: 'inherit', color: 'var(--dsw-alias-label-secondary)', cursor: 'pointer', background: 'none', border: 'none', padding: 0, fontSize: '12px', lineHeight: 1.5 },
	range: (on) => ({ width: '100%', height: '34px', accentColor: 'var(--dsw-alias-brand-primary)', cursor: on ? 'pointer' : 'default' }),
	pair: { display: 'flex', alignItems: 'center', gap: '12px', flexWrap: 'wrap' },
	swatch: (on) => ({ flex: '0 0 56px', height: '26px', padding: 0, border: 'none', background: 'none', cursor: on ? 'pointer' : 'default' }),
	picks: { display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' },
	// 形状按钮：里面画的就是那个形状本身，所以按钮上不写任何字
	chip: (picked, on) => ({
		appearance: 'none', display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
		width: '28px', height: '28px', padding: 0, cursor: on ? 'pointer' : 'default', overflow: 'hidden',
		borderWidth: '.5px', borderStyle: 'solid',
		borderColor: picked ? 'var(--dsw-alias-brand-primary)' : 'var(--dsw-alias-border-l4)',
		background: picked ? 'var(--dsw-alias-bg-layer-2)' : 'none',
		borderRadius: '6px',
	}),
	own: (picked, on) => ({
		width: '58px', height: '26px', boxSizing: 'border-box', font: 'inherit', fontSize: '12px',
		textAlign: 'center', color: 'var(--dsw-alias-label-primary)', background: 'none',
		borderWidth: '.5px', borderStyle: 'solid',
		borderColor: picked ? 'var(--dsw-alias-brand-primary)' : 'var(--dsw-alias-border-l4)',
		borderRadius: '6px', cursor: on ? 'text' : 'default',
	}),
	hint: { color: 'var(--dsw-alias-label-tertiary)', margin: 0, fontSize: '12px', lineHeight: 1.5 },
	note: { color: 'var(--dsw-alias-label-tertiary)', margin: '12px 0 0', fontSize: '12px', lineHeight: 1.5 },
}

/** 和宿主同款的 14px 折角箭头（IconChevronDownOutline14）。 */
export function Chevron(props) {
	return h(
		'svg',
		{ width: 14, height: 14, viewBox: '0 0 14 14', fill: 'none', 'aria-hidden': true, style: S.chevron(props.open) },
		h('path', { d: 'M3.5 5.5 L7 9 L10.5 5.5', stroke: 'currentColor', strokeWidth: 1.25, strokeLinecap: 'round', strokeLinejoin: 'round' }),
	)
}

/**
 * 设置 → 插件 → 插件配置 里的那张卡。
 *
 * 容器归我们自己画 —— 宿主的契约是"带前端的插件自己拥有自己的卡"，它只铺一个
 * `<ul>` 再按 namespace 派发，所以这里**必须是 `<li>`**，样式也照抄 PluginCard：
 * 收起时只有标题+说明+箭头，点开才露出控件。
 * @param props.store - 半径 store
 */
export function SettingsCard(props) {
	const store = props.store || {}
	const state = useObservable(store) || {}
	const [open, setOpen] = react.useState(false)
	const [hover, setHover] = react.useState(false)
	const [failed, setFailed] = react.useState('')
	const dark = useColorScheme()

	const on = state.writable === true
	const values = state.values || {}
	const user = state.user || {}
	const write = (run) => {
		setFailed('')
		Promise.resolve()
			.then(run)
			.catch((error) => setFailed(String((error && error.message) || error)))
	}

	// 本地回显。写设置要绕 host 转一圈，拖色板时那一圈跟不上手 ——
	// 读数和预览会一直停在旧值上，看着就是"调完下面没跟着变"。
	// 所以先本地记一份立刻画上，等设置真的回到这个值再撤掉。
	const [draft, setDraft] = react.useState({})
	react.useEffect(() => {
		setDraft((now) => {
			const next = {}
			let dirty = false
			for (const field of Object.keys(now)) {
				if (values[field] === now[field]) dirty = true
				else next[field] = now[field]
			}
			return dirty ? next : now
		})
	}, [values])

	/** 取一项的当前值：优先本地回显，其次设置，存的认不得就用默认。 */
	const valueOf = (field) => {
		if (draft[field] !== undefined) return draft[field]
		const spec = FIELDS.find((one) => one.field === field)
		// 颜色和形状没被亲手改过时，实际画上去的是**方案色**（themeFrom 的规矩），
		// 这里也得显示方案色 —— 否则色板上写着 A、树上画的是 B，还以为坏了
		if (spec.kind === 'color' || spec.kind === 'shape') return themeFrom(values, user, dark)[field]
		return spec.accept(values[field]) ? values[field] : spec.fallback
	}

	/**
	 * 改一项：立刻回显，再写进设置。写失败就把回显撤掉，别让界面撒谎。
	 * @param field - 字段名
	 * @param next - 新值
	 */
	const put = (field, next) => {
		setDraft((now) => Object.assign({}, now, { [field]: next }))
		write(() =>
			Promise.resolve(store.set(field, next)).catch((error) => {
				setDraft((now) => {
					const back = Object.assign({}, now)
					delete back[field]
					return back
				})
				throw error
			}),
		)
	}

	/**
	 * 还原一项：回显也一起清掉。
	 * @param fields - 字段名
	 */
	const clear = (fields) => {
		setDraft((now) => {
			const back = Object.assign({}, now)
			for (const field of fields) delete back[field]
			return back
		})
		write(() => Promise.all(fields.map((field) => store.reset(field))))
	}

	/** 标题那一行：名字 + 读数 + 已修改 / 重置。`fields` 里任意一项被改过就算改过。 */
	const head = (label, text, fields) => {
		const changed = fields.some((field) => user[field] === true)
		return h('div', { key: 'hd', style: S.fieldHead }, [
			h('label', { key: 'l', style: S.label }, label),
			h('span', { key: 'v', style: S.value }, text),
			changed ? h('span', { key: 'g', style: S.tag }, '已修改') : null,
			changed
				? h('button', {
						key: 'r', type: 'button', style: S.reset, disabled: !on,
						onClick: () => clear(fields),
					}, '重置')
				: null,
		])
	}

	/** 滑杆那两项（显示范围 / 节点大小），仍然一项一行。 */
	const row = (spec) => {
		const now = valueOf(spec.field)
		const at = Math.max(0, spec.steps.indexOf(now))
		return h('div', { key: spec.field, style: S.field }, [
			head(spec.label, spec.text(spec.steps[at]), [spec.field]),
			h('input', {
				key: 'i', type: 'range', min: 0, max: spec.steps.length - 1, step: 1, value: at,
				disabled: !on, style: S.range(on),
				onChange: (event) => put(spec.field, spec.steps[Number(event.target.value)]),
			}),
			spec.hint === '' ? null : h('p', { key: 'p', style: S.hint }, spec.hint),
		])
	}

	/**
	 * 形状选择器：按钮里**画出形状本身**，不写"圆形""菱形"这种字，
	 * 而且跟着这一行选的颜色走 —— 按钮上看到的就是节点将来的样子。
	 * 预设后面跟两格自定义：传图片，或者填一个字符。
	 */
	const shapes = (field, now, color, dashed) =>
		h('div', { key: 'sp', style: S.picks }, [
			...SHAPES.map((one) =>
				h('button', {
					key: one.value, type: 'button', disabled: !on, title: one.value,
					style: S.chip(now === one.value, on),
					onClick: () => put(field, one.value),
				}, preview(one.value, color, 13, dashed)),
			),
			// 传图：选完立刻在浏览器里缩成 64×64 的 PNG 再上传，见 shrink()
			h('label', {
				key: 'img',
				title: `传一张图当节点。png / jpg / webp / svg 都行，尺寸不限 —— 会自动等比缩进 ${ICON_EDGE}×${ICON_EDGE}`,
				style: S.chip(String(now).startsWith(PICTURE), on),
			}, [
				String(now).startsWith(PICTURE)
					? preview(now, color, 15, dashed)
					: h('span', { key: 'p', style: { fontSize: '13px', lineHeight: 1, color: 'var(--dsw-alias-label-secondary)' } }, '🖼'),
				h('input', {
					key: 'f', type: 'file', accept: 'image/*', disabled: !on,
					style: { display: 'none' },
					onChange: (event) => {
						const file = event.target.files && event.target.files[0]
						event.target.value = '' // 同一个文件再传一次也要触发
						if (file === undefined || file === null) return
						write(() => upload(file).then((value) => put(field, value)))
					},
				}),
			]),
			// 填字：emoji 也行
			h('input', {
				key: 'own', type: 'text', maxLength: 4, disabled: !on,
				value: String(now).startsWith(CUSTOM) ? String(now).slice(CUSTOM.length) : '',
				placeholder: '填字', title: '填一个字符当节点，emoji 也行',
				style: S.own(String(now).startsWith(CUSTOM), on),
				onChange: (event) => {
					const text = event.target.value.trim()
					if (text === '') clear([field])
					else put(field, CUSTOM + text)
				},
			}),
		])

	/** 一个角色一行：左边颜色，右边形状。 */
	const pair = (spot) => {
		const color = valueOf(spot.color)
		return h('div', { key: spot.key, style: S.field }, [
			head(spot.label, String(color).toUpperCase(), [spot.color, spot.shape]),
			h('div', { key: 'bd', style: S.pair }, [
				h('input', {
					key: 'c', type: 'color', value: color, disabled: !on, style: S.swatch(on),
					onChange: (event) => put(spot.color, event.target.value),
				}),
				shapes(spot.shape, valueOf(spot.shape), color, spot.dashed === true),
			]),
			h('p', { key: 'p', style: S.hint }, spot.hint),
		])
	}

	return h('li', {
		style: S.card(open, hover),
		onMouseEnter: () => setHover(true),
		onMouseLeave: () => setHover(false),
	}, [
		h('button', { key: 'h', type: 'button', style: S.header, 'aria-expanded': open, onClick: () => setOpen(!open) }, [
			h('span', { key: 't', style: S.headText }, [
				h('span', { key: 'n', style: S.name }, '对话树'),
				h('span', { key: 'd', style: S.description }, '聊天区旁边那棵分支树的显示范围、大小与配色'),
			]),
			h(Chevron, { key: 'c', open }),
		]),
		open
			? h('div', { key: 'b', style: S.body }, [
					...FIELDS.filter((spec) => spec.kind === 'range').map(row),
					...ROWS.map(pair),
					failed === '' ? null : h('p', { key: 'e', style: S.note, role: 'status' }, `保存失败：${failed}`),
					on ? null : h('p', { key: 'w', style: S.note, role: 'status' }, `设置暂时不可写（状态 ${state.status || '未连接'}，模式 ${state.mode || '未知'}）。树按默认值画。`),
				])
			: null,
	])
}
