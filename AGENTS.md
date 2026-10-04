# 给 AI 助手的上手文档

用法看 [README.md](README.md)。这份是**动代码之前要先知道的事**。
细的分几处：施工问题（改东西动哪几个文件）在 [docs/dev/ARCHITECTURE.md](docs/dev/ARCHITECTURE.md)，
设计取舍和踩过的坑在 [docs/dev/DESIGN.md](docs/dev/DESIGN.md)，宿主原生有什么能力在
[docs/dev/NATIVE-BASELINE.md](docs/dev/NATIVE-BASELINE.md)。
**领了一张任务卡来干活的 agent**：先读 [docs/dev/WORKFLOW.md](docs/dev/WORKFLOW.md) §3 的流程，
卡在 [docs/dev/BACKLOG.md](docs/dev/BACKLOG.md)。

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

host 半通过四条路由和浏览器半说话：`/plugins/dsh-chat-tree/{outlines,shape,icon,labels}`。
两边的约定只有一条：**出错一律 `{error: string}`**。

## 2. 装成可开发的样子

```sh
npm install                                        # 只有一个依赖：schemastery
dsh plugin --profile web add link:D:/绝对路径/dsh-chat-tree
```

`node_modules/dsh-chat-tree` 会是一个指向工作目录的符号链接：插件市场照样把它列进「已安装」，
而你改完 `npm run build` 刷新页面就见效，不用重装。

**桌面版（dsh 0.2）**：profile 在 `$DSH_HOME/profiles/desktop`（没设 `DSH_HOME` 才是
`~/.dsh/…`；本机设了，和网页版共用同一个 home —— 会话、树形、旁车都是同一份），CLI 拒绝碰它。应用里
**设置 → 插件 → 安装** 填 `link:D:/绝对路径/dsh-chat-tree`；或者应用没开时手改 profile 的
`package.json`（`dependencies` + `dsh.profile.bundles`）再用自带的 pnpm 装，见
NATIVE-BASELINE.md 末尾。host 半改完要**重启应用**（浏览器半 build 完 Ctrl+R 刷新窗口即可）。
两代宿主的差异（设置、当前会话、开会话、跑完未读、**fork 的切点**、重拉指纹）都在
DESIGN.md「设置：两代宿主」「宿主 0.2：浏览器半的三处搬家」「宿主 0.2：fork 的切点」，
`test-lifecycle.mjs` 用例 6 和 `test-cut.mjs` 钉着两条路。桌面版小版本升级后先按
NATIVE-BASELINE.md 末尾的办法把 asar 抄出来 diff 一遍，再决定要不要动代码。

⚠️ **别再往 `cordis.patch.yml` 里写 `file:///…` 的 `insert`** —— 和上面的装法同时用，
同一个 id 会插两次，cordis 直接拒绝启动。

⚠️ 没有 `prepare` 脚本是**故意的**：`client.js` 是提交进仓库的成品，所以 git 安装不会
触发 pnpm 的构建闸（装的人不用去 `pnpm-workspace.yaml` 里加 `allowBuilds`）。
别加 `prepare`。

启用 / 停用写的是 profile 的 `cordis.patch.yml`：

```yaml
- id: dsh-chat-tree
  disabled: true
```

约 1 秒生效，不用重启。停用时三条路由和 `agent/created` 监听一起消失
（`test-lifecycle.mjs` 盯着这件事）。

## 3. 测试

```bash
npm test                          # build → lint → 全部测试（并行跑，一个失败不挡别的）
npm run check                     # 不重 build；核对 client.js 是否最新 + lint + 测试（复查 / CI）
node tests/run.mjs --only card    # 只跑文件名含 card 的（逗号分隔多个）；--list / --serial
node tools/lint.mjs               # 规矩检查；--fix-hint 打印每条规矩为什么存在
node tests/test-card.mjs          # 单跑一个（之前记得 npm run build，测的是生成物 client.js）
```

