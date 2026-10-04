/**
 * 详情卡（ui-detail.js 的 Detail）—— 用 react-lite 真的挂起来测交互。
 *
 * 【导读】
 * 干嘛的：卡片的"两档"、改名时的锁、输入法、收藏这几件事以前只能在桌面版里手点。
 * 这里把组件挂进假 DOM，派事件、看它露出哪些按钮、回调被叫了没有。
 * 这也是**往后所有 UI 测试的样板**：怎么造节点、怎么挂、怎么派事件、怎么断言。
 *
 * 阅读顺序：
 *   第1步  造一棵小树，拿到真实的 graph 节点（和 Rail 喂给卡片的是同一种东西）
 *   第2步  挂卡片的小工具：把一堆回调都记成账
 *   第3步  用例 1：收起档只有 ＋ 和 ☆；双击展开才有改树形那几颗和名字框
 *   第4步  用例 2：换了节点卡片自动收起
 *   第5步  用例 3：改名 —— 框里有光标就上锁；改过字 ＋ 灰掉；保存回调带 key 和新名字
 *   第6步  用例 4：输入法拼字中途的 Enter 不算保存
 *   第7步  用例 5：鼠标离开 —— 锁着不关，没锁才关
 *   第8步  用例 6：收藏按钮带节点 key；树根节点的 key 和 graph 给的一致
 *   第9步  用例 7：合并清单只在树根、展开、且有目标时露面
 *   第10步 用例 8：展开着点卡片外面就收起；点卡片自己、或正在改名时不收
 *   第11步 用例 9：删除 —— 只在展开档；第一下摊开确认行，第二下才叫 onDelete；换节点确认行消失；有草稿时灰
 *
 * 跑法：node tests/test-card.mjs
 *
 * @module test-card
 */

import { check, dom, h, loadClient, mount, report, tick } from './test-kit.mjs'

const { __pure: pure } = await loadClient()
const { Detail, buildGraph, visibleTree, conversationOf, rootKeyOf } = pure

// ===== 第 1 步：造一棵小树 =====

let clock = 0
function branch(id, parentId, forkTurn, turns, extra) {
	clock += 1
	return Object.assign({
		id, cwd: '/x', parentId, createdAt: clock, forkTurn, title: `会话${id}`,
		turns: [
			...Array.from({ length: forkTurn === undefined ? 0 : forkTurn }, (_, i) => ({ turn: i + 1, seq: (i + 1) * 10, endSeq: (i + 1) * 10 + 5, time: i + 1, prompt: `#${i + 1}`, compact: false, inherited: true, done: true })),
			...turns.map((turn) => ({ turn, seq: turn * 10, endSeq: turn * 10 + 5, time: turn, prompt: `第${turn}问`, compact: false, inherited: false, done: true })),
		],
	}, extra || {})
}

/** A: 1-2-3-4；B 从 A 第 2 轮岔出，自有 3,4。站在 A 上建图。 */
function graphAB() {
	const A = branch('A', undefined, undefined, [1, 2, 3, 4])
	const B = branch('B', 'A', 2, [3, 4])
	const sessions = [A, B]
	const visible = new Set(['A', 'B'])
	const picked = conversationOf(visibleTree(sessions, visible), 'A')
	return buildGraph(picked, 'A')
}

const graph = graphAB()
const nodeOf = (key) => graph.nodes.find((node) => node.key === key)
const root = graph.nodes[0]
const a2 = nodeOf('A:2') // 岔路点，底下两个孩子 → 有 ＋
const b3 = nodeOf('B:3') // 分支头
check(root !== undefined && root.kind === 'empty', '第一个节点该是树根空节点')
check(a2 !== undefined && a2.children.length === 2, 'A:2 该有两个孩子（A:3 和 B:3）')

// ===== 第 2 步：挂卡片 =====

/**
 * 挂一张卡，所有回调都记账。
 * @param node - 停在哪个节点上
 * @param extra - 盖掉默认 props
 * @returns `{card, log, props, show(node)}`
 */
