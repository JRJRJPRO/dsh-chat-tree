/**
 * 悬停详情卡，以及挂在它上面的「合并」清单。
 */
import { h, react } from './runtime.js'
import { C, Z } from './const.js'
import { branchAction } from './tree.js'

/** 就地重命名输入框。 */
export function InlineEdit(props) {
	const [draft, setDraft] = react.useState(props.initial)
	return h('input', {
		style: { flex: '1 1 auto', minWidth: 0, background: '#0d1117', color: '#fff', border: `1px solid ${C.blue}`, borderRadius: '4px', padding: '1px 5px', font: 'inherit', outline: 'none' },
		value: draft, autoFocus: true,
		onClick: (event) => event.stopPropagation(),
		onChange: (event) => setDraft(event.target.value),
		onBlur: () => props.onDone(draft.trim()),
		onKeyDown: (event) => {
			if (event.key === 'Enter') props.onDone(draft.trim())
			if (event.key === 'Escape') props.onDone(props.initial)
		},
	})
}

/**
 * 详情条：鼠标停在某个点上时从旁边平移淡入。
 *
 * 向左滑出（导轨贴着聊天区右缘，右边没有空间）。常驻挂载，否则过渡播不出来。
 * 自带 onMouseEnter 取消关闭计时，不然鼠标还没走到 ＋ 就消失了。
 */
export function Detail(props) {
	const { node, y, railWidth, labels, hold, release } = props
	const [editing, setEditing] = react.useState(false)
	const [merging, setMerging] = react.useState(false)
	react.useEffect(() => {
		setEditing(false)
		setMerging(false)
	}, [node])

	const shown = node !== null
	const isEmpty = shown && node.kind === 'empty'
	const key = !shown ? '' : isEmpty ? 'root' : node.key
	const fallback = !shown ? '' : isEmpty ? node.session.title || '未命名对话' : node.entry.prompt || `第 ${node.entry.turn} 轮`
	const text = labels[key] || fallback

	const button = (glyph, title, action) =>
		h('span', {
			key: glyph, title,
			style: { flex: '0 0 auto', cursor: 'pointer', color: C.muted, padding: '0 4px', fontSize: '13px' },
			onClick: (event) => { event.stopPropagation(); action() },
		}, glyph)

	return h(
		'div',
		{
			style: {
				position: 'absolute', right: `${railWidth + 4}px`, top: `${y}px`,
				transform: `translateY(-50%) translateX(${shown ? 0 : 8}px)`,
				opacity: shown ? 1 : 0,
				transition: 'opacity .14s ease, transform .14s ease',
				pointerEvents: shown ? 'auto' : 'none',
				width: `${Z.card}px`, maxWidth: '60vw',
				display: 'flex', alignItems: 'center', gap: '6px',
				background: C.bg, border: `1px solid ${C.line}`, borderRadius: '7px',
				boxShadow: '0 6px 20px rgba(0,0,0,.45)', padding: '6px 8px',
				font: '12.5px/1.45 -apple-system,"Segoe UI","PingFang SC",sans-serif', color: C.text,
			},
			onMouseEnter: hold,
			onMouseLeave: release,
			onDoubleClick: () => setEditing(true),
		},
		shown
			? [
					h('span', {
						key: 'n',
						title: isEmpty ? '' : `会话内第 ${node.entry.turn} 轮`,
						style: { flex: '0 0 auto', color: C.muted, fontSize: '11px', fontVariantNumeric: 'tabular-nums' },
					}, isEmpty ? '对话' : `#${node.no}`),
					// 撤回过的那一轮还画在树上（答完了才留），但它已经不在对话里，
					// 不挂个牌子的话点开只会看到一条"怎么滚不过去"的旧提问。
					!shown || node.rewound !== true
						? null
						: h('span', {
								key: 'r', title: '这一轮已被撤回，不在对话里了',
								style: {
									flex: '0 0 auto', color: C.muted, fontSize: '10px', lineHeight: '14px',
									border: `1px solid ${C.line}`, borderRadius: '3px', padding: '0 3px',
								},
							}, '撤回'),
					editing
						? h(InlineEdit, { key: 'i', initial: text, onDone: (value) => { setEditing(false); props.onRename(key, value) } })
						: h('span', { key: 't', style: { flex: '1 1 auto', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontWeight: isEmpty ? 600 : 400 } }, text),
					branchAction(node) === 'none' ? null : button('＋', '从这之后新开分支', () => props.onFork(node)),
					// 剪缝上的「接回去」—— 分离一直是单向的，拆出去就回不来了
					!shown || node.cut !== true ? null : button('⇤', '把这条支线接回原来那棵树', () => props.onJoin(node)),
					props.detachable ? button('⇥', '把这条支线拆成独立的一棵树', () => props.onDetach(node)) : null,
					// 合并整棵对话。挂在树根那个空节点上：合并是**整棵树对整棵树**的，
					// 不是某个节点对某个节点，挂在中间任何一个节点上都会让人以为"接到这儿"。
					!isEmpty || (props.targets || []).length === 0
						? null
						: button(merging ? '×' : '⊕', merging ? '收起' : '把别的对话合并进这棵树', () => setMerging(!merging)),
				]
			: null,
		!shown || !merging ? null : h(MergeList, {
			key: 'merge',
			targets: props.targets || [],
			railWidth,
			onPick: (target) => {
				setMerging(false)
				props.onMerge(target)
			},
		}),
	)
}