四道门各抓一类错（细表在 docs/dev/WORKFLOW.md §1）：
`tools/lint.mjs`（§4 那几条能机械查的规矩）→ `tests/test-contract.mjs`（host 和浏览器各写一份、
必须一致的字段 / 默认值 / 路由 / 命名空间）→ 纯函数测试（建图、省略、几何、折叠、撤回、合并、
HTTP、生命周期）→ 组件测试（`test-card.mjs` / `test-ui-settings.mjs`，用 `tests/kit/react-lite.mjs`
把组件真的挂起来派事件）。新加测试文件放进 `tests/` 就会被跑到，不用登记。

```
node tests/test.mjs              # 真实会话日志跑整条渲染管线，--print 打印 ASCII 树
node tests/test-highlight.mjs    # 高亮、hover intent、连线遮挡
node tests/test-elide.mjs        # 省略的距离、行号压实、缩放、显示范围的档位
node tests/test-layout.mjs       # 列距、贴右缘、横线去重、被浮层盖住时收起
node tests/test-pointer.mjs      # 触摸设备：点按代替悬停、输入法、焦点守卫
node tests/test-card.mjs         # 详情卡：两档、改名锁、输入法、收藏、合并清单、删除的两下确认（组件级）
node tests/test-delete.mjs       # 删除 = 归档整条支线：删哪些、为什么删不了、先切到哪
node tests/test-ui-settings.mjs  # 设置卡：每项都在、滑杆 / 开关 / 色值写对字段（组件级）
node tests/test-contract.mjs     # 两半契约：设置字段与默认值、路由、SETTINGS_NS、__pure 无 undefined
node tests/test-icon.mjs         # 自定义节点图片：只收 PNG、内容哈希、清理不误伤
node tests/test-rewind.mjs       # 撤回：哪些轮该消失、哪些该成废弃支线
node tests/test-merge.mjs        # 合并 / 接回去
node tests/test-shape.mjs        # 拿真实会话跑合并 / 分离的端到端
node tests/test-branch.mjs       # 把真实分支倒带到"刚出生"，重放接管逻辑
node tests/test-http.mjs         # 路由外壳：信任围栏、方法分发、出错码、body 上限
node tests/test-net.mjs          # 浏览器半：直连被拒时改走 /remote 通道
node tests/test-lifecycle.mjs    # 启用 / 停用 / 再启用：两半都不许留东西
node tests/test-tidy.mjs         # 分列算法（紧凑树）：具体那张图 + 3000 棵随机树扫不变式
node tests/test-cut.mjs          # 开岔路的切点（0.2 宿主按精确切点抄）、空壳轮、重拉指纹
node tests/test-fold.mjs         # 左侧会话列表按树折叠：座位、记号、认不出来就不动
node tests/test-labels.mjs       # 标注落盘：host 的 labels.json、老目录搬家
node tests/test-split.mjs        # 拆共用的 Claude 记录文件
node tests/test-active.mjs       # 现在看到的是第几轮、钉住、未读三段式
```

`test-branch.mjs` / `test.mjs` / `test-rewind.mjs` 要读真实会话日志，不在默认位置时设 `DSH_HOME_REAL` 指过去，
否则它们自己跳过。

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
6. **graft 依赖 dsh-claude 传 `forkSession: true`**（DESIGN.md §4 缺陷二的警告框）。
   没有它，父子分支共用一个 Claude 会话文件，进程一重启就互相串记忆。补丁在
   `$DSH_HOME/profiles/web/patches/`，由 `pnpm-workspace.yaml` 的 `patchedDependencies`
   重放；升级 dsh-claude 后先确认上游是否已带 `forkSession`，没带就把补丁改成新版本号。
   已经共用的旧会话用 `tools/split-shared-claude.mjs` 拆（**dsh 停着时**）。
   桌面版（0.2）要装 dsh-claude **0.1.64+**，profile 在 `$DSH_HOME/profiles/desktop`，补丁同样放它的
   `patches/` 并写进 `pnpm-workspace.yaml`，然后用自带 pnpm install（应用关着时）；0.1.64 仍没带
   `forkSession`（NATIVE-BASELINE.md 末尾有命令）。**装完要 grep 一下 `forkSession` 确认真的打上了** ——
   2026-10-01 发现桌面 profile 的 `patches/` 空着、yaml 里也没有 `patchedDependencies`，补丁从没生效过。
