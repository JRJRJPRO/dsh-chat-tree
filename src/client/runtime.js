/**
 * 浏览器运行时：宿主注入的 react。
 *
 * bundle 里 `require` 是 `__ModuleLoader__` 交给 factory 的那个参数（见 build.mjs）；
 * 在 node 里跑离线测试时它根本不存在，于是这里全是 undefined。
 *
 * 所以约定是：**纯函数模块一律不 import 这个文件**，只有画界面的模块才碰 `h`。
 * 哪天某个 `*.js` 突然要用 react 了，先想想它是不是该拆成"算"和"画"两半。
 */

// `typeof` 不会因为 require 不存在而抛 ReferenceError —— 整个文件能同时在浏览器和
// node 里被加载，靠的就是这一行。
export const loaded = typeof require === 'function'

export const react = loaded ? require('react') : undefined

export const reactDom = loaded ? require('react-dom') : undefined

export const h = loaded ? react.createElement : undefined

export const portal = loaded ? reactDom.createPortal : undefined
