# 网站收藏（web-bookmarks-personal）

在 ZCode 侧栏维护常用网站，点一下就在**右侧内置浏览器**打开。默认内置 **DeepSeek 网页端**，解决「每次都要先在地址栏输网址」的麻烦。

## 为什么不是把网页嵌进侧栏

DeepSeek 网页返回：

```text
content-security-policy: frame-ancestors 'none'
```

任何 iframe（包括插件面板）都会被浏览器拒绝；登录 Cookie 也是 `SameSite=Strict`，跨站 iframe 拿不到登录态。正确做法是调用 ZCode 宿主的 `ui/open-link`，让内置浏览器（Electron webview）打开真实页面，登录态由内置浏览器的持久化分区保存。

## 功能

- 默认收藏：DeepSeek 网页端（`https://chat.deepseek.com/`），以醒目卡片置顶。
- 搜索：按名称、网址、备注过滤。
- 添加 / 编辑 / 删除收藏；只接受 `http` / `https` 网址，重复网址会提示已存在。
- 收藏保存在插件数据目录的 `bookmarks.json`，重启后仍在。
- 支持 ZCode 明暗主题，面板宽度较窄时自动收缩。
- 提供 MCP 工具：`bookmarks_list`、`bookmarks_add`（模型可调用）、`bookmarks_update`、`bookmarks_remove`（仅面板可调用）。

## 安装

1. ZCode 设置 → 插件市场，添加目录类型市场 `D:\cherry-workplace\zcode-plugins`。
2. 刷新市场，安装「网站收藏（内置浏览器）」。
3. 在侧栏打开插件面板「网站收藏」；建议固定，方便随时点 DeepSeek。
4. 第一次打开 DeepSeek 时在内置浏览器里登录，之后会保持登录态。

## 使用

- 点 DeepSeek 卡片 → 右侧内置浏览器打开网页端。
- 点「＋」添加网站：名称可留空，自动取域名；网址必须带 `https://` 或 `http://`。
- 悬停条目 → 「✎」编辑、「✕」删除。
- 按 `/` 聚焦搜索；`Esc` 关闭弹窗。

## 数据位置

- 优先使用 `${ZCODE_PLUGIN_DATA}/bookmarks.json`。
- 如果宿主没有注入插件数据目录，回退到 `~/.zcode/plugin-data/web-bookmarks/bookmarks.json`。
- 文件损坏时面板会显示具体路径和错误，不会静默覆盖。

## 开发

```bash
cd ui-src
npm install
npm run build        # 生成 ui/dist/panel.html 和 dist/server.mjs
npm run typecheck
```

构建依赖：Node 20+、esbuild、`@modelcontextprotocol/ext-apps`、`@modelcontextprotocol/sdk`、zod。

## 限制

- 插件面板本身不能显示网页内容（原因见上）；打开的是 ZCode 内置浏览器标签页。
- 侧栏面板每个会话需要手动打开一次（ZCode 的 `availability: "session"` 语义），固定在侧栏后体验最好。
- 不读取、不代理、不保存任何网站登录凭据；登录完全由内置浏览器负责。

## 许可

MIT。第三方依赖许可见 `THIRD_PARTY_NOTICES.txt`。
