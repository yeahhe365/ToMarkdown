# ToMarkdown

<p align="center">
  <img src="icons/logo_rounded.png" alt="ToMarkdown logo" width="128" height="128">
</p>

Chrome 扩展：点击工具栏图标，将当前网页**整页可见内容**一键保存为 **AI 友好的 Markdown（`.md`）** 文件。

## 功能

- **一键保存**：点击扩展图标即可下载
- **整页保留**：默认抓取整页 DOM（商品卡片、标题、价格、链接等），只去掉 `script` / `style` / `svg` 等无展示噪音
- **滚动累计**（v1.0.3+ / 增强至 v1.0.6）：对**虚拟列表**商品/媒体网格自动滚动、去重累计（标题 / 价格 / 时长 / 播放量 / 链接）。播放量只信「标签 / 紧贴时长 / 紧贴价格 / 角标」结构，拒绝标题里的 `2B`、`18 year` 等误匹配；多轮采集时优质计数不会被劣质值覆盖
- **Markdown 输出**：保留标题、列表、表格、代码块、链接等结构，便于粘贴给 LLM
- **本地处理**：不上传页面内容，无远程服务依赖
- **元数据**：仍用 [Defuddle](https://github.com/kepano/defuddle) 辅助提取标题/作者等

### 输出示例

```markdown
# 文章标题

> Source: https://example.com/article
> Saved: 2026-07-14T15:00:00.000Z

---

正文 Markdown …
```

文件默认进入浏览器的「下载」目录，文件名取自页面标题。

## 安装（开发者模式）

1. 打开 Chrome，访问 `chrome://extensions`
2. 打开右上角 **开发者模式**
3. 点击 **加载已解压的扩展程序**
4. 选择本目录：

   ```
   /Volumes/WD_BLACK/Code/ToMarkdown
   ```

5. 固定扩展图标到工具栏后，打开任意网页并点击图标

若之前加载过旧目录 `ai-page-saver`，请先移除旧扩展，再按上面步骤重新加载 **ToMarkdown**。

## 使用说明

| 操作 | 结果 |
|------|------|
| 点击扩展图标 | 抽取正文并下载 `.md` |
| 角标 `OK` | 保存成功 |
| 角标 `!` | 已保存，但正文可能识别不全 |
| 角标 `ERR` | 失败（受限页、超时、注入失败等） |
| 角标 `...` | 正在抽取 |

**无法注入的页面**（Chrome 限制）：`chrome://`、扩展商店、部分系统页等。

**本地 `file://` 页面**：需在 `chrome://extensions` → ToMarkdown → 开启 **允许访问文件网址**。

## 技术栈

| 组件 | 说明 |
|------|------|
| Manifest V3 | `activeTab` + `scripting` + `downloads` |
| Defuddle `full` bundle | 正文抽取 + HTML→Markdown（含 Turndown） |
| Service Worker | 点击协调、下载、角标反馈 |

权限说明：

- `activeTab`：仅在用户点击时访问当前标签页
- `scripting`：注入抽取脚本
- `downloads`：保存 `.md` 文件

## 目录结构

```
ToMarkdown/
├── manifest.json
├── background.js          # 点击处理、下载
├── content/extract.js     # 页内抽取逻辑
├── lib/
│   ├── defuddle.full.js   # Defuddle browser full bundle
│   └── DEFUDDLE_LICENSE   # MIT
├── icons/
│   ├── icon16.png / icon32.png / icon48.png / icon128.png
│   ├── icon_master.png      # 1024 主图标
│   ├── logo_rounded.png     # 圆角营销版
│   └── logo_transparent.png # 透明底
└── README.md
```

## 许可

本项目以 **[MIT License](LICENSE)** 完全开源。

第三方组件：

- [Defuddle](https://github.com/kepano/defuddle)（MIT）— 见 `lib/DEFUDDLE_LICENSE` 与 `NOTICE`

## 仓库

https://github.com/yeahhe365/ToMarkdown

## 后续可扩展（未做）

- 复制到剪贴板 / 下载双写
- 选项页（YAML frontmatter、是否保存图片）
- 选中文本优先保存
- Defuddle 失败时 Readability 兜底
