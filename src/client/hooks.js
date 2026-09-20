/**
 * 副作用钩子：量聊天区、跟踪当前轮次、订阅宿主快照、拉大纲。
 *
 * 这里是插件与"宿主 DOM / 宿主服务"的全部接触面。宿主改了版式，先来这儿找。
 */
import { react } from './runtime.js'
import { Z } from './const.js'
import { getJson, warn } from './net.js'

/**
 * 藏掉宿主自带的轮次导轨（否则两条叠一起谁也看不清）。
 * 类名带构建哈希，所以从它自己注入的 <style data-plugin-css> 里正则出前缀。
 * @returns 卸载函数
 */
export function hideNativeRail() {
	try {
		const source = document.querySelector('style[data-plugin-css*="TurnNavigator.module.css"]')
		if (source === null) return () => {}
		const matched = /\.([A-Za-z0-9]+)_slot\b/.exec(source.textContent || '')
		if (matched === null) return () => {}
		const tag = document.createElement('style')
		tag.dataset.dshTree = 'hide-native-rail'
		tag.textContent = `.${matched[1]}_slot{display:none !important}`
		document.head.appendChild(tag)
		return () => tag.remove()
	} catch {
		return () => {}
	}
}

/** 量聊天区滚动容器；量不到退回视口右缘。 */
export function useChatBox() {
	const [box, setBox] = react.useState(undefined)
	react.useEffect(() => {
		let raf = 0
		let observed
		let observer
		let goneAt = 0
		let graceTimer = 0
		const measure = () => {
			const el = document.querySelector('[data-conversation-scroll]')
			// ⚠️ 量不到**先别清空**。切会话时宿主会把聊天区卸了重挂，中间有几帧找不到容器；
			//    一清空导轨就掉到另一套几何、rowH 重算，整棵树跳一下再跳回来。
			//    但"一直找不到"是另一回事（用户开了设置页/全局面板），那时候得真的收起来。
			//    用 graceMs 区分这两种：短暂消失＝切会话，持续消失＝不在会话界面。
			if (el === null) {
				if (goneAt === 0) goneAt = Date.now()
				if (Date.now() - goneAt >= Z.graceMs) return setBox(undefined)
				clearTimeout(graceTimer)
				graceTimer = setTimeout(measure, Z.graceMs)
				return
			}
			goneAt = 0
			// ⚠️ 容器被换过就改盯新的：ResizeObserver 绑的是元素实例，旧元素卸载后它再也不会响，
			//    聊天区再变宽变高就只能等 800ms 的轮询兜底。
			if (observer !== undefined && el !== observed) {
				if (observed !== undefined) observer.unobserve(observed)
				observer.observe(el)
				observed = el
			}
			const rect = el.getBoundingClientRect()
			setBox((prev) =>
				prev && Math.abs(prev.top - rect.top) < 1 && Math.abs(prev.height - rect.height) < 1 && Math.abs(prev.right - rect.right) < 1
					? prev
					: { top: rect.top, height: rect.height, right: rect.right },
			)
		}
		const schedule = () => {
			cancelAnimationFrame(raf)
			raf = requestAnimationFrame(measure)
		}
		observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(schedule)
		measure()
		window.addEventListener('resize', schedule)
		const timer = setInterval(measure, 800)
		return () => {
			cancelAnimationFrame(raf)
			clearTimeout(graceTimer)
			if (observer) observer.disconnect()
			window.removeEventListener('resize', schedule)
			clearInterval(timer)
		}
	}, [])
	return box
}

/**
 * 跟踪「你现在看到的是第几轮」。
 * 取聊天区顶部往下 25% 的探针线，找最后一个顶边还在线以上的聊天行。
 * scroll 不冒泡，所以在 document 上用捕获阶段监听。
 */
