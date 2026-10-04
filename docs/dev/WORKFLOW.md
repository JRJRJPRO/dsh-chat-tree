# 多个 agent 一起改这个插件：怎么派活，怎么保证改不坏

这份文件回答的是**协作问题**：一件活怎么切成能派出去的卡、派给哪一级的 agent、
它交回来之前要过哪几道门。施工问题（改东西动哪几个文件）在 [ARCHITECTURE.md](ARCHITECTURE.md)，
设计取舍在 [DESIGN.md](DESIGN.md)，待办卡在 [BACKLOG.md](BACKLOG.md)。

---

## 1. 四道门：改坏了什么，谁会响

`npm test` 一条命令把四道门全过一遍（先 `npm run build`，再 lint，再跑全部测试）。
**每一道门抓的是不同类的错**，派活时要知道这张卡的改动会被哪道门兜住：

| 门 | 命令 | 抓什么 | 典型的"改坏了" |
|---|---|---|---|
| ① 规矩 lint | `node tools/lint.mjs` | ARCHITECTURE §4 那几条能机械查的：纯函数文件碰了 react、手拼节点 key、绕开 atomicWrite / route()、client.js 没重 build、漏 import、新文件没进文档 | 小模型"顺手"在 graph.js 里 import 了 h |
| ② 两半契约 | `tests/test-contract.mjs` | host 和浏览器各写一份、必须一致的东西：设置字段 / 默认值 / 上下限、路由路径、SETTINGS_NS = entry id = 包名、`__pure` 没有 undefined | 改了浏览器的默认值忘了 host 的 schema |
| ③ 纯函数 | `tests/test-*.mjs` 里的大多数 | 算法：建图、省略、几何、折叠、撤回、合并、HTTP 外壳、生命周期 | 树少画一个点、列距算错、停用后路由没摘 |
| ④ 组件交互 | `test-card.mjs` / `test-ui-settings.mjs`（用 `tests/kit/react-lite.mjs`）| 卡片两档、改名锁、输入法、按钮回调、设置卡写的字段 | 双击展开失效、保存按钮回调带错 key |

④ 是 2026-10-04 新加的：以前 UI 层一条断言都没有，所有卡片 bug 都靠 John 在桌面版里手点。
现在组件能在 node 里真的挂起来（见 §4）。

**没有门兜着的改动不要派给省 token 的 agent。** 要么先补门（写一条会红的测试），要么派给高性能的。

---

## 2. 一张任务卡长什么样

每张卡写进 [BACKLOG.md](BACKLOG.md)，派出去时**整张卡原样贴给 agent**，再附上下面 §3 的流程。
字段：

```
### T<编号>  <一句话标题>                                 级别：L1 / L2 / L3
症状      用户看到了什么（John 的原话最好）
根因      已经知道的话写出来；不知道就写"待查，从 X 文件入手"
改哪些    精确到文件；这张卡**只许**动这几个（ARCHITECTURE §5 的所有权）
不许碰    和别的卡会撞的文件 / 不许放宽的规矩（AGENTS §4 哪一条）
先写测试  往哪个 tests/test-*.mjs 里加什么断言；期望值能写死就写死
验收      `npm test` 全绿 + 这张卡新加的断言"改坏会红"（§3 第 4 步）+ 要不要真机看
坑        DESIGN.md 里对应的小节；以前在这儿栽过什么
```

**一张卡一件事**。两件事揉在一张卡里，agent 会把容易的那件做完就报完成。

---

## 3. 领了卡的 agent 必须走的流程

1. **读**：AGENTS.md §4（不许放宽的几条）→ ARCHITECTURE.md §2 里卡上点名的那几个文件的那几行 →
   卡上"坑"一栏指的 DESIGN.md 小节。别的不用读，省 token。
2. **先红**：按卡上"先写测试"把断言写进去，`npm run build && node tests/<那个文件>.mjs`，
   **确认它现在是红的**。红不了说明断言没写对，或者 bug 不在你以为的地方 —— 停下来报告，别硬改。
3. **再绿**：只改卡上列的文件。改 `src/client/` 之后要 `npm run build`（测的是生成物 client.js）。
4. **变异一次**：把你改的那行故意改坏（注掉、改个常量），跑那个测试，**看它变红**，再改回来。
   这个项目里大多数 bug 的失败方式是静默的，一条永远绿的断言比没有更糟（AGENTS §3）。
5. **全跑**：`npm test`。四道门任何一道红都不算完成。改了 `src/client/` 的话 `client.js` 也要一起交。
6. **报告**（固定格式，给派活的人看）：
   ```
   卡：T<编号>
   改了：<文件列表>
   新断言：<测试文件> 用例 N（变异过：改坏 X 会红）
   npm test：22 个文件全过 / 哪个红了为什么
   没做 / 拿不准：<一条一条列>
   要不要真机验证：是 / 否，看什么
   ```
   **"没做"那一栏必须填**。做了一半的卡比没做更麻烦，因为派活的人以为它完了。

**不许**：改卡上没列的文件（哪怕"顺手修一下"）、放宽 AGENTS §4 的任何一条、
把失败的测试改成通过来"修"、在提交信息里加 AI 署名（John 的公开仓库是求职作品集）。

---

## 4. 怎么写一条组件测试

组件从 `__pure` 里拿（`Detail` / `SettingsCard` / `Rail` / `NameField` / `FavIconRow` / `MergeList` 都挂出去了），
用 test-kit 的 `mount` 挂起来。完整例子看 `tests/test-card.mjs`，骨架是：

