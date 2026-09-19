# dsh-tree

把一个对话的所有分支画成一棵树，贴在 [DeepSeek Harness](https://github.com/deepseek-ai) 聊天区右缘。

点节点跳到那一轮，点 ＋ 从那儿接着问。只依赖 dsh。

```
     ◌
     1
     2
 3'  3
 4'  4
```

## 装

往 `$DSH_HOME/profiles/web/cordis.patch.yml` 加：

```yaml
- insert:
    - id: dsh-tree
      name: 'file:///绝对路径/dsh-tree/index.js'
```

重启 dsh。卸载就删掉这三行。

改 `index.js` 要重启，改 `client.js` 刷新浏览器即可。

## 用

| | |
|---|---|
| 单击节点 | 跳到那一轮 |
| 悬停 | 右侧出详情卡 |
| 双击名字 | 改名 |
| ＋ | 从这之后接着问 |
| ↺ | 这一轮重来 |

边框蓝 = 这个节点在你当前的对话里；填充蓝 = 你正看着这一轮。

## 它还顺手修了两个原生 fork 的缺陷

- **会多抄一条还没跑的待办** —— 在节点 N 开岔路，新分支会先把 N+1 那个问题重跑一遍。所有 provider 都中招。
- **外部引擎的记忆不跟随** —— 只影响 `dsh-claude` 这类把对话托管给外部引擎的桥接。不依赖它，装了才处理。

两个都在 `agent/created` 上接管，原生分支按钮同样生效。

## 测

```bash
node test.mjs              # 真实会话日志跑整条渲染管线，--print 打印 ASCII 树
node test-highlight.mjs    # 高亮的边界情形
node test-branch.mjs       # 把真实分支倒带到"刚出生"，重放接管逻辑
```

设计与踩坑记录：[DESIGN.md](DESIGN.md)。原生能力清单：[NATIVE-BASELINE.md](NATIVE-BASELINE.md)。

## 还没做

节点名字存在 localStorage · 左侧列表仍是平的 · 超长对话会溢出。