7. **开岔路的切点传这一轮的 turn/end**（`src/client/tree.js` 的 `forkCutSeq`），不是 turn/start。
   0.2 宿主把 `atSeq` 当精确切点，传 turn/start 新分支就只剩一个空壳轮、模型从上一轮接着记
   （NATIVE-BASELINE.md「fork 的 atSeq」）。0.1.5 两种传法等价，所以这条在网页版上永远测不出来。

## 5. 已知问题（按优先级）

**给用 dsh-claude 的人（也是给装它的 AI）**

- dsh-chat-tree 的"开分支带 Claude 记忆"依赖 dsh-claude 在 resume 时传 `forkSession: true`。
  上游 0.1.54 还没有这一行，没有它父子分支会共用一个 Claude 会话文件，进程一重启就
  互相串记忆。补丁很小（`resumeSessionAt` 旁边加 `forkSession: true`），用 pnpm patch
  挂到 `$DSH_HOME/profiles/web/patches/`。不用 Claude 的用户完全碰不到这件事。
- 已经串了的旧会话用 `node tools/split-shared-claude.mjs --apply` 拆（dsh 停着时跑）。
- **父会话在跑时开的岔路，"等它跑完再补接"实际接不上**：dsh-claude 自己在 `agent/created` 里就读了
  新分支的旁车并缓存（`#latest`，"disk is read once"），2s 后补写的文件它不再读，新分支起进程时
  没有 binding → 全新的 Claude 会话。UI 上 `forkBlockedWhy` 已经不让在跑的 claude 会话上开岔路，
  原生消息行上的分支按钮挡不住。真要修得上游给个"重读旁车"的口子。

**P1**（已切成任务卡，见 docs/dev/BACKLOG.md T6–T8）

- 自定义图片全局只留 200 张（`ICON_KEEP`），超了按 mtime 静默删，引用还在，节点变成画不出来
- `shape.json` 只增不减，删掉的会话永远留在 `groupOf` / `detached` 里
- `atomicWrite` 的 `rename` 失败时 `.tmp` 不清理，留孤儿文件
- `reshape` 是读-改-写，两个客户端并发会静默丢一个补丁
- 重启 dsh 会对每条 seeded 会话重跑 `adoptBranch`，父会话忙时可能给同一个 child 排多个补接定时器

**John 2026-10-04 报的桌面版问题**（BACKLOG.md T1–T4）：空节点的标注所有树共用（key 是常量 `'root'`）；
同层三个以上节点时自定义文字只剩「…」；缺"删除节点"；卡片展开后点外面不收起。

**功能盲点**

`session.surface` 只用了一半：**replace 遮掉的提问行 → 撤回戳**（`outline.js` 的
`shadowedSeqs`，DESIGN.md 撤回一节），这样 dsh-rewind-plugin / dsh-retrace 的就地撤回
树上认得出来。没用的另一半是**压缩**：一次 compaction 之后模型实际只记得摘要，树上却
仍把压缩前的轮画成普通节点。要做的话仍是两层：日志是唯一的正文来源（官方明确说 surface
不能当 transcript），surface 只用来盖记号。

## 6. 提交规矩

- **提交信息只写一句话，写给用户看**（"用 yyy 修复了 xxx"那种），细节放代码注释和 docs/dev。
  仓库是给用户看的，GitHub 上提交列表用户也看得到。
- 一个提交一件事。文件重叠到没法拆时，宁可合成一个说清楚，也别切出跑不起来的中间提交
- 改了 `src/client/` 就把重新 build 过的 `client.js` 一起提交
