# Zotero（个人版）— 官方插件 fork

基于官方 `zotero@zcode-plugins-official 0.2.1` 的个人 fork，版本号 `0.2.2`，所属市场 `personal-plugins`。

## 为什么 fork

官方安装包缺少 `dist/pdfjs/` 数据目录（CMaps、标准字体、wasm）。服务端启动时 `pdfjsDataDir(<root>/dist/pdfjs)` 解析失败，仅打印日志：
`pdf.js data (CMaps, fonts) not found; text from some CJK PDFs may be missing`
随后 `ui://zotero/pdfjs/{kind}/{file}` 资源全部 404，侧栏 pdf.js 阅读器拿不到 CMap 和标准字体，导致 CNKI（ReaderEx/TTKN）等中文 PDF 出现「中文正常、数字和英文乱码」的问题。

## 修复内容

- 补入与面板内置 pdf.js（6.3.289）同版本的 `dist/pdfjs/{cmaps,standard_fonts,wasm}`，共 198 个文件（npm `pdfjs-dist@6.3.289` 解包获得）。
- 清单改为 `name: zotero-personal`、`version: 0.2.2`，面板标题「Zotero（个人版）」，其余配置与官方一致。
- 插件数据目录中的本地 API 密钥（`local-api-keys.json`）已从官方插件目录复制，保留「始终允许」状态。

## 结构

```
personal-plugins/                      # 市场根（ZCode 市场目录下）
  marketplace.json                     # 市场清单（含 icon 字段）
  plugins/zotero-personal/             # 插件源
    .zcode-plugin/plugin.json          # 清单（唯一改动处）
    assets/icon.png                    # ← 本 fork 新增：512×512 插件图标
    dist/server.mjs                    # 官方 0.2.1 原样
    dist/ui/panel.html                 # 官方 0.2.1 原样
    dist/pdfjs/                        # ← 本 fork 新增
      cmaps/  standard_fonts/  wasm/
    skills/zotero/SKILL.md
    LICENSE
```

## 图标

图标沿用官方 Zotero 图标的视觉家族（红皮书 + 深红书脊 + 黄色书签 + 浅粉底），把书封上的白色引号换成白色「文」，用于在插件市场里和官方 `zotero` 一眼区分。

ZCode 的插件市场卡片直接读取 `marketplace.json` 条目里的 `icon`，并把它当作 `<img src>` 使用；本地市场不会解析相对路径，因此 `marketplace.json` 里的 `icon` 存的是 **PNG 的 data URI**（约 20 KB），插件目录里同时保留 `assets/icon.png` 作为可维护的源文件。

图标生成与写入脚本在工作区 `D:\cherry-workplace\通用\zotero-icon\`：

```bash
python make_icon.py    # 生成 4 个变体（cjk / brackets / quotes-badge / brackets-badge）
python embed_icon.py icon-cjk.png   # 复制 assets/icon.png 并把 data URI 写进 marketplace.json
```

换图标时重新跑 `embed_icon.py <变体>.png`，然后在插件市场点一次刷新（或重开 ZCode）即可。

## 官方插件更新后如何跟进

官方发新版（如 0.3.x）时：把新版本解包内容覆盖到 `plugins/zotero-personal/dist/` 与 `skills/`（清单保留本 fork 的 `name/version` 修改），再补回 `dist/pdfjs/`（用与新版面板一致的 `pdfjs-dist` 版本），提升清单版本号，然后在 **设置 → 插件** 里刷新/更新即可。

## 安装

市场根路径：`C:\Users\PC\.zcode\cli\plugins\marketplaces\personal-plugins`

在 **插件市场 → 添加 → 添加插件市场** 粘贴上述路径（或直接拖入该文件夹），随后 **personal-plugins → Zotero（个人版）→ 安装**。安装后到 **设置 → 插件 → 已安装** 停用官方 `zotero` 插件。