export function useActiveTurn() {
	const [turn, setTurn] = react.useState(undefined)
	react.useEffect(() => {
		let raf = 0
		const measure = () => {
			const el = document.querySelector('[data-conversation-scroll]')
			if (el === null) return
			const box = el.getBoundingClientRect()
			const probe = box.top + Math.min(140, box.height * 0.25)
			let best
			for (const row of el.querySelectorAll('[data-chat-turn]')) {
				const value = Number(row.getAttribute('data-chat-turn'))
				if (!Number.isFinite(value)) continue
				const rect = row.getBoundingClientRect()
				if (rect.bottom < box.top) continue
				if (rect.top <= probe) best = value
				else {
					if (best === undefined) best = value
					break
				}
			}
			// ⚠️ 没量到任何一轮就保留上一次。切会话中间有几帧聊天行还没挂上，
			//    清成 undefined 的话 anchorNode 会退到“当前路径最深的点”，
			//    elide 的可视窗口跳到末端再跳回来 —— 又是一闪。
			if (best === undefined) return
			setTurn((previous) => (previous === best ? previous : best))
		}
		const schedule = () => {
			cancelAnimationFrame(raf)
			raf = requestAnimationFrame(measure)
		}
		measure()
		document.addEventListener('scroll', schedule, true)
		const timer = setInterval(measure, 400)
		return () => {
			cancelAnimationFrame(raf)
			document.removeEventListener('scroll', schedule, true)
			clearInterval(timer)
		}
	}, [])
	return turn
}

/** 订阅宿主 ObservableSnapshot。 */
export function useObservable(observable) {
	const valid = !!observable && typeof observable.getSnapshot === 'function' && typeof observable.subscribe === 'function'
	const [snapshot, setSnapshot] = react.useState(() => (valid ? observable.getSnapshot() : undefined))
	react.useEffect(() => {
		if (!valid) return undefined
		const update = () => setSnapshot(observable.getSnapshot())
		update()
		return observable.subscribe(update)
	}, [observable, valid])
	return snapshot
}

/**
 * 拉大纲；拉取期间保留旧数据，图不会闪空。
 *
 * ⚠️ `nonce` 不能省。重拉的条件里只有 cwd 和会话列表，而**改树形（分组/分离）
 *    不会动这两样** —— 没有它的话，分离要等到下一次发消息或切会话才顺带刷出来，
 *    用起来就是"点了没反应，过几秒突然全生效"。
 * @param cwd - 工作目录
 * @param listState - 会话列表快照
 * @param nonce - 手动催一次重拉
 * @returns 大纲，还没到就是 undefined
 */
export function useOutlines(cwd, listState, nonce) {
	const [data, setData] = react.useState(undefined)
	const [again, setAgain] = react.useState(0)
	const stamp = listState
		? `${(listState.ids || []).length}:${listState.current}:${(listState.ids || []).map((id) => (listState.byId[id] || {}).updatedAt).join(',')}`
		: ''
	react.useEffect(() => {
		if (!cwd) return undefined
		let alive = true
		const timer = setTimeout(() => {
			getJson('/outlines', { cwd })
				.then((body) => alive && setData(body))
				.catch((error) => warn('拉大纲失败，树停在上一帧', error))
		}, 120)
		return () => {
			alive = false
			clearTimeout(timer)
		}
	}, [cwd, stamp, nonce, again])

	// host 说"这条会话正在跑，这次没敢读它的撤回记录"（读旁车会打断那一轮，见 src/host/rewind.js）。
	// 撤回不写 dsh 日志，会话列表一点动静都没有，**不自己回来拉就永远等不到**：
	// 撤回完紧接着发的那一轮会一直画着撤回前的形状。跑完自然就读到了。
	react.useEffect(() => {
		const wait = rewindRetryDelay(data)
		if (wait === 0) return undefined
		const timer = setTimeout(() => setAgain((value) => value + 1), wait)
		return () => clearTimeout(timer)
	}, [data])
	return data
}

/**
 * 这次答复里有没有"撤回记录没读到"的会话。
 * @param outlines - /outlines 的响应体
 * @returns 是否还欠着
 */
export function isRewindPending(outlines) {
	return ((outlines && outlines.sessions) || []).some((item) => item.rewindPending === true)
}

/**
 * 隔多久回来再拉一次。
 *
 * 抽出来是为了能测：藏在 useEffect 里的话，改成"从不重拉"一条断言都不会响，
 * 而症状（撤回完那一轮的形状一直不更正）要人肉点半天才看得出来。
 * @param outlines - /outlines 的响应体
 * @returns 毫秒；0 = 不用再拉
 */
export function rewindRetryDelay(outlines) {
	return isRewindPending(outlines) ? Z.rewindMs : 0
}