function openCard(node, extra) {
	const log = []
	const note = (name) => (...args) => log.push([name, ...args])
	const props = Object.assign({
		node, y: 40, anchor: 60, railWidth: 56, labels: {},
		hold: note('hold'), release: note('release'), onLock: note('onLock'),
		favorites: new Set(), favIcons: {}, favColors: {},
		starInk: '#ffd43b', defaultInk: '#ffd43b',
		onRename: note('onRename'), onFavorite: note('onFavorite'), onFavIcon: note('onFavIcon'), onFavColor: note('onFavColor'),
		onFork: note('onFork'), onJoin: note('onJoin'), onDetach: note('onDetach'), onMerge: note('onMerge'),
		onDelete: note('onDelete'), canDelete: true,
		targets: [], detachable: false,
	}, extra || {})
	const card = mount(h(Detail, props))
	return {
		card, log, props,
		show: (next, more) => card.update(h(Detail, Object.assign({}, props, { node: next }, more || {}))),
		titles: () => card.all().map((el) => el.props.title).filter((title) => typeof title === 'string' && title !== ''),
		nameField: () => card.find((el) => el.tag === 'input' && el.props.placeholder !== undefined && el.props.placeholder !== '字' && el.props.type !== 'color' && el.props.type !== 'text'),
	}
}

const FORK = '从这之后新开分支'
const STAR = '收藏这个节点（树上变成黄色五角星）'
const DETACH = '把这条支线拆成独立的一棵树'
const BLOCKED = '先保存或放弃这次改名'
const DELETE = '删除这条支线：归档它和底下的全部分支（可在宿主的归档列表里恢复）'

// ===== 第 3 步：用例 1 =====
console.log('用例 1：收起档只有 ＋ 和 ☆，双击展开才有改树形那几颗和名字框')
{
	const { card, titles, show } = openCard(a2, { detachable: true })
	check(card.byTitle(FORK) !== undefined, '岔路点上收起档该有 ＋')
	check(card.byTitle(STAR) !== undefined, '收起档该有 ☆')
	check(card.byTitle(DETACH) === undefined, `收起档不该有 ⇥（实际按钮：${titles().join(' / ')}）`)
	check(card.find((el) => el.tag === 'input') === undefined, '收起档不该有任何输入框')
	check(card.el.style.width === `${pure.Z.card}px`, `收起档宽度该是 Z.card=${pure.Z.card}，实际 ${card.el.style.width}`)

	card.fire(card.el, 'onDoubleClick')
	check(card.byTitle(DETACH) !== undefined, '双击展开后该露出 ⇥')
	const name = card.find((el) => el.tag === 'input' && el.props.placeholder === '第2问')
	check(name !== undefined, '展开后该有名字框，占位符是这一轮的提问')
	check(name !== undefined && name.value === '第2问', `名字框初值该是现名，实际 ${name && name.value}`)
	check(card.el.style.width === `${pure.Z.cardOpen}px`, '展开后卡片该加宽到 Z.cardOpen')

	// 再双击收起
	card.fire(card.el, 'onDoubleClick')
	check(card.byTitle(DETACH) === undefined, '再双击该收起，⇥ 消失')

	// 叶子节点没有 ＋（branchAction 为 none）
	show(nodeOf('A:4'))
	check(card.byTitle(FORK) === undefined, '叶子节点不该有 ＋')
	card.unmount()
}

// ===== 第 4 步：用例 2 =====
console.log('用例 2：换了节点，展开着的卡片自动收起')
{
	const { card, show } = openCard(a2)
	card.fire(card.el, 'onDoubleClick')
	check(card.find((el) => el.tag === 'input') !== undefined, '前提：展开了')
	show(b3)
	check(card.find((el) => el.tag === 'input') === undefined, '换节点后该回到收起档')
	check(card.byText('第3问') !== undefined, '卡片上的名字该换成新节点的提问')
	card.unmount()
}

// ===== 第 5 步：用例 3 =====
console.log('用例 3：改名 —— 框里有光标就上锁；改过字 ＋ 灰掉；保存回调带 key 和新名字')
{
	const { card, log } = openCard(a2)
	card.fire(card.el, 'onDoubleClick')
	const name = card.find((el) => el.tag === 'input')
	const lockCalls = () => log.filter((one) => one[0] === 'onLock').map((one) => one[1])
	check(lockCalls()[lockCalls().length - 1] === false, '展开但没碰框时不该锁')

	name.focus()
	check(lockCalls()[lockCalls().length - 1] === true, '光标进框就该 onLock(true) —— 不然鼠标飘出去卡片关了，字全进聊天框')
	check(card.byTitle(BLOCKED) === undefined, '只是进了框没改字，＋ 不该灰（没东西可丢）')

	name.value = '新名字'
	card.fire(name, 'onChange', { target: name })
	check(card.byTitle(BLOCKED) !== undefined, '改过字之后 ＋ 和 ☆ 该灰掉并说"先保存或放弃"')
	check(card.byText('保存') !== undefined && card.byText('不保存') !== undefined, '改过字之后该冒出 保存 / 不保存 两颗')
	check(card.el.style.borderColor === pure.C.accent, `有草稿时卡片边框该用强调色 ${pure.C.accent}，实际 ${card.el.style.borderColor}`)

	// 双击此刻不许收起（那是条静默丢弃的第三出口）
	card.fire(card.el, 'onDoubleClick')
	check(card.find((el) => el.tag === 'input') !== undefined, '有草稿时双击不许收起卡片')

	card.fire(card.byText('保存'), 'onClick')
	const renamed = log.find((one) => one[0] === 'onRename')
	check(renamed !== undefined && renamed[1] === 'A:2' && renamed[2] === '新名字', `保存该叫 onRename('A:2','新名字')，实际 ${JSON.stringify(renamed)}`)
	check(card.find((el) => el.tag === 'input') === undefined, '保存后卡片该收起')
	check(lockCalls()[lockCalls().length - 1] === false, '保存后该解锁')
	card.unmount()
}

