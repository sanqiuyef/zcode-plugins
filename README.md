# ZCode 插件库

个人维护的 ZCode 插件市场源（marketplace）。ZCode 可直接把本目录当作 `directory` 类型的市场加载，也可通过 GitHub 仓库分发。

## 包含插件

| 插件 | 版本 | 说明 |
| --- | --- | --- |
| `zotero-personal` | 0.2.2 | 个人版 Zotero 插件（基于官方 0.2.1 fork），补齐 pdf.js CMaps/标准字体，修复中文 PDF 阅读乱码 |

## 在 ZCode 中使用

1. 打开 ZCode 的插件市场设置。
2. 添加市场，类型选择「目录」（directory）。
3. 路径填写本仓库根目录：`D:\cherry-workplace\zcode-plugins`。
4. 刷新市场后安装 `zotero-personal`。

## 目录结构

```
.
├── marketplace.json          # 市场清单（ZCode 读取）
├── plugins/                  # 各插件源码与构建产物
│   └── zotero-personal/
│       ├── .zcode-plugin/    # 插件清单 plugin.json
│       ├── assets/           # 图标等静态资源
│       ├── dist/             # 构建产物（MCP server）
│       ├── skills/           # 技能
│       ├── LICENSE
│       └── README.md
├── README.md
└── FOLDER_STRUCTURE.md
```

## 约定

- 插件图标必须是 **https://** 地址（ZCode 插件卡片只放行 https，data URI 会被忽略），因此统一引用本仓库的 raw 链接：`https://raw.githubusercontent.com/sanqiuyef/zcode-plugins/main/<路径>`。
- 修改插件后需要：在本仓库提交推送 → 在 ZCode 刷新市场 → 如有必要重新安装/更新插件。
