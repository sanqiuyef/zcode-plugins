# Blender（个人版）

个人维护的 ZCode Blender 插件。基于 ZCode 官方 blender 插件 **0.2.3** fork，并整合
[mcp-for-blender](https://github.com/ahujasid/mcp-for-blender) 的「直连正在运行的 Blender」实时通道思路
（架构参考了 [dsh-blender-plugin](https://github.com/sixtysevenlf/dsh-blender-plugin) 的同类实现）。

## 与官方插件的关系

| | 官方 blender 0.2.3 | 本插件 blender-personal 0.3.0 |
| --- | --- | --- |
| headless 场景编辑/渲染/ZCode 侧栏面板 | ✅ | ✅（`dist/server.mjs`、`blender/bridge.py` 原样保留） |
| 拉起/下载便携版 Blender、`run_python` | ✅ | ✅ |
| 直连用户正在运行的 Blender GUI | ❌ | ✅ 新增 `blender-live` MCP server |
| 执行任意 bpy 代码（实时） | ❌（仅受限 run_python） | ✅ `execute_code`（默认安全模式） |
| 视口截图自检 | ❌ | ✅ `viewport_screenshot`（离屏渲染，不要求窗口前台） |
| PolyHaven 资产（CC0 模型/贴图/HDRI） | ❌ | ✅ `polyhaven_search` / `polyhaven_import` |

两条通道互补：headless 走工作区里的 `.blend`，产物进 ZCode 面板；Live 模式操作用户开着的 Blender，
所见即所得。**两边是不同进程，不要对着同一个 `.blend` 混改。**

## 安装

1. ZCode 插件市场 → 添加市场 → 选「目录」，路径填本仓库根目录 `D:\cherry-workplace\zcode-plugins`（或 GitHub 仓库）。
2. 安装 **Blender（个人版）**。若官方 blender 插件也在用，建议只留一个，避免两个「Blender」面板混淆。
3. **Live 模式需要一次性安装 Blender 端插件**：
   - 打开 Blender → 编辑 → 偏好设置 → 插件 → 安装 → 选择本插件目录下的 `blender/live_addon.py` → 勾选启用「Interface: ZCode Live Bridge」。
   - 3D 视口按 `N` → 右侧找 **ZCode Live** 标签 → 点 **连接 ZCode**（默认端口 9878，刻意避开 blender-mcp 的 9876，两者可共存）。
   - 升级 Blender 后想换新版：直接覆盖安装同名文件后重启 Blender。
4. ZCode 侧配置（插件设置）：`Blender 可执行文件`（headless 用，可留空自动探测）；Live 相关一般不用改。

## Live 模式工具一览（mcp server：blender-live）

| 工具 | 用途 |
| --- | --- |
| `connection_status` | 探活：Blender/addon 版本、场景、PolyHaven 开关 |
| `get_scene_info` / `get_object_info` | 读场景/单对象详情 |
| `execute_code` | 在 Blender 主线程跑任意 bpy Python，print 回传；默认安全模式拦文件/网络/子进程 |
| `viewport_screenshot` | 离屏截取当前 3D 视口（GPUOffScreen，失败退窗口截取），可选存到 workspace |
| `polyhaven_search` | 搜 PolyHaven CC0 资产（模型/贴图/HDRI，无需 key） |
| `polyhaven_import` | 导入：HDRI 建世界环境并打包、贴图建 Principled 材质可直挂对象、模型 append 原生 .blend（新版本 .blend 自动退 glTF） |
| `addon_status` | Blender 端体检（引擎、相机、PolyHaven API 连通性） |

## 安全说明

- Blender 端 socket 只监听 `127.0.0.1`，无鉴权——和上游 blender-mcp 一致，**不要把端口暴露到局域网**。
- `execute_code` 的「Live 安全模式」是静态正则检查（防误伤，不是沙箱），默认开启，可在插件设置关闭。
- PolyHaven 下载发生在 Blender 主线程，大文件会卡界面几秒，属上游已知行为。

## 致谢与许可

- 官方部分：ZCode blender 插件（MIT）原样保留，见 [LICENSE](LICENSE)。
- Live 部分架构参考 [mcp-for-blender](https://github.com/ahujasid/mcp-for-blender)（MIT）与
  [dsh-blender-plugin](https://github.com/sixtysevenlf/dsh-blender-plugin)（MIT），为本项目重写实现。
- PolyHaven 资产遵循其 [API 条款](https://github.com/Poly-Haven/Public-API/blob/master/ToS.md)，全部 CC0。
