# 划词查词 (md-word-lookup)

在 Markdown 里**选中一个英文单词**，光标旁立刻弹出中文释义。完全离线，不用联网、不用调用任何外部服务。

```
选中 abandon → 悬浮卡片
abandon  /əˈbændən/
v. 放弃, 抛弃, 遗弃
n. 放任, 狂热
变形 过去式 abandoned · 过去分词 abandoned · 现在分词 abandoning
```

## 功能

- **选中即查**：鼠标划选（或 `Shift` + 方向键选中）一个英文单词，约 0.4 秒后在光标旁弹出释义卡片。
- **手动触发**：`Ctrl+Alt+D`（macOS `Cmd+Alt+D`）或右键菜单「查词」。未选中时自动取光标所在单词。
- **词形还原**：查 `took` 会显示 `take`（过去式），`running` → `run`，`studies` → `study`。
- **短语支持**：少量常见短语（如 `in spite of`、`look after`）也能查，词库只收了高频短语。
- **状态栏提示**：屏幕左下角同时显示一行简要释义，卡片被鼠标移走时也能看到。
- **查不到时**：自动模式静默跳过；手动模式提示「未收录」并给出相近词建议。

## 支持哪些界面

VS Code 里「Markdown」有四种打开方式，扩展对它们的支持程度不同：

| 打开方式 | 类型 | 怎么用 |
| --- | --- | --- |
| 文本编辑器（Text Editor） | Monaco | ✅ 选中单词，约 0.4 秒后光标旁弹出 hover 卡片 |
| Markdown Preview（经典预览） | webview + 官方注入点 | ✅ 选中单词立即弹出卡片（推荐） |
| Markdown Editor（内置新编辑器） | webview | ⚠️ 选中单词按 `Ctrl+C`，卡片自动出现 |
| Md Editor（第三方 `seepine.md-editor`） | webview | ⚠️ 同上，`Ctrl+C` 后自动出现 |

前两个界面扩展能直接读到选区；后两个是别人的 webview，VS Code 不允许扩展读取选区或注入脚本，因此退化为**剪贴板监听**：选中单词按 `Ctrl+C`，扩展检测到剪贴板变化就查词，结果显示在左下角状态栏（鼠标悬停可看完整释义），不需要再按快捷键。

> 注意：`workbench.editorAssociations` 里显式写了 `"*.md": "vscode.markdown.preview.editor"` 时，即使装了 Md Editor 也会优先用经典预览。已经被打开成 Md Editor 的标签页需要重开一次才会应用新关联。

## 多词划选

在经典预览里可以一次划选好几个词（甚至整行），扩展会**自动剔除被选区边界切掉一半的词**，只查完整的词。

判断依据是选区的 DOM 位置，而不是文本本身——因为纯文本无法区分半截的 `ittee` 和完整的 `decided`：

```
选中：  The comm|ittee decided to abandon the orig|inal
               ↑ 前一个字符是 m，说明 committee 被切断了 → 丢掉
                                             ↑ 后一个字符是 i → orig 被切断 → 丢掉
结果：  decided · abandon
```

配套规则：

- **跳过虚词**：`the` `a` `to` `of` `is` `was` 这类不需要查的语法词自动过滤，卡片顶部会显示「已跳过 N 个虚词」
- **去重**：同一个词只出现一次，保持原文顺序
- **最多 12 个词**，超出显示「还有 N 个词未显示」
- **词形还原**：`took` 显示成 `take ← took`（带原形提示）
- **连字符词**：`well-known` 被切成 `well-kn` 会剔除；而 `COVID-19` 只选 `COVID` 时不会误判（连字符后面是数字，不算词内）

触发时机：

- 选中内容**在同一行且不超过 12 个词**时自动弹出（避免复制长段时被打扰）
- 跨行或更长的选区，按 `Ctrl+C` 复制时才会弹出（视为明确查词意图）
- 只选到半截词（如只选中 `ittee`）时不弹卡片

## 使用

1. 打开任意 `.md` 文件。
2. 用鼠标选中一个英文单词（不要选中中文或整句）。
3. 释义卡片出现在选区旁。点击别处或按 `Esc` 即可关闭。

安装：

```bash
code --install-extension md-word-lookup-0.1.0.vsix
```

