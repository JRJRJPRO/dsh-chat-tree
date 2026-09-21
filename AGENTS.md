# 给 AI 助手的上手文档

用法看 [README.md](README.md)。这份是**动代码之前要先知道的事**。
细的分两处：施工问题（改东西动哪几个文件）在 [ARCHITECTURE.md](ARCHITECTURE.md)，
设计取舍和踩过的坑在 [DESIGN.md](DESIGN.md)，宿主原生有什么能力在
[NATIVE-BASELINE.md](NATIVE-BASELINE.md)。

---

## 1. 它是什么

DeepSeek Harness（dsh）的插件，一个 npm 包，靠 `package.json` 里的 `dsh` 字段被识别。
分**两个半边**，跑在两个进程里：

| | 跑在哪 | 入口 | 源码 | 改完怎么生效 |
|---|---|---|---|---|
| host 半 | dsh 进程（node） | `index.js` | `src/host/*.js` | **重启 dsh** |
| 浏览器半 | 浏览器 | `client.js`（**生成物**） | `src/client/*.js` | `npm run build` + 刷新页面 |

> `client.js` **别手改**，下一次构建就冲掉了。它是 `node build.mjs` 把
> `src/client/*.js` 拼出来的 —— 浏览器半必须是一个文件，这是 dsh 的规矩。

host 半通过三条路由和浏览器半说话：`/plugins/dsh-tree/{outlines,shape,icon}`。
两边的约定只有一条：**出错一律 `{error: string}`**。

## 2. 装成可开发的样子

```sh
npm install                                        # 只有一个依赖：schemastery
dsh plugin --profile web add link:D:/绝对路径/dsh-tree
```

`node_modules/dsh-tree` 会是一个指向工作目录的符号链接：插件市场照样把它列进「已安装」，
而你改完 `npm run build` 刷新页面就见效，不用重装。

⚠️ **别再往 `cordis.patch.yml` 里写 `file:///…` 的 `insert`** —— 和上面的装法同时用，
同一个 id 会插两次，cordis 直接拒绝启动。

⚠️ 没有 `prepare` 脚本是**故意的**：`client.js` 是提交进仓库的成品，所以 git 安装不会
触发 pnpm 的构建闸（装的人不用去 `pnpm-workspace.yaml` 里加 `allowBuilds`）。
别加 `prepare`。

启用 / 停用写的是 profile 的 `cordis.patch.yml`：

```yaml
- id: dsh-tree
  disabled: true
```

约 1 秒生效，不用重启。停用时三条路由和 `agent/created` 监听一起消失
（`test-lifecycle.mjs` 盯着这件事）。

## 3. 测试

```bash
npm test                   # 先构建，再十三套一起跑

node test.mjs              # 真实会话日志跑整条渲染管线，--print 打印 ASCII 树
node test-highlight.mjs    # 高亮、hover intent、连线遮挡
node test-elide.mjs        # 省略的距离、行号压实、缩放
node test-layout.mjs       # 列距、贴右缘、横线去重、被浮层盖住时收起
node test-pointer.mjs      # 触摸设备：点按代替悬停、输入法、焦点守卫
node test-icon.mjs         # 自定义节点图片：只收 PNG、内容哈希、清理不误伤
node test-rewind.mjs       # 撤回：哪些轮该消失、哪些该成废弃支线
node test-merge.mjs        # 合并 / 接回去
node test-shape.mjs        # 拿真实会话跑合并 / 分离的端到端
node test-branch.mjs       # 把真实分支倒带到"刚出生"，重放接管逻辑
node test-http.mjs         # 路由外壳：信任围栏、方法分发、出错码、body 上限
node test-net.mjs          # 浏览器半：直连被拒时改走 /remote 通道
node test-lifecycle.mjs    # 启用 / 停用 / 再启用：两半都不许留东西
```

