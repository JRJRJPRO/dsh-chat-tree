/**
 * 两半之间的契约 —— host 半和浏览器半各写一份、必须一字不差的那些东西。
 *
 * 【为什么要有这个】这个插件分两个进程跑，很多东西两边各有一份：设置的字段名和默认值、
 * 路由的路径、命名空间 / entry id。以前靠文档里一句"必须和那边对得上"，于是 agent
 * 改了浏览器半的默认值、忘了 host 的 schema —— 设置卡上显示 18 层，重置后宿主却写回 10。
 * 这里把每一对都**逐项核对**，错一处就红，并且说清楚该改哪两个文件。
 *
 * 阅读顺序：
 *   第1步  设置：字段集合、默认值、上下限、volatile 标记
 *   第2步  路由：index.js 开的 和 浏览器半调的 必须是同一组
 *   第3步  身份：SETTINGS_NS = cordis entry id = 包名
 *   第4步  出口：__pure / __test 里没有 undefined（import 了没导出的名字会变成这样）
 *   第5步  发布：package.json 的 files 带全了运行需要的东西
 *
 * 跑法：node tests/test-contract.mjs
 *
 * @module test-contract
 */

import { readFileSync, readdirSync } from 'node:fs'
import { check, loadClientPure, report } from './test-kit.mjs'
import { SETTINGS_NS as HOST_NS, SETTINGS_SCHEMA } from '../src/host/settings.js'
import { __test } from '../index.js'

const pure = await loadClientPure()
const read = (file) => readFileSync(new URL(`../${file}`, import.meta.url), 'utf8')

// ===== 第 1 步：设置 =====
console.log('用例 1：设置字段 —— host schema 和浏览器 FIELDS 是同一组名字')
{
	const hostFields = Object.keys(SETTINGS_SCHEMA.dict).sort()
	const clientFields = pure.FIELDS.map((spec) => spec.field).sort()
	const onlyHost = hostFields.filter((name) => !clientFields.includes(name))
	const onlyClient = clientFields.filter((name) => !hostFields.includes(name))
	check(onlyHost.length === 0, `只在 host schema 里有：${onlyHost.join(', ')} —— 加进 src/client/settings-model.js 的 FIELDS（或 ROWS）`)
	check(onlyClient.length === 0, `只在浏览器 FIELDS 里有：${onlyClient.join(', ')} —— 加进 src/host/settings.js 的 schema`)
	console.log(`  ${hostFields.length} 个字段两边一致`)
}

console.log('用例 2：默认值 —— schema 的 default 和 FIELDS 的 fallback 逐项相等')
{
	for (const spec of pure.FIELDS) {
		const field = SETTINGS_SCHEMA.dict[spec.field]
		if (field === undefined) continue
		const hostDefault = field.meta.default
		check(Object.is(hostDefault, spec.fallback), `${spec.field}：host 默认 ${JSON.stringify(hostDefault)}，浏览器默认 ${JSON.stringify(spec.fallback)} —— 两边要一起改（src/host/settings.js ↔ src/client/const.js / shapes.js PALETTE）`)
	}
}

console.log('用例 3：上下限 —— 滑杆的档位表不许超出 schema 认的范围，也不许比它窄')
{
	const depth = SETTINGS_SCHEMA.dict.visibleDepth.meta
	const radius = SETTINGS_SCHEMA.dict.visibleRadius.meta
	const scale = SETTINGS_SCHEMA.dict.nodeScale.meta
	check(depth.max === pure.DEPTH.max, `visibleDepth：host max ${depth.max}，浏览器 DEPTH.max ${pure.DEPTH.max}`)
	check(radius.max === pure.RADIUS.max, `visibleRadius：host max ${radius.max}，浏览器 RADIUS.max ${pure.RADIUS.max}`)
	check(scale.min === pure.SCALE.min && scale.max === pure.SCALE.max, `nodeScale：host ${scale.min}..${scale.max}，浏览器 ${pure.SCALE.min}..${pure.SCALE.max}`)
	// 档位表里每一格 host 都得认：0（不省略）靠 natural() 的下限 0 放行
	const bad = (steps, meta) => steps.filter((step) => step < (meta.min === undefined ? 0 : meta.min) || step > meta.max)
	check(bad(pure.LAYERS, depth).length === 0, `LAYERS 里 host 不认的档位：${bad(pure.LAYERS, depth).join(',')}`)
	check(bad(pure.STEPS, radius).length === 0, `STEPS 里 host 不认的档位：${bad(pure.STEPS, radius).join(',')}`)
	check(bad(pure.SCALES, scale).length === 0, `SCALES 里 host 不认的档位：${bad(pure.SCALES, scale).join(',')}`)
	// 默认档必须在档位表里，否则滑杆第一帧就跳到第 0 格
	check(pure.LAYERS.includes(pure.DEPTH.fallback), `DEPTH.fallback=${pure.DEPTH.fallback} 不在 LAYERS 里`)
	check(pure.STEPS.includes(pure.RADIUS.fallback), `RADIUS.fallback=${pure.RADIUS.fallback} 不在 STEPS 里`)
}