// ===== 第 6 步：用例 4 =====
console.log('用例 4：输入法拼字中途的 Enter 不算保存，Esc 不算放弃')
{
	const { card, log } = openCard(a2)
	card.fire(card.el, 'onDoubleClick')
	const name = card.find((el) => el.tag === 'input')
	name.focus()
	name.value = 'zhong'
	card.fire(name, 'onChange', { target: name })
	card.fire(name, 'onCompositionStart')
	card.fire(name, 'onKeyDown', { key: 'Enter', nativeEvent: { isComposing: true } })
	check(log.find((one) => one[0] === 'onRename') === undefined, '拼字中途按 Enter 不该保存')
	check(card.find((el) => el.tag === 'input') !== undefined, '拼字中途按 Enter 不该收起卡片')
	card.fire(name, 'onCompositionEnd')
	name.value = '中'
	card.fire(name, 'onChange', { target: name })
	card.fire(name, 'onKeyDown', { key: 'Enter' })
	const renamed = log.find((one) => one[0] === 'onRename')
	check(renamed !== undefined && renamed[2] === '中', `拼字落地后按 Enter 该保存"中"，实际 ${JSON.stringify(renamed)}`)
	card.unmount()
}

// ===== 第 7 步：用例 5 =====
console.log('用例 5：鼠标离开 —— 锁着不关，没锁才关')
{
	const { card, log } = openCard(a2)
	card.fire(card.el, 'onMouseLeave')
	check(log.some((one) => one[0] === 'release'), '没锁时鼠标离开该叫 release')
	log.length = 0
	card.fire(card.el, 'onDoubleClick')
	const name = card.find((el) => el.tag === 'input')
	name.focus()
	card.fire(card.el, 'onMouseLeave')
	check(!log.some((one) => one[0] === 'release'), '框里有光标时鼠标离开**不许**叫 release')
	// 卡片上的 mousemove 不许冒泡到导轨（否则 hover intent 会把卡片挪走）
	const moved = card.fire(card.el, 'onMouseMove')
	check(moved.__stopped === true, '卡片上的 mousemove 必须 stopPropagation')
	card.unmount()
}

// ===== 第 8 步：用例 6 =====
console.log('用例 6：收藏按钮带节点 key；树根节点用 graph 给的 key')
{
	const { card, log } = openCard(a2)
	card.fire(card.byTitle(STAR), 'onClick')
	check(log.some((one) => one[0] === 'onFavorite' && one[1] === 'A:2' && one[2] === true), `☆ 该叫 onFavorite('A:2', true)，实际 ${JSON.stringify(log)}`)
	card.unmount()

	const empty = openCard(root)
	check(empty.card.byText('对话') !== undefined, '树根空节点的卡片第一格写"对话"')
	check(empty.card.byText('会话A') !== undefined, '树根空节点显示的是对话标题')
	empty.card.fire(empty.card.byTitle(STAR), 'onClick')
	const fav = empty.log.find((one) => one[0] === 'onFavorite')
	// ⚠️ 这里钉的是"卡片用的 key 和 graph 上的 key 是同一个"，不是钉 'root' 这个字面量。
	//    空节点 key 按树区分（BACKLOG T1）之后是 `root:<树根会话 id>`，由 graph.js 造 ——
	//    卡片不许自己拼 key。
	check(fav !== undefined && fav[1] === root.key && root.key === rootKeyOf('A'), `树根的收藏 key 该等于 graph 节点的 key（${root.key}），实际 ${fav && fav[1]}`)
	empty.card.unmount()
}

