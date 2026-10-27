# ZCode 插件库

个人维护的 ZCode 插件市场源（marketplace）。ZCode 可直接把本目录当作 `directory` 类型的市场加载，也可通过 GitHub 仓库分发。

## 包含插件

| 插件 | 版本 | 说明 |
| --- | --- | --- |
| `blender-personal` | 0.3.0 | 个人版 Blender 插件（fork 官方 0.2.3，整合 mcp-for-blender）：headless 编辑渲染之外，新增 Live 模式直连正在运行的 Blender GUI（执行 bpy 代码、截视口、PolyHaven 资产） |
| `zotero-personal` | 0.2.2 | 个人版 Zotero 插件（基于官方 0.2.1 fork），补齐 pdf.js CMaps/标准字体，修复中文 PDF 阅读乱码 |
| `web-bookmarks-personal` | 0.1.0 | 侧栏网站收藏夹：默认内置 DeepSeek 网页端，点一下就在 ZCode 右侧内置浏览器打开；支持搜索、添加、编辑、删除 |

## 在 ZCode 中使用

1. 打开 ZCode 的插件市场设置。
2. 添加市场，类型选择「目录」（directory）。
3. 路径填写本仓库根目录：`D:\cherry-workplace\zcode-plugins`。
4. 刷新市场后安装需要的插件（`blender-personal`、`zotero-personal`、`web-bookmarks-personal`）。

`web-bookmarks-personal` 安装后，从侧栏打开「网站收藏」面板（建议固定），点 DeepSeek 卡片即可在内置浏览器打开 `chat.deepseek.com`。内置浏览器第一次需要自己登录，之后会保持登录态。

## 目录结构

```
.
├── marketplace.json          # 市场清单（ZCode 读取）
├── plugins/                  # 各插件源码与构建产物
│   ├── blender-personal/     # 个人版 Blender 插件（fork 官方 + Live 通道）
│   │   ├── .zcode-plugin/    # 插件清单 plugin.json（两个 MCP server）
│   │   ├── assets/           # 图标
│   │   ├── blender/          # Blender 端脚本：官方 bridge.py + 新增 live_addon.py
│   │   ├── dist/             # 官方 server.mjs + 新增 live-server.mjs
│   │   ├── skills/blender/   # 技能（含 Live 模式指引）
│   │   ├── ui/dist/          # 侧栏面板（Three.js 预览）
│   │   ├── LICENSE
│   │   └── README.md
│   ├── zotero-personal/
│       ├── .zcode-plugin/    # 插件清单 plugin.json
│       ├── assets/           # 图标等静态资源
│       ├── dist/             # 构建产物（MCP server）
│       ├── skills/           # 技能
│       ├── LICENSE
│       └── README.md
│   └── web-bookmarks-personal/
│       ├── .zcode-plugin/    # 插件清单 plugin.json（MCP server + 侧栏面板）
│       ├── server-src/       # MCP server 源码与 esbuild 构建脚本
│       ├── ui-src/           # 面板源码（TS/CSS/HTML 模板）与构建脚本
│       ├── dist/             # 构建产物 server.mjs
│       ├── ui/dist/          # 构建产物 panel.html（内联 CSS/JS）
│       ├── skills/           # 技能：何时查询/添加收藏、为什么不能 iframe 嵌网页
│       ├── LICENSE
│       └── README.md
├── README.md
└── FOLDER_STRUCTURE.md
```

## 约定

- 插件图标必须是 **https://** 地址（ZCode 插件卡片只放行 https，data URI 会被忽略），因此统一引用本仓库的 raw 链接：`https://raw.githubusercontent.com/sanqiuyef/zcode-plugins/main/<路径>`。
- 修改插件后需要：在本仓库提交推送 → 在 ZCode 刷新市场 → 如有必要重新安装/更新插件。
