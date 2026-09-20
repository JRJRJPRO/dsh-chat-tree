/**
 * 现在是亮色还是暗色。
 *
 * 宿主（dsh-client-ui-theme）把暗色标在 **`body[data-ds-dark-theme]`** 上，
 * 一整套 `--dsw-alias-*` 变量跟着换。中性色我们直接引用那些变量，所以**不需要**
 * 知道明暗；但**角色色**（普通/当前/压缩/空节点）要参与 `rgba()` 运算，
 * CSS 变量算不了，只能自己按明暗挑一套真实色值 —— 这个文件就为这件事存在。
 *
 * ⚠️ 别改成 `matchMedia('(prefers-color-scheme: dark)')`：宿主的主题是**可以手动
 *    指定**的（设置里选浅色/深色/跟随系统），跟系统偏好不一定一致。以 body 上那个
 *    属性为准才是宿主说了算。
 */
import { react } from './runtime.js'

/** 宿主标记暗色的那个属性。 */
const DARK_ATTRIBUTE = 'data-ds-dark-theme'

/**
 * 此刻是不是暗色。
 * @returns 是否暗色；在 node 里（离线测试）恒为 true，走默认那套
 */
export function isDark() {
	if (typeof document === 'undefined' || document.body === null || document.body === undefined) return true
	if (typeof document.body.hasAttribute !== 'function') return true
	return document.body.hasAttribute(DARK_ATTRIBUTE)
}

/**
 * 跟着宿主主题走。用户在设置里切明暗时**立刻**重画，不用刷新页面。
 * @returns 是否暗色
 */
export function useColorScheme() {
	const [dark, setDark] = react.useState(isDark)
	react.useEffect(() => {
		if (typeof MutationObserver === 'undefined' || typeof document === 'undefined' || !document.body) return undefined
		const check = () => setDark((was) => (was === isDark() ? was : isDark()))
		const observer = new MutationObserver(check)
		observer.observe(document.body, { attributes: true, attributeFilter: [DARK_ATTRIBUTE] })
		check()
		return () => observer.disconnect()
	}, [])
	return dark
}