console.log('用例 4：每个字段都标了 volatile —— 0.2 宿主只把 volatile 的字段投影成表单')
{
	for (const [name, field] of Object.entries(SETTINGS_SCHEMA.dict)) {
		check(field.meta.volatile === true, `${name} 没标 volatile（用 src/host/settings.js 的 live() 包一下），桌面版设置里会看不到它`)
	}
}

// ===== 第 2 步：路由 =====
console.log('用例 5：路由 —— index.js 开的路径和浏览器半调的是同一组')
{
	const hostRoutes = new Set([...read('index.js').matchAll(/route\(ctx,\s*'(\/[\w-]+)'/g)].map((one) => one[1]))
	const clientRoutes = new Set()
	for (const name of readdirSync(new URL('../src/client/', import.meta.url))) {
		const source = read(`src/client/${name}`)
		for (const one of source.matchAll(/(?:getJson|postJson)\(\s*'(\/[\w-]+)'/g)) clientRoutes.add(one[1])
		for (const one of source.matchAll(/\$\{API\}(\/[\w-]+)/g)) clientRoutes.add(one[1])
	}
	const onlyHost = [...hostRoutes].filter((path) => !clientRoutes.has(path))
	const onlyClient = [...clientRoutes].filter((path) => !hostRoutes.has(path))
	check(hostRoutes.size >= 4, `index.js 里只扫到 ${hostRoutes.size} 条 route() —— 正则没对上写法？`)
	check(onlyHost.length === 0, `host 开了但浏览器没人调：${onlyHost.join(', ')}`)
	check(onlyClient.length === 0, `浏览器在调但 host 没开：${onlyClient.join(', ')} —— index.js 里加一条 route(ctx, …)`)
	console.log(`  ${[...hostRoutes].sort().join(' ')}`)
}

// ===== 第 3 步：身份 =====
console.log('用例 6：SETTINGS_NS = cordis entry id = npm 包名，三处一字不差')
{
	const pkg = JSON.parse(read('package.json'))
	const patch = read('cordis.patch.yml')
	const id = /^\s*-\s*id:\s*(\S+)/m.exec(patch)
	check(HOST_NS === pure.SETTINGS_NS, `host SETTINGS_NS=${HOST_NS}，浏览器 SETTINGS_NS=${pure.SETTINGS_NS}`)
	check(id !== null && id[1] === HOST_NS, `cordis.patch.yml 的 insert id 是 ${id && id[1]}，该是 ${HOST_NS}`)
	check(pkg.name === HOST_NS, `package.json name=${pkg.name}，该是 ${HOST_NS}（0.2 宿主按 entry id 找设置表单）`)
	check(pkg.exports['./client'] === './client.js', 'package.json exports["./client"] 必须指向 ./client.js')
}

// ===== 第 4 步：出口 =====
console.log('用例 7：__pure / __test 里没有 undefined')
{
	const holes = Object.entries(pure).filter(([, value]) => value === undefined).map(([name]) => name)
	check(holes.length === 0, `__pure 里这些是 undefined（pure.js import 了一个没 export 的名字）：${holes.join(', ')}`)
	const hostHoles = Object.entries(__test).filter(([, value]) => value === undefined).map(([name]) => name)
	check(hostHoles.length === 0, `index.js 的 __test 里这些是 undefined：${hostHoles.join(', ')}`)
	// 组件也要在：UI 测试靠它们
	for (const name of ['Detail', 'SettingsCard', 'Rail']) check(typeof pure[name] === 'function', `__pure 里缺组件 ${name}`)
	console.log(`  __pure ${Object.keys(pure).length} 项，__test ${Object.keys(__test).length} 项`)
}

// ===== 第 5 步：发布 =====
console.log('用例 8：package.json 的 files 带全了运行需要的东西')
{
	const pkg = JSON.parse(read('package.json'))
	for (const need of ['index.js', 'client.js', 'src', 'cordis.patch.yml']) {
		check(pkg.files.includes(need), `package.json files 里缺 ${need} —— 装出去就跑不起来`)
	}
	check(pkg.scripts.test.includes('tests/run.mjs'), 'npm test 该走 tests/run.mjs（自动发现测试文件），别回退成 && 链')
	check(pkg.scripts.test.includes('tools/lint.mjs'), 'npm test 该先跑 tools/lint.mjs')
	check(pkg.scripts.prepare === undefined, '别加 prepare 脚本（AGENTS.md §2：git 安装会触发 pnpm 的构建闸）')
}

report()