// ===== 第 9 步：用例 7 =====
console.log('用例 7：合并清单只在树根、展开、且有目标时露面')
{
	const targets = [{ tree: 2, root: 'Z', title: '另一棵', turns: 5, joined: false }]
	const { card, log } = openCard(root, { targets })
	const MERGE = '把别的对话合并进这棵树'
	check(card.byTitle(MERGE) === undefined, '收起档不该有 ⊕')
	card.fire(card.el, 'onDoubleClick')
	check(card.byTitle(MERGE) !== undefined, '树根展开后该有 ⊕')
	card.fire(card.byTitle(MERGE), 'onClick')
	const row = card.byText('另一棵')
	check(row !== undefined, '点 ⊕ 该摊开合并清单，列出目标树的标题')
	card.fire(row, 'onClick')
	check(log.some((one) => one[0] === 'onMerge' && one[1] === targets[0]), '点清单里一行该叫 onMerge(target)')
	check(card.byText('另一棵') === undefined, '选完一行清单该收起')
	card.unmount()

	const mid = openCard(a2, { targets })
	mid.card.fire(mid.card.el, 'onDoubleClick')
	check(mid.card.byTitle(MERGE) === undefined, '中间节点上没有 ⊕（合并是整棵树对整棵树）')
	mid.card.unmount()
}

// ===== 第 10 步：用例 8 =====
console.log('用例 8：展开着点卡片外面就收起；点卡片自己、或正在改名时不收')
{
	const { card } = openCard(a2)
	const named = () => card.find((el) => el.tag === 'input')
	card.fire(card.el, 'onDoubleClick')                         // 展开
	check(named() !== undefined, '双击该展开出名字框')
	dom.document.dispatch('pointerdown', { target: dom.body })  // 点卡片外
	check(named() === undefined, '点卡片外该收起')
	card.fire(card.el, 'onDoubleClick')
	dom.document.dispatch('pointerdown', { target: card.el })   // 点卡片自己
	check(named() !== undefined, '点卡片自己不该收起')
	named().focus()                                             // 改名中：框里有光标
	dom.document.dispatch('pointerdown', { target: dom.body })
	check(named() !== undefined, '改名中（框里有光标）点外面不许收 —— 会把字送进聊天框')
	card.unmount()

	// Rail 给了 onDismiss 的话，点外面是**整张卡消失**（Rail 清悬停），不是退回收起档
	const gone = openCard(a2, { onDismiss: () => gone.log.push(['onDismiss']) })
	gone.card.fire(gone.card.el, 'onDoubleClick')
	dom.document.dispatch('pointerdown', { target: gone.card.el })
	check(!gone.log.some((one) => one[0] === 'onDismiss'), '点卡片自己不该 onDismiss')
	dom.document.dispatch('pointerdown', { target: dom.body })
	check(gone.log.some((one) => one[0] === 'onDismiss'), '展开着点卡片外面该叫 onDismiss（整张卡消失）')
	gone.log.length = 0
	gone.card.fire(gone.card.el, 'onDoubleClick')
	gone.card.find((el) => el.tag === 'input').focus()
	dom.document.dispatch('pointerdown', { target: dom.body })
	check(!gone.log.some((one) => one[0] === 'onDismiss'), '改名中点外面不该 onDismiss')
	gone.card.unmount()
}

