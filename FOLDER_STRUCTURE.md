# 文件夹结构

```
zcode-plugins/
├── marketplace.json                # ZCode 市场清单：插件列表、版本、图标（https 地址）、来源
├── plugins/                        # 插件目录，每个子目录是一套可安装插件
│   └── zotero-personal/            # 个人版 Zotero 插件
│       ├── .zcode-plugin/
│       │   └── plugin.json         # 插件清单：MCP server、userConfig、ui.surfaces
│       ├── assets/
│       │   └── icon.png            # 插件图标（供 raw https 引用）
│       ├── dist/                   # 构建产物：server.mjs 及构建信息
│       ├── skills/
│       │   └── zotero/             # 技能说明
│       ├── LICENSE
│       └── README.md               # 插件自身说明
├── README.md                       # 仓库说明与使用方式
└── FOLDER_STRUCTURE.md             # 本文件
```

## 各目录用途

- `plugins/`：新增插件时在此建立 `<plugin-name>/`，并在 `marketplace.json` 的 `plugins` 数组中登记 `name`、`source`、`version`、`icon` 等字段。
- `.zcode-plugin/`：ZCode 识别插件的清单位置，包含 MCP server 启动参数、用户配置项与侧栏面板定义。
- `assets/`：图标等可公开引用的静态资源，图标通过 `raw.githubusercontent.com` 的 https 地址在市场中展示。
- `dist/`：插件运行所需构建产物，需要随仓库一起提交，ZCode 安装时直接复制。
