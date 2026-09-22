# 代码放在哪，改东西该动哪几处

这份文件回答的是**施工问题**，不是设计问题：想加个功能，该打开哪个文件；
两个人（或两个 agent）同时改，怎么才不互相踩。

设计取舍和踩过的坑在 [DESIGN.md](DESIGN.md)，用法在 [README.md](README.md)。

---

## 1. 两个半边

| | 跑在哪 | 入口 | 源码 |
|---|---|---|---|
| host 半 | dsh 进程（node） | `index.js` | `src/host/*.js` |
| 浏览器半 | 浏览器 | `client.js`（**生成物**） | `src/client/*.js` |

host 半是普通 ESM，`index.js` 直接 import `src/host/`，没有构建。

浏览器半**必须是一个文件**：dsh 的客户端模块系统规定"一个包 = 一个 bundle"，
交给 factory 的 `require` 只解析已注册的模块 id，解析不了相对路径。
所以 `src/client/*.js` 由 `node build.mjs` 拼成 `client.js`。

> **`client.js` 别手改。** 下一次构建就把你的改动冲掉了。它顶上也写着这句话。

```bash
npm run build     # 重新拼 client.js
npm run watch     # 改哪个 part 就自动重拼（配合 dsh 的热重载，刷新浏览器即可）
npm test          # 先构建再跑十个测试脚本
```

改了 `src/host/` 或 `index.js` 要**重启 dsh**；只改 `src/client/` 的话
`npm run build` + 刷新浏览器就够了。

---

## 2. 文件清单

### host 半（`src/host/`）

| 文件 | 管什么 | 动它之前 |
|---|---|---|
| `paths.js` | 东西落在哪、`atomicWrite`、`readJsonFile` | 所有写盘都走 `atomicWrite`，别自己拼临时文件名 |
| `settings.js` | 设置 schema | 字段名要和 `src/client/settings-model.js` 的 `FIELDS` 一字不差 |
| `outline.js` | 把日志事件折成轮次大纲 | **全部的日志格式知识都在这儿**，别在别处解析事件 |
| `rewind.js` | 撤回过的轮次 | ⚠️ 顶上那段"读旁车会打断正在跑的那一轮"的规矩**不许放宽** |
| `shape.js` | 哪几条对话算一棵树、哪条支线被拆了 | 存盘格式改了要能读老数据 |
| `icons.js` | 自定义节点图片 | 只收 PNG，id 只认 32 位十六进制（要拼进文件名） |
| `lineage.js` | 血缘表（跨模块共享的可变状态） | 就一个 Map，别往里加逻辑 |
| `graft.js` | 把外部引擎的记忆嫁接给新分支 | ⚠️ 里面记着一条**还没修**的同类风险 |
| `adopt.js` | 新分支一出生就接管 | 全同步，不许有时间窗 |
| `collect.js` | 组装 `/outlines` 的响应体 | |
| `http.js` | 路由外壳 + 信任围栏 | 加路由走 `route()`，别自己 `webServer.register`（那样就绕过了鉴权）|

### 浏览器半（`src/client/`）

顺序就是 `build.mjs` 里 `PARTS` 的顺序，也是依赖顺序（下面的可以用上面的）：

| 文件 | 管什么 |
|---|---|
| `const.js` | 设置命名空间、滑杆档位、基准尺寸 `Z`、配色 `C` |
| `runtime.js` | 宿主给的 react（**只有画界面的模块才 import 它**） |
| `net.js` | 三个路由的地址 + `getJson` / `postJson` / `warn`；直连被围栏拒了改走 `/remote`（`apiPrefix()` 供 CSS url 用）|
| `pointer.js` | 这块屏能不能悬停（`useHover`）、手指戳一下算什么（`tapNext`）、WebKit 必补的样式表 |
| `labels.js` | 节点上的用户标注：改名 + 收藏 + 收藏图标（都存 localStorage，半成品，见文件头） |
| `tree.js` | 选树、归组、节点 key、`shapeOps`、节点上能做什么 |
| `graph.js` | `buildGraph` —— 唯一一处定义"图长什么样" |
| `elide.js` | 省略 + 鱼眼淡出 |
| `shapes.js` | 角色表 `ROLES`、12 个预设形状、配色、`dotStyle`；收藏图标的解析 `favShape` |
| `geometry.js` | 导轨尺寸 `railLayout`、连线分段、命中测试 |
| `icon-upload.js` | 传图前在浏览器里光栅化 |
| `diagnose.js` | `window.__dshTree()` 自诊断 |
| `hooks.js` | 量聊天区、跟踪当前轮次、订阅宿主快照、拉大纲 |
| `settings-model.js` | 设置项总表 + store |
| `ui-detail.js` | 悬停详情卡（收起／展开两档）、改名框、收藏图标选择器、合并清单 |
| `ui-settings.js` | 设置卡片 |
| `rail.js` | 树本体 |
| `pure.js` | 离线测试出口 `__pure` |
| `apply.js` | 宿主 API 转调层 + 挂 slot |

---

## 3. 加东西要动哪几处