// ===== 第 11 步：用例 9 =====
console.log('用例 9：删除 —— 只在展开档；第一下摊开确认行，第二下才叫 onDelete(node, plan)；换节点确认行消失；有草稿时灰')
{
	const { deletePlan, deleteBlockedWhy } = pure
	// b3 是 B 的头一轮（分支头），B 自有 3、4 两轮、底下没别的会话 → 能删，名单就是 B 一条、2 轮
	const { card, log, show } = openCard(b3)
	const asking = () => card.find((el) => typeof el.textContent === 'string' && el.textContent.includes('归档这 1 条会话（2 轮）'))
	check(card.byTitle(DELETE) === undefined, '收起档不该有删除按钮')
	card.fire(card.el, 'onDoubleClick')
	check(card.byTitle(DELETE) !== undefined, '展开后分支头上该有删除按钮')
	check(asking() === undefined, '还没点删除，不该有确认行')

	card.fire(card.byTitle(DELETE), 'onClick')
	check(!log.some((one) => one[0] === 'onDelete'), '第一下不许真删')
	check(asking() !== undefined, '第一下该摊开确认行，写明归档几条会话、几轮')
	check(card.byText('删除') !== undefined && card.byText('取消') !== undefined, '确认行该有 删除 / 取消 两颗')
	check(card.find((el) => typeof el.textContent === 'string' && el.textContent.includes('恢复')) !== undefined, '确认文案要说明是归档、可恢复')

	card.fire(card.byText('取消'), 'onClick')
	check(asking() === undefined, '点取消确认行该收起')
	check(!log.some((one) => one[0] === 'onDelete'), '取消不许叫 onDelete')
	check(card.find((el) => el.tag === 'input') !== undefined, '取消后卡片仍是展开档')

	// 按了第一下之后把卡片收起再展开：那一下作废，不许还挂着确认行
	card.fire(card.byTitle(DELETE), 'onClick')
	check(asking() !== undefined, '前提：确认行开着')
	card.fire(card.el, 'onDoubleClick')
	card.fire(card.el, 'onDoubleClick')
	check(asking() === undefined, '收起再展开，上一次的第一下该作废')

	card.fire(card.byTitle(DELETE), 'onClick')
	card.fire(card.byText('删除'), 'onClick')
	const del = log.find((one) => one[0] === 'onDelete')
	check(del !== undefined && del[1] === b3, '第二下该叫 onDelete，第一个参数是节点')
	check(del !== undefined && del[2] !== undefined && del[2].sessions.join(',') === 'B' && del[2].turns === 2, `第二个参数是 deletePlan 的结果 {sessions:['B'], turns:2}，实际 ${JSON.stringify(del && del[2])}`)
	check(card.find((el) => el.tag === 'input') === undefined, '删完卡片该收起')
	card.unmount()

	// 换节点：确认行要跟着消失（它是"对这个节点"的第一下）
	const second = openCard(b3)
	second.card.fire(second.card.el, 'onDoubleClick')
	second.card.fire(second.card.byTitle(DELETE), 'onClick')
	check(second.card.byText('取消') !== undefined, '前提：确认行开着')
	second.show(nodeOf('D:3') || a2)
	check(second.card.byText('取消') === undefined, '换节点后确认行该消失')
	second.card.unmount()

	// 有草稿时和别的按钮一样灰掉，确认行也不许留着
	const typing = openCard(b3)
	typing.card.fire(typing.card.el, 'onDoubleClick')
	typing.card.fire(typing.card.byTitle(DELETE), 'onClick')
	const name = typing.card.find((el) => el.tag === 'input')
	name.value = '改了'
	typing.card.fire(name, 'onChange', { target: name })
	check(typing.card.byTitle(DELETE) === undefined, '有草稿时删除按钮该灰掉')
	check(typing.card.byText('取消') === undefined, '有草稿时确认行不许留着')
	typing.card.unmount()

	// 会话中间的一轮：按钮留在原地灰掉，title 说明为什么
	const mid = openCard(a2)
	mid.card.fire(mid.card.el, 'onDoubleClick')
	check(mid.card.byTitle(DELETE) === undefined, 'A:2 是 A 的中间一轮，不该有能按的删除')
	check(deleteBlockedWhy(a2) !== '' && mid.card.byTitle(deleteBlockedWhy(a2)) !== undefined, '中间一轮的删除按钮该灰掉并把理由写在 title 里')
	mid.card.fire(mid.card.byTitle(deleteBlockedWhy(a2)), 'onClick')
	check(mid.card.byText(deleteBlockedWhy(a2)) !== undefined, '戳灰按钮该把理由摊到卡片里（触摸设备看不到 title）')
	check(!mid.log.some((one) => one[0] === 'onDelete'), '灰按钮不许叫 onDelete')
	mid.card.unmount()

	// 树根空节点同理
	const empty = openCard(root)
	empty.card.fire(empty.card.el, 'onDoubleClick')
	check(empty.card.byTitle(DELETE) === undefined && empty.card.byTitle(deleteBlockedWhy(root)) !== undefined, '树根空节点的删除灰掉并说明')
	empty.card.unmount()

	// 宿主没有归档服务：整颗按钮不画（画一颗永远灰的只会招来"为什么按不了"）
	const bare = openCard(b3, { canDelete: false })
	bare.card.fire(bare.card.el, 'onDoubleClick')
	check(bare.card.byTitle(DELETE) === undefined && bare.card.find((el) => el.textContent === '✕') === undefined, '没有归档服务时不画删除按钮')
	bare.card.unmount()
	void deletePlan
}

// 焦点守卫挂在 document 上的监听，卸载后必须摘干净
await tick()
check(dom.document.listenerCount('pointerdown') === 0, `卸载后 document 上还留着 ${dom.document.listenerCount('pointerdown')} 个 pointerdown 监听`)

report()
