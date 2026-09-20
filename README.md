# dsh-tree

把一个对话的所有分支画成一棵树，贴在 [DeepSeek Harness](https://github.com/deepseek-ai) 聊天区右缘。

点节点跳到那一轮，点 ＋ 从那儿接着问。

不依赖任何其它插件。运行时只多一个 `schemastery`（dsh 自己也用它，用来声明设置项）。

```
     ◌
     1
     2
 3'  3
 4'  4
```

## 装

```sh
dsh plugin --profile web add github:JRJRJPRO/dsh-tree
```

重启 `dsh web`。卸载 `dsh plugin --profile web remove dsh-tree`。

临时关掉不用卸载——往 `cordis.patch.yml` 加两行，约 1 秒生效，刷新浏览器即可：

```yaml
- id: dsh-tree
  disabled: true
```

从源码跑：先 `npm install`（要一个 `schemastery`），再把
`- insert: - id: dsh-tree, name: 'file:///绝对路径/index.js'` 写进 `cordis.patch.yml`，
别和上面的装法同时用（同一个 id 插两次，dsh 起不来）。
改 `index.js` 要重启，改 `client.js` 刷新浏览器即可。

## 用

| | |
|---|---|
| 单击节点 | 跳到那一轮 |
| 悬停 | 右侧出详情卡 |
| 双击名字 | 改名 |
| ＋ | 从这之后接着问；在树根空节点上则是**在同一棵树里新开一条对话** |
| ⇥ | 把这条支线拆成独立的一棵树（头顶有岔路的节点才有） |

边框蓝 = 这个节点在你当前的对话里；填充蓝 = 你正看着这一轮。橙色菱形 = 这一轮做过压缩。

同一棵树 = 树根相同，或你主动在空节点上按 ＋ 开出来的对话。没登记过的对话各自成树，互不显示。
分组关系存在 `$DSH_HOME/plugins/dsh-tree/shape.json`。

## 省略

只画离你正在看的那一轮若干步以内的节点，剪断处画 `⋯`。距离是树上的无向步数：父节点 1 步，父节点的另一个孩子 2 步。

默认 10 步。**设置 → 插件 → 插件配置 → 对话树** 里可调，5 到 30，再往上一档是不省略。

同一张卡里还能调**节点大小**（50%–250%）：点、连线、列间距、命中区一起等比例缩放。

## 它还顺手修了两个原生 fork 的缺陷

- **会多抄一条还没跑的待办** —— 在节点 N 开岔路，新分支会先把 N+1 那个问题重跑一遍。所有 provider 都中招。
- **外部引擎的记忆不跟随** —— 只影响 `dsh-claude` 这类把对话托管给外部引擎的桥接。不依赖它，装了才处理。

两个都在 `agent/created` 上接管，原生分支按钮同样生效。

## 测

```bash
npm test                   # 四套一起跑

node test.mjs              # 真实会话日志跑整条渲染管线，--print 打印 ASCII 树
node test-highlight.mjs    # 高亮、hover intent、连线遮挡
node test-elide.mjs        # 省略的距离、行号压实、缩放
node test-branch.mjs       # 把真实分支倒带到"刚出生"，重放接管逻辑
```

`test-branch.mjs` 要读真实会话日志，不在默认位置时设 `DSH_HOME_REAL` 指过去，否则它自己跳过。

设计与踩坑记录：[DESIGN.md](DESIGN.md)。原生能力清单：[NATIVE-BASELINE.md](NATIVE-BASELINE.md)。

## 还没做

节点名字存在 localStorage · 左侧列表仍是平的 · 超长对话会溢出。

MIT
