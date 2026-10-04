/**
 * 设置卡（ui-settings.js 的 SettingsCard）—— 用 react-lite 挂起来测。
 *
 * 【导读】
 * 干嘛的：设置卡是"按 FIELDS 表渲染"的，所以最容易出的 bug 是"表改了卡没跟上"
 * （少一项、读数不对、滑杆改了写错字段）。这里喂一个假 store，看它画了什么、
 * 拖滑杆点按钮之后往 store 写了什么。
 *
 * 阅读顺序：
 *   第1步  假 store
 *   第2步  用例 1：不可写时说明原因、控件全禁用
 *   第3步  用例 2：可写时每一项都在；默认读数是 18 层（按层数）
 *   第4步  用例 3：滑杆 / 量法按钮 / 开关 写的是对的字段和档位值
 *   第5步  用例 4：改过的项有「已修改」和「重置」；重置写 reset(field)
 *   第6步  用例 5：色值框和形状格子
 *
 * 跑法：node tests/test-ui-settings.mjs
 *
 * @module test-ui-settings
 */

import { check, h, loadClient, mount, report, tick } from './test-kit.mjs'

const { __pure: pure } = await loadClient()
const { SettingsCard, FIELDS, ROWS, SCALES, STEPS, LAYERS } = pure

// ===== 第 1 步：假 store =====

/**
 * 一个 settingsStore 形状的假货：快照可改、写入记账。
 * @param snapshot - 初始快照的覆盖项
 */
function fakeStore(snapshot) {
	const values = {}
	for (const spec of FIELDS) values[spec.field] = spec.fallback
	let state = Object.assign({ values, user: {}, writable: true, status: 'ready', mode: 'host' }, snapshot || {})
	const fans = new Set()
	const writes = []
	return {
		writes,
		getSnapshot: () => state,
		subscribe: (fn) => {
			fans.add(fn)
			return () => fans.delete(fn)
		},
		set: (field, value) => {
			writes.push(['set', field, value])
			return Promise.resolve()
		},
		reset: (field) => {
			writes.push(['reset', field])
			return Promise.resolve()
		},
		push: (next) => {
			state = Object.assign({}, state, next)
			for (const fn of fans) fn()
		},
	}
}

const open = (store) => mount(h(SettingsCard, { store, section: true }))
// ⚠️ SettingsCard 的 write() 走 Promise.resolve().then(run)，store.set 在下一拍才被调 —— 派完事件要 await tick()
const ranges = (card) => card.findAll((el) => el.tag === 'input' && el.props.type === 'range')

// ===== 第 2 步：用例 1 =====
console.log('用例 1：不可写时说明原因，控件全禁用')
{
	const store = fakeStore({ writable: false, status: 'loading', mode: undefined })
	const card = open(store)
	const note = card.find((el) => el.props.role === 'status')
	check(note !== undefined && note.textContent.includes('暂时不可写') && note.textContent.includes('loading'), `不可写时该有一行说明带状态，实际 ${note && note.textContent}`)
	check(ranges(card).length > 0 && ranges(card).every((el) => el.props.disabled === true), '不可写时每根滑杆都该禁用')
	card.unmount()
}

// ===== 第 3 步：用例 2 =====
console.log('用例 2：可写时每一项都在；默认读数是 18 层')
{
	const store = fakeStore()
	const card = open(store)
	check(card.find((el) => el.props.role === 'status') === undefined, '可写时不该有"不可写"那行')
	for (const label of ['显示范围', '节点大小', '侧栏按对话折叠', ...ROWS.map((row) => row.label)]) {
		check(card.byText(label) !== undefined, `设置卡上该有「${label}」这一项`)
	}
	check(card.byText('18 层') !== undefined, '显示范围默认读数该是 18 层（按层数）')
	// 三根滑杆：按层数、按步数、节点大小
	const sliders = ranges(card)
	check(sliders.length === 4, `该有 4 根滑杆（层数 / 步数 / 大小 / 占位），实际 ${sliders.length}`)
	check(Number(sliders[0].props.max) === LAYERS.length - 1 && Number(sliders[1].props.max) === STEPS.length - 1, '两根范围滑杆的档数该等于档位表长度')
	check(Number(sliders[1].props.value) === STEPS.indexOf(pure.RADIUS.fallback), `按步数滑杆初始该停在默认档 ${pure.RADIUS.fallback}`)
	card.unmount()
}