| 想做什么 | 动这些 |
|---|---|
| 加一项设置 | `src/host/settings.js` 的 schema + `src/client/settings-model.js` 的 `FIELDS` |
| 加一个节点角色（比如"出错的那一轮"） | `src/client/shapes.js` 的 `ROLES` + `THEME` 两个默认值 + `settings-model.js` 的 `ROWS` + host 的 schema。**画的那三个函数一行都不用改** |
| 加一个 HTTP 路由 | `index.js` 里一个 `route(ctx, '/xxx', {GET, POST})`，逻辑放进对应的 `src/host/*.js` |
| 加一种改树形的动作 | `src/client/tree.js` 的 `shapeOps` 加一条 + `src/host/shape.js` 的 `reshape` 认它 |
| 加一个浏览器半的模块 | 新建 `src/client/xxx.js` + 往 `build.mjs` 的 `PARTS` 里登记（不登记会**直接报错**，不会静默） |
| 加一个纯函数并想测它 | 写完往 `src/client/pure.js` 的 `__pure` 里加一行 |

---

## 4. 不许破的几条规矩

1. **`client.js` 是生成物。** 改 `src/client/`，然后 `npm run build`。
2. **浏览器半的顶层名字全局唯一。** 所有 part 拼进同一个作用域，重名是当场语法错误 ——
   构建会指名道姓告诉你是哪两个文件撞了。
3. **`import` 要写全。** 漏了的话 bundle 照样能跑（同一个作用域），但 node 单独
   import 那个文件时会炸。构建会把漏掉的 import 列出来提醒（只提醒，不拦着）。
4. **纯函数不 import `runtime.js`。** 碰了 react 就没法离线测了。
   一个模块要是既要算又要画，先想想是不是该拆成两半。
5. **写盘走 `atomicWrite`，读 JSON 走 `readJsonFile`**（`src/host/paths.js`）。
6. **出错一律 `{error: string}`**：host 的 `http.js` 和浏览器的 `net.js` 两边都认这个字段。
7. **`src/host/rewind.js` 顶上那段警告照做**：会话在跑就一个字节都不读。
   违反它的代价是**用户正在跑的那一轮当场失败**，而且 dsh-claude 故意不重发。
8. 换行统一 LF（`.gitattributes` 钉死）。

---

## 5. 一个人改一块，怎么不打架

按上面的清单，绝大多数改动落在**单个文件**里：

- 改省略/鱼眼 → `elide.js`
- 改配色形状 → `shapes.js`
- 改导轨尺寸、连线 → `geometry.js`
- 改合并/分离 → `tree.js`（浏览器）+ `shape.js`（host）
- 改设置卡片 → `ui-settings.js`
- 改撤回 → `rewind.js`
- 改触摸／Safari 上的行为 → `pointer.js`（判据和两张样式表只此一份）

三个文件是**公共地**，改之前先问一句是不是真的非改不可：

- `src/client/const.js`（`Z` / `C` 谁都在用）
- `src/client/rail.js`（组装层，谁加功能都想往这儿塞）
- `build.mjs` 的 `PARTS`（加 part 必须改，所以冲突多半是**两个人同时加了 part**，
  合并时把两行都留下就行）

`client.js` 是生成物，**冲突了别手动合**：解决完 `src/client/` 的冲突，
重跑 `npm run build` 覆盖它。

---

## 6. 装出去之后：启用 / 停用

插件市场的「已安装」列表读的是 **profile `package.json` 的 `dependencies`**
（`dshmarket` 的 `readInstalled()`）。所以只往 `cordis.patch.yml` 里写一条
`file:///` 的 `insert` 是**看不见的** —— 那不是依赖，只是一条补丁。

市场里的开关做两件事，我们要配合的是第二件：

| 它做什么 | 对我们的要求 |
|---|---|
| 热挂载 / 卸载我们的 fiber | `apply()` 登记的每样东西都必须挂在 fiber 上，dispose 时自动收 |
| 往 `cordis.patch.yml` 写 `- id: dsh-tree / disabled: true\|false` | 我们的 `cordis.patch.yml` 只 `insert` 自己这一个 id |

第二条不只是整洁问题：市场按 `bundlePatchInsertedIds()` 决定给哪些 id 写
`disabled`，**只认 `insert:` 底下的行**。要是我们的 patch 还去 `config` 别人的行，
停用我们就会顺手把别人也关掉（dshmarket #147 踩过）。

`test-lifecycle.mjs` 钉的就是第一条：路由、`agent/created` 监听、设置 namespace、
两个 slot、`window.__dshTree`，装上要有、停用要没、再启用要能回来。
**设置 namespace 那条最要命** —— 没释放的话再启用会抛 `already registered`，
插件直接起不来，而这条路径只有"停用再启用"才会走到。

---

## 7. 测试

十个离线脚本，共用 `test-kit.mjs`（一条断言、一个收尾、一份"把浏览器半骗起来"的加载器）。

```js
import { check, report, loadClientPure } from './test-kit.mjs'
const pure = await loadClientPure()   // 只有要测浏览器半才需要
check(条件, '失败时打印什么')
report()                               // 最后一行
```

测的是**真代码**：浏览器半从生成物 `client.js` 的 `__pure` 取，host 半从 `index.js`
的 `__test` 取。所以 `npm test` 第一步就是 `npm run build` —— 否则改了 src 忘了构建，
测的还是上一版。