装完需要重载窗口（`Ctrl+Shift+P` → `Developer: Reload Window`）才会加载。
扩展声明了「支持不受信任工作区」，所以受限模式下也能用。

## 命令

| 命令 | 快捷键 | 说明 |
| --- | --- | --- |
| `划词查词: 查词：查看选中单词的释义` | `Ctrl+Alt+D` | 文本编辑器内查词；未选中时取光标下单词 |
| `划词查词: 查词：查看剪贴板里的单词释义` | `Ctrl+Alt+D` | 焦点不在文本编辑器时自动接管，查剪贴板内容 |
| `划词查词: 在经典预览中打开当前 Markdown（划词可用）` | — | 把当前 md 在经典预览里打开，划词卡片可用 |
| `划词查词: 开关：选中后自动查词` | — | 快速开关自动模式 |

## 配置项

| 配置 | 默认值 | 说明 |
| --- | --- | --- |
| `mdWordLookup.autoLookup` | `true` | 选中后自动弹出；关闭后仅快捷键 / 右键菜单可用 |
| `mdWordLookup.delay` | `400` | 自动查词的等待毫秒数 |
| `mdWordLookup.languages` | `["markdown"]` | 生效的语言 ID，可加 `plaintext`、`*` 等 |
| `mdWordLookup.showStatusBarHint` | `true` | 是否显示状态栏简要释义 |
| `mdWordLookup.clipboardWatch` | `true` | webview 里监听剪贴板，`Ctrl+C` 后自动查词 |
| `mdWordLookup.webviewToast` | `false` | 剪贴板查词时是否额外弹通知（通知不会自动消失，默认关） |

命令面板里还有「划词查词: 开关：选中后自动查词」，可快速开关自动模式。

## 词库

内置词典由 [ECDICT](https://github.com/skywind3000/ECDICT)（MIT 协议）裁剪生成，59,111 条，含音标、中文释义、英文释义与词形变化：

- `data/dict.json`：扩展进程用（文本编辑器 hover），9.7 MB
- `preview/dict-data.js`：注入到经典预览的同一份词库，4.8 MB

重新生成（需要 `ecdict.csv`，约 66 MB）：

```bash
node scripts/build-dict.mjs path/to/ecdict.csv --max-rank 50000
```

只重算预览词库（用已有的 `data/dict.json`，不需要 csv）：

```bash
npm run build:preview
```

`preview/dict-data.js` 的头部是可直接编辑的配置段；改安装目录下这个文件会立即生效，无需重编译：

```js
window.__MDWL_DICT__={"v":1,"cfg":{"maxWords":12,"stopwords":"a an the …"},"e":{…}}
```

源头配置在 `preview/config.json`。

### 扩充词库的实测结论

`npm run stats` 可对比各阈值。真实 Chromium 测量：

| 方案 | 词条数 | 预览 JS | 加载耗时 | 堆增量 |
| --- | --- | --- | --- | --- |
| 当前（有词频或考试标签） | 59,111 | 4.85 MB | 56 ms | +13 MB |
| lemma 词元 ∪ 当前 | 78,820 | 6.28 MB | ~75 ms | ~+18 MB |
| 全部单词（去掉 35 万短语） | 401,614 | 26.68 MB | 830 ms | +97 MB |
| 全部词条 | 760,982 | 46.31 MB | 1,639 ms | +123 MB |

两条硬限制：

- ECDICT 的频率排名只覆盖约 5.7 万词，`lemma.en.txt` 也只有 6.2 万词元，所以「按词频逐步加」没有中间档，要么 59k 要么 40 万
- 预览是 webview，**不能运行时加载额外脚本**：动态 `<script>` 没有 CSP nonce 会被拦，`fetch` 到 `file+.vscode-resource` 报 `Failed to fetch`。词库只能整包静态注入，做不了分片懒加载

所以全量扩容的代价就是每次打开预览多等 1.6 秒、多占 123 MB 内存。

## 开发

```bash
npm install
npm run compile          # tsc -> out/
npm test                 # 用 vscode API 桩跑集成用例
npm run package          # 生成 .vsix
code --install-extension md-word-lookup-0.1.0.vsix
```

## 已知限制

- 只支持**英文查中文**（词典方向固定），选中中文不会触发。
- 解释来自离线词库，不会结合上下文；例句库未内置。
- 新 Markdown Editor 里只能查剪贴板（见上文支持矩阵）。