单独跑某一个之前记得 `npm run build` —— 测的是生成物 `client.js`。
`test-branch.mjs` 要读真实会话日志，不在默认位置时设 `DSH_HOME_REAL` 指过去，
否则它自己跳过。

> **加断言的规矩：写完先把被测的那行改坏，确认它真的变红，再改回来。**
> 这个项目里大部分 bug 的失败方式是静默的（树少画一个点、定时器活过插件），
> 一条永远绿的断言比没有断言更糟。

## 4. 不许放宽的几条

这几条都是真炸过才写下来的，改之前先读 DESIGN.md 里对应那一段：

1. **会话有轮次在跑，就一个字节都不许读它的旁车**（`src/host/rewind.js` 开头）。
   Windows 上开着读句柄，对面的原子 `rename` 就 EPERM，**整轮对话当场判失败且不重发**。
   别改成"只读文件尾"或"缩短读的时间"——窗口小了不等于没有。
2. **三条路由的鉴权必须问宿主的 `connection.requestRejection`**（`src/host/http.js`）。
   宿主的 webserver 不带任何鉴权，谁注册谁负责。拿不到判决要 fail-**closed**（503）。
   别改回手写 Host/Origin 判断 —— 那挡不住同网段直接 curl。
3. **浏览器半的 fetch 被拒时要能走 `/remote`**（`src/client/net.js`）。上面那道闸是
   loopback-only 的，手机靠这条路进来。改了 host 半的围栏记得同步改这里。
4. **`statusProbe` 是三态，别压成布尔**。读旁车时 `unknown` 当成在跑（fail-closed），
   拦合并时 `unknown` 当成空闲（fail-open）—— 压成布尔必然有一头是错的。
5. **删继承来的待办要精确到 id，不能 `inbox.clear()`**。dsh 重启会 resume 每个会话、
   同样触发 `agent/created`，那时队列里可能躺着用户自己排的待办。

## 5. 已知问题（按优先级）

**P0**

- 改名 / 收藏 / 收藏图标 / 收藏颜色**四样都存在 localStorage**，而分组、形状、图片文件
  在 `$DSH_HOME/plugins/dsh-tree/` 下。后果：换浏览器或上手机，树在但标注全没；
  清缓存等于全丢，没有导出。图片更糟 —— 文件在盘上，引用它的表在 localStorage，
  新浏览器里没人引用就会被 LRU-32 清掉。
  修法：加一条 `/labels` 路由存 `labels.json`（规格照抄 `shape.js`），或用 `ctx.storage.domain`。
- **导轨拉不到数据时界面上零提示**（`hooks.js` 只 `warn` 到 console，`rail.js` 直接
  `return null`，整条导轨消失）。围栏引入后失败模式变多了（401 / 403 / 503），
  而那些错误信息写得很细却一个字都到不了用户眼前。

**P1**

- 自定义图片全局只留 32 张（`ICON_KEEP`），超了按 mtime 静默删，引用还在，节点变成画不出来
- `shape.json` 只增不减，删掉的会话永远留在 `groupOf` / `detached` 里
- `atomicWrite` 的 `rename` 失败时 `.tmp` 不清理，留孤儿文件
- `reshape` 是读-改-写，两个客户端并发会静默丢一个补丁
- 重启 dsh 会对每条 seeded 会话重跑 `adoptBranch`，父会话忙时可能给同一个 child 排多个补接定时器

**功能盲点**

`session.surface`（压缩之后模型实际还记得哪几轮）完全没用上。树现在画的是
"日志里有哪几轮"，一次压缩之后这两者就分叉了。要做是两层：日志仍然是唯一的正文来源
（官方明确说 surface 不能当 transcript），surface 只用来给节点盖一层记号。

## 6. 提交规矩

- **提交信息里不要加任何 AI 署名**（`Co-Authored-By` / `Generated with`）
- 一个提交一件事。文件重叠到没法拆时，宁可合成一个说清楚，也别切出跑不起来的中间提交
- 改了 `src/client/` 就把重新 build 过的 `client.js` 一起提交
