/**
 * dsh-chat-tree —— 「现在看到的是第几轮」怎么挑。
 *
 * 【导读】
 * 干嘛的：树上填实的那个点跟着聊天区的滚动走。规矩在 hooks.js 的 pickActiveTurn：
 * 探针线 + "末尾那轮整个在屏幕里就是它"。这里把 John 报的那几种情形钉死：
 *   · 线性 1-2-3-4，4 很短，滑到底 → 必须是 4（以前停在 3）
 *   · 3、4 各占半屏，都在屏幕里 → 4；点了 3 → 钉住 3，自己滚了才松
 *
 * 阅读顺序：
 *   第1步  取 client 的真函数
 *   第2步  pickActiveTurn：探针线、末轮、边界
 *   第3步  钉住：settlePin / nudgePin / pinActiveTurn
 *
 * 跑法：node tests/test-active.mjs
 *
 * @module test-active
 */

import { check, loadClientPure, report } from './test-kit.mjs'

// ===== 第 1 步：取 client 的真函数 =====

const pure = await loadClientPure()
const { pickActiveTurn, settlePin, nudgePin, pinActiveTurn, unpinActiveTurn, pinnedTurn, PIN_SLACK } = pure

/** 聊天区：顶 0，高 800。探针线在 140（25% = 200，取小的）。 */
const box = { top: 0, bottom: 800 }

/**
 * 按高度摆行：从 `start` 往下一行接一行。
 * @param heights - 每轮的高度，轮次号从 1 起
 * @param start - 第 1 行的 top
 */
const stack = (heights, start) => {
	let at = start
	return heights.map((height, index) => {
		const row = { turn: index + 1, top: at, bottom: at + height }
		at += height
		return row
	})
}

// ===== 第 2 步：pickActiveTurn =====

console.log('用例 1：探针线 —— 最后一个顶边还在线以上的那轮')
{
	// 四轮各 600px，滚到第 2 轮顶边在 100（线以上），第 3 轮在 700（线以下）
	const rows = stack([600, 600, 600, 600], -500)
	check(pickActiveTurn(rows, box) === 2, '顶边在探针线以上的最后一轮是 2')
	// 再往下滚 100：第 2 轮顶边到 0，第 3 轮 600 —— 还是 2
	check(pickActiveTurn(stack([600, 600, 600, 600], -600), box) === 2, '第 3 轮还没碰到探针线，仍是 2')
	// 第 3 轮顶边滚到 140 以内 → 3
	check(pickActiveTurn(stack([600, 600, 600, 600], -1100), box) === 3, '第 3 轮顶边过了探针线 → 3')
	// 线以上一个都没有（第一轮顶边在 300）→ 拿第一个露头的
	check(pickActiveTurn(stack([600, 600], 300), box) === 1, '线以上没有就拿第一个露头的')
}

console.log('用例 2：末尾那轮很短 —— 滑到底必须是它（John 报的）')
{
	// 1-2-3 各 600，4 只有 80；滚到底：4 的底边贴着 800
	const rows = stack([600, 600, 600, 80], 800 - 1880)
	check(rows[3].bottom === 800 && rows[3].top === 720, '摆法自检：4 在 720–800')
	check(pickActiveTurn(rows, box) === 4, `滑到底该是 4，实际 ${pickActiveTurn(rows, box)}`)
	// 往上滚 30px：4 的底边还在屏幕里（770）→ 仍是 4
	check(pickActiveTurn(stack([600, 600, 600, 80], 800 - 1880 - 30), box) === 4, '4 整个在屏幕里就是 4，不必贴底')
	// 往下（内容往上）—— 4 的底边被切掉了（bottom 820）→ 退回探针规则 → 3
	check(pickActiveTurn(stack([600, 600, 600, 80], 800 - 1880 + 20), box) === 3, '4 没整个露出来 → 按探针线是 3')
	// 容许 2px 误差（子像素滚动）
	check(pickActiveTurn(stack([600, 600, 600, 80], 800 - 1880 + 1.5), box) === 4, '差 1.5px 算贴底')
}

console.log('用例 3：3、4 各占半屏，两个都在屏幕里 → 4')
{
	const rows = stack([600, 600, 400, 400], 800 - 2000)
	check(rows[2].top === 0 && rows[3].bottom === 800, '摆法自检：3 在 0–400，4 在 400–800')
	check(pickActiveTurn(rows, box) === 4, '末轮整个在屏幕里 → 4')
	// 整段对话一屏装得下 → 恒指最新一轮
	check(pickActiveTurn(stack([100, 100, 100], 0), box) === 3, '一屏装得下时指最新一轮')
}

console.log('用例 4：边界 —— 空 / 坏轮次 / 末轮在屏幕外')
{
	check(pickActiveTurn([], box) === undefined, '一行都没有 → undefined')
	check(pickActiveTurn(undefined, box) === undefined, 'rows 缺席 → undefined')
	check(pickActiveTurn([{ turn: NaN, top: 0, bottom: 100 }, null, { turn: 2, top: 100, bottom: 200 }], box) === 2, '坏轮次跳过')
	// 末轮整个在屏幕下方（还没滚到）：不算
	check(pickActiveTurn(stack([600, 600, 80], 0), box) === 1, '末轮在屏幕外 → 按探针线')
	// 末轮整个滚过了顶（宿主底下有留白那种）：不算
	check(pickActiveTurn(stack([600, 80], -700), box) === undefined || pickActiveTurn(stack([600, 80], -700), box) === 2, '末轮滚过顶：不会挑出屏幕外的东西当"整个在屏幕里"')
}

// ===== 第 3 步：钉住 =====

console.log('用例 5：settlePin / nudgePin')
{
	const pin = { turn: 3, settled: undefined }
	check(nudgePin(pin, 500, PIN_SLACK) === pin, '没停稳之前怎么挪都不解（平滑滚动那几百毫秒）')
	const settled = settlePin(pin, 120)
	check(settled.turn === 3 && settled.settled === 120, '停稳记下位置')
	check(nudgePin(settled, 122, PIN_SLACK) === settled, '挪 2px 以内钉着')
	check(nudgePin(settled, 130, PIN_SLACK) === undefined, '挪超过 PIN_SLACK 解钉')
	check(nudgePin(settled, NaN, PIN_SLACK) === settled, '量不到位置不解')
	check(nudgePin(undefined, 0, PIN_SLACK) === undefined && settlePin(undefined, 0) === undefined, '没钉就是没钉')
	check(settlePin(pin, NaN).settled === undefined, '停稳时量不到就继续等')
}

console.log('用例 6：pinActiveTurn / unpinActiveTurn')
{
	unpinActiveTurn()
	check(pinnedTurn() === undefined, '一开始没钉')
	pinActiveTurn(3)
	check(pinnedTurn() === 3, '钉住 3')
	pinActiveTurn('x')
	check(pinnedTurn() === 3, '坏轮次不钉，也不把原来的冲掉')
	unpinActiveTurn()
	check(pinnedTurn() === undefined, '解钉')
	unpinActiveTurn()
	check(pinnedTurn() === undefined, '重复解钉不炸')
}

report()
