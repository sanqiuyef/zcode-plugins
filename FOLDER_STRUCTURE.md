# 文件夹结构

```
zcode-plugins/
├── marketplace.json                # ZCode 市场清单：插件列表、版本、图标（https 地址）、来源
├── plugins/                        # 插件目录，每个子目录是一套可安装插件
│   ├── blender-personal/           # 个人版 Blender 插件
│   │   ├── .zcode-plugin/
│   │   │   └── plugin.json         # 插件清单：两个 MCP server（blender headless + blender-live）、userConfig、ui.surfaces
│   │   ├── assets/
│   │   │   └── icon.png            # 插件图标（供 raw https 引用）
│   │   ├── blender/
│   │   │   ├── bridge.py           # 官方 headless 桥（stdin/stdout，原样保留）
│   │   │   ├── bridge_create.py    # 官方创建类命令（原样保留）
│   │   │   └── live_addon.py       # 新增：装进用户 Blender GUI 的 Live Bridge 插件（TCP 9878）
│   │   ├── dist/
│   │   │   ├── server.mjs          # 官方 MCP server（原样保留）
│   │   │   ├── live-server.mjs     # 新增：Live 模式 MCP server（stdio ↔ TCP 零依赖）
│   │   │   └── build-info.json     # 官方构建信息
│   │   ├── skills/
│   │   │   └── blender/SKILL.md    # 技能：headless 流程 + Live 模式指引
│   │   ├── ui/dist/panel.html      # 侧栏面板（官方原样）
│   │   ├── LICENSE                 # MIT + 第三方声明
│   │   └── README.md               # 与官方的差异、安装与安全说明
│   ├── zotero-personal/            # 个人版 Zotero 插件
│       ├── .zcode-plugin/
│       │   └── plugin.json         # 插件清单：MCP server、userConfig、ui.surfaces
│       ├── assets/
│       │   └── icon.png            # 插件图标（供 raw https 引用）
│       ├── dist/                   # 构建产物：server.mjs 及构建信息
│       ├── skills/
│       │   └── zotero/             # 技能说明
│       ├── LICENSE
│       └── README.md               # 插件自身说明
│   └── web-bookmarks-personal/     # 侧栏网站收藏夹（默认 DeepSeek 网页端）
│       ├── .zcode-plugin/
│       │   └── plugin.json         # 插件清单：bookmarks MCP server + 侧栏面板
│       ├── server-src/
│       │   ├── server.ts           # 收藏存储与 bookmarks_* MCP 工具
│       │   ├── build.mjs           # esbuild 打包 dist/server.mjs
│       │   └── tsconfig.json
│       ├── ui-src/
│       │   ├── app.ts              # 面板逻辑：连接宿主、加载收藏、ui/open-link 打开
│       │   ├── panel.css           # 面板样式（跟随宿主明暗主题）
│       │   ├── panel.template.html # 面板 HTML 模板
│       │   ├── build.mjs           # esbuild + 内联生成 ui/dist/panel.html
│       │   ├── package.json
│       │   └── tsconfig.json
│       ├── dist/server.mjs         # 构建产物：MCP server
│       ├── ui/dist/panel.html      # 构建产物：侧栏面板（CSS/JS 全内联）
│       ├── skills/
│       │   └── web-bookmarks/SKILL.md
│       ├── THIRD_PARTY_NOTICES.txt
│       ├── LICENSE
│       └── README.md
├── README.md                       # 仓库说明与使用方式
└── FOLDER_STRUCTURE.md             # 本文件
```

## 各目录用途

- `plugins/`：新增插件时在此建立 `<plugin-name>/`，并在 `marketplace.json` 的 `plugins` 数组中登记 `name`、`source`、`version`、`icon` 等字段。
- `.zcode-plugin/`：ZCode 识别插件的清单位置，包含 MCP server 启动参数、用户配置项与侧栏面板定义。
- `assets/`：图标等可公开引用的静态资源，图标通过 `raw.githubusercontent.com` 的 https 地址在市场中展示。
- `dist/`、`ui/dist/`：插件运行所需构建产物，需要随仓库一起提交，ZCode 安装时直接复制。
- `server-src/`、`ui-src/`：可读源码与构建脚本；`node_modules` 不提交，构建前在 `ui-src/` 执行 `npm install`。