```js
import { check, dom, h, loadClient, mount, report, tick } from './test-kit.mjs'
const { __pure: pure } = await loadClient()

const log = []
const card = mount(h(pure.Detail, {
  node, y: 40, anchor: 60, railWidth: 56, labels: {},
  hold() {}, release: () => log.push('release'), onLock() {},
  favorites: new Set(), favIcons: {}, favColors: {},
  onRename: (key, value) => log.push(['rename', key, value]),
  /* …其余回调 */
}))

card.fire(card.el, 'onDoubleClick')                    // 派 React 事件，沿 parent 冒泡
const input = card.find((el) => el.tag === 'input')     // 按谓词找
card.byTitle('从这之后新开分支')                          // 按 title 找（按钮全靠 title 自述）
card.byText('保存')                                      // 按文字找（最深的那个）
input.value = '新名字'; card.fire(input, 'onChange', { target: input })
input.focus()                                           // 触发 onFocus，改 document.activeElement
dom.document.dispatch('pointerdown', { target: dom.body }) // 模拟"用户点了页面别处"
card.update(h(pure.Detail, { ...props, node: other }))  // 换 props 重画
await tick()                                            // 等 setTimeout(0) / microtask
card.unmount()                                          // 跑掉全部 effect cleanup
report()
```

**react-lite 能做什么、不能做什么**（`tests/kit/react-lite.mjs` 顶上也写着）：

- 能：useState / useRef / useEffect / useMemo / useCallback，同步重画，effect 的 cleanup，
  事件冒泡与 `stopPropagation`，`ref`，portal（原地渲染）。
- 不能：**没有真实布局**。`getBoundingClientRect()` 返回你喂给 `el.rect` 的值，CSS 不生效，
  `textOverflow: ellipsis` 不会真的截字。所以**布局类 bug 不测组件，测几何的纯函数**
  （`railLayout` / `glyphSpanFor` / `cardAnchor` 等，test-layout.mjs 是样板）。
- 不能：真实的焦点 / 输入法 / 滚动。能测的是"收到这个事件后组件做了什么决定"。
- `SettingsCard` 的 `store.set` 在 microtask 里调，派完事件要 `await tick()`。

**什么时候该拆纯函数，而不是写组件测试**：规则本身可以用"输入 → 输出"说清楚的
（该不该关卡片、该灰哪几颗按钮、省略到第几层），拆成纯函数进 `__pure`，用一条 `check` 钉死；
组件测试只钉"事件接上了、回调带对了参数"。`keepsCard` / `shouldRefocus` / `favSwatch` 就是这么拆出来的。

---

## 5. 级别：哪种卡给省 token 的 agent

| 级别 | 判据（全部满足才算） | 例子 |
|---|---|---|
| **L1 省 token** | 单个文件；有现成的 tests/test-*.mjs 可以往里加断言；卡上把期望值写死了；不碰两半契约、不碰存盘格式、不碰 react 以外的新依赖 | 改一个默认值并同步 schema；点卡片外收起（T4）；`atomicWrite` 的 .tmp 清理（T7） |
| **L2 普通** | 两三个文件、同一半边；要读一两节 DESIGN.md；测试文件可能要新建，但 kit 现成 | 空节点 key 按树区分（T1）；shape.json 清理（T8） |
| **L3 高性能** | 跨两半（host + 浏览器）、改数据格式 / key / 路由、新交互要自己定义语义、需要在桌面版真机看效果、或"根因待查" | 自定义字的布局（T2）；删除节点（T3）；Rail 的组件级 smoke 测试（T6） |

两条经验：
- **"根因待查"的卡永远不是 L1。** 省 token 的模型会按卡上的猜测改，猜错了它不会回头。
- 一张 L3 卡做完常常会**掉出几张 L1 卡**（比如 T2 定好新布局规则后，各形状的让位量就是机械活）。
  先派 L3 的，等它交回来再切小卡。

---

## 6. 并行时怎么不打架

- 文件所有权按 ARCHITECTURE §5：一张卡只动自己列的文件。两张卡都要动 `rail.js` / `const.js` /
  `build.mjs` 的 `PARTS` 这三块公共地时，**串行派**，别并行。
- `client.js` 是生成物：合并冲突时别手合，解决完 `src/client/` 的冲突重跑 `npm run build`。
- 新加测试文件直接放进 `tests/`，`tests/run.mjs` 按文件名自动发现，不用登记。
  只跑自己那块：`node tests/run.mjs --only card,layout`。
- 新加 `src/client/*.js` 要同时登记进 `build.mjs` 的 `PARTS`（不登记构建报错）和
  ARCHITECTURE §2 的清单（不登记 lint 报错）；要碰 react 的还要进 `tools/lint.mjs` 的 `UI_PARTS`。
- 提交：一个提交一张卡，信息一句话写给用户看，**不加 AI 署名**（AGENTS §6）。

---

## 7. 真机验证（只有 L3 和改了视觉的卡才需要）

离线测试不替代眼睛。改了布局、颜色、动效的卡，交回来要在桌面版里看一眼：

- 桌面版装法见 AGENTS.md §2（`link:` 本地目录；浏览器半 `npm run build` 后 Ctrl+R，host 半要完全重启）。
- 页面控制台敲 `__dshTree()` 把当前树的真实状态倒出来（每个节点的角色、血缘、省略范围）。
- John 的机器是 Windows 11 + 深色主题 + 中文输入法；文字截断、输入法这类问题要在这台机器上复现。