// ===== 第 4 步：用例 3 =====
console.log('用例 3：滑杆 / 量法按钮 / 开关写的是对的字段和档位值')
{
	const store = fakeStore()
	const card = open(store)
	const [depth, step, size, band] = ranges(card)
	void band
	size.value = '2'
	card.fire(size, 'onChange', { target: size })
	await tick()
	check(store.writes.some((one) => one[0] === 'set' && one[1] === 'nodeScale' && one[2] === SCALES[2]), `拖节点大小到第 2 档该写 nodeScale=${SCALES[2]}，实际 ${JSON.stringify(store.writes)}`)
	check(card.byText(`${SCALES[2]}%`) !== undefined, '读数该立刻回显成新档位（不等 store 回来）')

	store.writes.length = 0
	// 默认选的是按层数；去拖按步数那根 → 既写档位也顺手切量法
	step.value = '3'
	card.fire(step, 'onChange', { target: step })
	await tick()
	check(store.writes.some((one) => one[1] === 'visibleRadius' && one[2] === STEPS[3]), `拖按步数滑杆该写 visibleRadius=${STEPS[3]}`)
	check(store.writes.some((one) => one[1] === 'visibleMode' && one[2] === 'step'), '拖没选中那半的滑杆该顺手把量法切过去')

	store.writes.length = 0
	depth.value = '4'
	card.fire(depth, 'onChange', { target: depth })
	await tick()
	check(store.writes.some((one) => one[1] === 'visibleDepth' && one[2] === LAYERS[4]), `拖按层数滑杆该写 visibleDepth=${LAYERS[4]}`)

	store.writes.length = 0
	card.fire(card.byText('按步数'), 'onClick')
	await tick()
	check(store.writes.some((one) => one[1] === 'visibleMode' && one[2] === 'step'), '点「按步数」该写 visibleMode=step')

	store.writes.length = 0
	const toggle = card.find((el) => el.props.role === 'switch')
	check(toggle !== undefined && toggle.props['aria-checked'] === true, '侧栏折叠的开关默认该是开的')
	card.fire(toggle, 'onClick')
	await tick()
	check(store.writes.some((one) => one[1] === 'sidebarFold' && one[2] === false), '点开关该写 sidebarFold=false')
	card.unmount()
}

// ===== 第 5 步：用例 4 =====
console.log('用例 4：改过的项有「已修改」和「重置」，重置写 reset(field)')
{
	const store = fakeStore({ user: { nodeScale: true } })
	const card = open(store)
	check(card.byText('已修改') !== undefined, 'user 层里有的字段该标「已修改」')
	const reset = card.byText('重置')
	check(reset !== undefined, '改过的项该有「重置」')
	card.fire(reset, 'onClick')
	await tick()
	check(store.writes.some((one) => one[0] === 'reset' && one[1] === 'nodeScale'), `重置该叫 reset('nodeScale')，实际 ${JSON.stringify(store.writes)}`)
	// store 推一帧"已经重置"的快照过来，标记该消失
	store.push({ user: {} })
	await tick()
	check(card.byText('已修改') === undefined, '快照里 user 清空后「已修改」该消失')
	card.unmount()
}

// ===== 第 6 步：用例 5 =====
console.log('用例 5：色值框和形状格子写的是这一行的字段')
{
	const store = fakeStore()
	const card = open(store)
	// 第一行是「普通节点」：它的色值框是第一个 maxLength=7 的文本框
	const hex = card.find((el) => el.tag === 'input' && el.props.maxLength === 7)
	check(hex !== undefined, '每行该有一个六位色值框')
	hex.value = 'ABCDEF'
	card.fire(hex, 'onChange', { target: hex })
	await tick()
	check(store.writes.some((one) => one[1] === ROWS[0].color && one[2] === '#abcdef'), `色值框打 ABCDEF 该写 ${ROWS[0].color}=#abcdef，实际 ${JSON.stringify(store.writes)}`)
	hex.value = 'AB'
	store.writes.length = 0
	card.fire(hex, 'onChange', { target: hex })
	await tick()
	check(store.writes.length === 0, '打到一半（AB）不该写任何东西')

	const diamond = card.byTitle('diamond')
	check(diamond !== undefined, '形状格子里该有 diamond')
	card.fire(diamond, 'onClick')
	await tick()
	check(store.writes.some((one) => one[1] === ROWS[0].shape && one[2] === 'diamond'), `点 diamond 该写 ${ROWS[0].shape}=diamond`)
	// 收藏那一行多一格 star
	check(card.byTitle('star') !== undefined, '收藏那一行该有 star 这一格')
	card.unmount()
}

report()