/**
 * 「把哪棵树合进来」的清单。
 *
 * 为什么不需要问"合到树里的哪个位置"：两棵树的节点互不相同（同一个问题重问一遍，
 * 答案也不会一样），合完就是两条链并排挂在同一个空根下 —— 只要知道是**哪两棵树**，
 * 结果就唯一确定了。所以这里只列树，不列节点。
 *
 * 列表是我们自己渲染的：宿主的会话列表既没有 `data-session-*`，也没有留给单行的 slot
 * （只有 sidebar.brand / footer / settings / workspaces 那几个），拖不了它的行。
 * 好在本 cwd 的全部对话本来就在 `/outlines` 的答复里，自己列就是了。
 */
export function MergeList(props) {
	const { targets, railWidth, onPick } = props
	return h(
		'div',
		{
			style: {
				position: 'absolute', right: `${railWidth + 4}px`, top: '100%', marginTop: '4px',
				width: `${Z.card}px`, maxWidth: '60vw', maxHeight: '40vh', overflowY: 'auto',
				background: C.bg, border: `1px solid ${C.line}`, borderRadius: '7px',
				boxShadow: '0 6px 20px rgba(0,0,0,.45)', padding: '4px',
				font: '12.5px/1.45 -apple-system,"Segoe UI","PingFang SC",sans-serif', color: C.text,
			},
		},
		targets.map((target) => {
			// 不能合并的那几条**留在单子里**，灰掉并把原因写在右边。
			// 直接不显示的话，用户只会觉得"我那条对话怎么不见了"，反而更慌。
			const stop = target.blocked !== undefined && target.blocked !== ''
			return h('div', {
				key: target.tree,
				title: stop ? target.blocked : target.joined ? '拆回独立的一棵树' : '合并进当前这棵树',
				style: {
					display: 'flex', alignItems: 'center', gap: '6px',
					padding: '4px 6px', borderRadius: '5px',
					cursor: stop ? 'not-allowed' : 'pointer',
					opacity: stop ? 0.45 : 1,
				},
				onMouseEnter: (event) => { if (!stop) event.currentTarget.style.background = C.line },
				onMouseLeave: (event) => { event.currentTarget.style.background = 'transparent' },
				onClick: () => { if (!stop) onPick(target) },
			},
			h('span', { key: 'g', style: { flex: '0 0 auto', color: C.muted, fontSize: '12px' } }, stop ? '⏳' : target.joined ? '⊖' : '⊕'),
			h('span', { key: 't', style: { flex: '1 1 auto', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, target.title || '未命名对话'),
			h('span', { key: 'n', style: { flex: '0 0 auto', color: C.muted, fontSize: '11px', fontVariantNumeric: 'tabular-nums' } }, stop ? target.blocked : `${target.turns} 轮`))
		}),
	)
}
