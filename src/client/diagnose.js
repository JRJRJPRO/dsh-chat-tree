/**
 * 自诊断：在浏览器控制台敲 `__dshTree()`，把这一帧的真实状态倒出来。
 *
 * 【为什么值得留着】"某些点莫名变白""这条分支怎么不见了"这类症状，光看代码猜不出来，
 * 而每猜错一轮都要重启一次 dsh。把当时的真实数据一次性打出来，通常一眼就能定位。
 *
 * 【为什么单独一个文件】它是**调试设施**，不是功能。塞在 Rail 里的时候，
 * 一坨中文字段名夹在渲染逻辑中间，读渲染的人得先跳过它。
 */

/**
 * 挂上 `window.__dshTree`。每帧覆盖一次，所以敲出来的永远是最新那一帧。
 *
 * ⚠️ 这里存的是**闭包**不是快照：敲下去那一刻才求值，拿到的是最后一次渲染的数据。
 * @param facts - 这一帧的各路状态，见下面的字段名
 */
export function installDiagnostics(facts) {
	if (typeof window === 'undefined') return
	window.__dshTree = () => {
		const { current, cwd, activeTurn, radiusText, view, scale, tuned, settings, picked, nodes, archived, sessionCount } = facts
		return {
			当前会话: current,
			工作目录: cwd,
			滑到第几轮: activeTurn,
			显示范围: radiusText,
			省掉几个: view.hidden,
			淡出几个: [...view.shown].filter((node) => view.dimOf.get(node) > 0).length,
			缩放: `${scale}%`,
			设置: `量法=${tuned.visibleMode} 层=${tuned.visibleDepth} 步=${tuned.visibleRadius} 缩放=${tuned.nodeScale} 可写=${settings.writable} 状态=${settings.status} 模式=${settings.mode}`,
			分支: picked.map(
				(item) =>
					`${shortId(item.id)} ← ${item.parentId ? shortId(item.parentId) : '根'} 岔路点=${item.forkTurn} 自有轮=${(item.turns || [])
						.filter((entry) => !entry.inherited)
						.map((entry) => entry.turn)
						.join(',')}`,
			),
			节点: nodes
				.filter((node) => node.entry !== undefined)
				.map((node) => `#${node.no} ${shortId(node.session.id)}轮${node.entry.turn} ${node.active ? '蓝' : '白'} 列${node.column}深${node.depth}`),
			归档: [...archived].map(shortId),
			列表里有几条会话: sessionCount,
		}
	}
}

/**
 * 会话 id 只取中间六位 —— 全写出来一行放不下三条分支，而这六位在一个 cwd 里够认人了。
 * @param id - 会话 id
 */
function shortId(id) {
	return String(id).slice(8, 14)
}
