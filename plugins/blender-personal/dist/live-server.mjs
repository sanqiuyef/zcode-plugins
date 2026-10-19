#!/usr/bin/env node
// blender-live：ZCode 的 MCP stdio 服务，把工具调用经 TCP 转发给 Blender 里的
// ZCode Live Bridge 插件（blender/live_addon.py）。零依赖，只用 node 内置模块。
//
// MCP 走 newline 分隔的 JSON-RPC；Blender 端协议也是每行一个 JSON：
// 请求 {"id", "cmd", "args"} → 响应 {"id", "ok", "result"|"error"}。
//
// 环境变量（plugin.json 注入）：
//   ZCODE_BLENDER_LIVE_HOST / ZCODE_BLENDER_LIVE_PORT   Blender 端地址，默认 127.0.0.1:9878
//   ZCODE_BLENDER_LIVE_SAFE_MODE                        execute_code 安全检查，默认开
//   ZCODE_WORKSPACE_ROOT                                workspace，限定截图保存路径

import net from "node:net";
import path from "node:path";
import fs from "node:fs";
import process from "node:process";

const HOST = (process.env.ZCODE_BLENDER_LIVE_HOST || "127.0.0.1").trim() || "127.0.0.1";
const PORT = Number(process.env.ZCODE_BLENDER_LIVE_PORT || 9878) || 9878;
const SAFE_MODE = !/^(0|false|no|off)$/i.test((process.env.ZCODE_BLENDER_LIVE_SAFE_MODE ?? "").trim());
const WORKSPACE_ROOT = path.resolve(process.env.ZCODE_WORKSPACE_ROOT || process.cwd());
const SERVER_VERSION = "0.3.0";

const TIMEOUTS = {
  default: 30_000,
  execute_code: 120_000,
  viewport_screenshot: 60_000,
  polyhaven_search: 60_000,
  polyhaven_import: 360_000,
};

// ---------------------------------------------------------------------------
// 安全模式：execute_code 的静态检查（与 headless 桥的 AST 守卫同思路，正则近似）
// ---------------------------------------------------------------------------

const BLOCKED_MODULES =
  "os|sys|subprocess|socket|shutil|ctypes|importlib|multiprocessing|http|urllib|ftplib|smtplib|pickle|tempfile|glob|pathlib|builtins|threading|signal";
const RISKY_PATTERNS = [
  [new RegExp(`\\bimport\\s+${BLOCKED_MODULES}\\b`), "import 受限模块"],
  [new RegExp(`\\bfrom\\s+${BLOCKED_MODULES}\\b`), "from 受限模块导入"],
  [/\b__import__\s*\(/, "__import__"],
  [/\b(eval|exec|compile)\s*\(/, "eval/exec/compile"],
  [/\bopen\s*\(/, "open()（文件读写）"],
  [/\bglobals\s*\(|\blocals\s*\(|\bvars\s*\(/, "globals/locals/vars 内省"],
  [/\bbreakpoint\s*\(|\binput\s*\(/, "breakpoint/input"],
  [new RegExp(`\\b(os|shutil|pathlib)\\s*\\.`), "os/shutil/pathlib 属性访问"],
  [/\bsubprocess\b|\bPopen\s*\(/, "子进程"],
  [/\.(system|popen|remove|unlink|rmdir|rename|mkdir|makedirs|rmtree)\s*\(/, "文件系统写操作"],
];

function checkSafeMode(code) {
  for (const [pattern, label] of RISKY_PATTERNS) {
    const match = pattern.exec(code);
    if (match) {
      return { blocked: true, label, snippet: match[0] };
    }
  }
  return { blocked: false };
}

// ---------------------------------------------------------------------------
// TCP 客户端：每次调用新建连接（本地连接开销可忽略，免去断线状态管理）
// ---------------------------------------------------------------------------

function callAddon(cmd, args, timeoutMs = TIMEOUTS.default) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: HOST, port: PORT });
    let buffer = "";
    let settled = false;
    const done = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      fn(value);
    };
    const timer = setTimeout(
      () =>
        done(reject, new Error(
          `等待 Blender 响应超时（${timeoutMs}ms）。Blender 可能在忙（渲染/弹窗），` +
          `或 ZCode Live 没连接：N 面板 → ZCode Live → 连接 ZCode`,
        )),
      timeoutMs,
    );
    socket.on("connect", () => {
      socket.write(JSON.stringify({ id: 1, cmd, args }) + "\n");
    });
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf-8");
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      const line = buffer.slice(0, newline);
      try {
        const response = JSON.parse(line);
        if (response.ok) done(resolve, response.result);
        else {
          const error = new Error(String(response.error ?? "unknown error"));
          if (response.traceback) error.message += `\n${response.traceback}`;
          done(reject, error);
        }
      } catch (error) {
        done(reject, new Error(`Blender 响应不是合法 JSON：${error.message}`));
      }
    });
    socket.on("error", (error) => {
      done(reject, new Error(
        `连不上 Blender（${HOST}:${PORT}，${error.code || error.message}）。` +
        `请打开 Blender，在 3D 视口按 N → ZCode Live → 连接 ZCode`,
      ));
    });
  });
}

// ---------------------------------------------------------------------------
// 工具定义
// ---------------------------------------------------------------------------

const str = (description) => ({ type: "string", description });
const obj = (properties, required = []) => ({ type: "object", properties, required, additionalProperties: false });

const TOOLS = [
  {
    name: "connection_status",
    description:
      "检查与正在运行的 Blender GUI 的实时连接：Blender/addon 版本、场景、对象数、PolyHaven 开关。任何 Blender Live 工具失败时先用它诊断。",
    inputSchema: obj({}),
  },
  {
    name: "get_scene_info",
    description:
      "读取用户当前打开的 Blender 场景：逐对象的位置/尺寸/材质/面数，活动相机、渲染引擎、世界环境。修改前先读一次。",
    inputSchema: obj({}),
  },
  {
    name: "get_object_info",
    description: "读取单个对象的详细信息：变换、修改器、子级、自定义属性、世界矩阵。",
    inputSchema: obj({ name: str("对象名，区分大小写，来自 get_scene_info") }, ["name"]),
  },
  {
    name: "execute_code",
    description:
      "在用户正在运行的 Blender 里执行任意 bpy Python（主线程），print 输出会返回。适合结构化工具做不到的批量操作、修改器、动画、脚本建模。改完建议调 viewport_screenshot 让用户确认。默认安全模式会拦截文件/网络/子进程类代码。",
    inputSchema: obj({ code: str("要执行的 Python 代码，bpy 已注入") }, ["code"]),
  },
  {
    name: "viewport_screenshot",
    description:
      "截取用户 Blender 当前 3D 视口画面（离屏渲染，不需要窗口在前台）。每次改动后调它做视觉自检，图片直接展示给用户。",
    inputSchema: obj({
      maxSize: { type: "integer", description: "最长边像素，默认 800" },
      savePath: str("可选，保存到 workspace 内的路径（相对 workspace 或绝对）；不给只回传图片不落盘 workspace"),
    }),
  },
  {
    name: "polyhaven_search",
    description:
      "搜索 PolyHaven 的 CC0 免费资产（模型/贴图/HDRI，无需 API key）。返回 id、名称、分类、缩略图 URL。用户要『打光/贴图/加个家具模型』时先搜再导入。",
    inputSchema: obj({
      query: str("搜索词，中英文皆可，如 overcast afternoon / 藤椅"),
      assetType: { type: "string", enum: ["all", "models", "textures", "hdris"], description: "资产类型，默认 all" },
      limit: { type: "integer", description: "返回条数，默认 8，最多 20" },
    }, ["query"]),
  },
  {
    name: "polyhaven_import",
    description:
      "把 PolyHaven 资产导入当前场景（下载源在 Blender 主线程进行，大文件会慢）：hdri 建新世界环境并打包；textures 建 Principled 材质（applyTo 指定应用对象）；models append 原生 .blend 集合。资产均为 CC0。",
    inputSchema: obj({
      assetId: str("polyhaven_search 返回的 id"),
      assetType: { type: "string", enum: ["models", "textures", "hdris"], description: "资产类型" },
      resolution: str("分辨率，默认 1k；近景模型可用 2k"),
      applyTo: str("仅 textures：把材质应用到哪个网格对象（清掉原材质后挂上）"),
    }, ["assetId", "assetType"]),
  },
  {
    name: "addon_status",
    description: "Blender 端体检：版本、引擎、相机、场景数、PolyHaven 开关与 API 连通性。",
    inputSchema: obj({}),
  },
];

// ---------------------------------------------------------------------------
// 工具执行
// ---------------------------------------------------------------------------

function guardWorkspacePath(savePath) {
  const resolved = path.isAbsolute(savePath) ? path.resolve(savePath) : path.resolve(WORKSPACE_ROOT, savePath);
  const rootWithSep = WORKSPACE_ROOT.endsWith(path.sep) ? WORKSPACE_ROOT : WORKSPACE_ROOT + path.sep;
  const inside = resolved === WORKSPACE_ROOT || resolved.toLowerCase().startsWith(rootWithSep.toLowerCase());
  if (!inside) {
    throw new Error(`savePath 必须在 workspace 内：${savePath}（workspace = ${WORKSPACE_ROOT}）`);
  }
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  return resolved;
}

async function callTool(name, args) {
  const content = [];
  const fail = (message) => ({ content: [{ type: "text", text: message }], isError: true });

  try {
    if (name === "execute_code") {
      const code = String(args?.code ?? "");
      if (SAFE_MODE) {
        const check = checkSafeMode(code);
        if (check.blocked) {
          return fail(
            `安全模式拦截了 ${check.label}（命中 ${JSON.stringify(check.snippet)}）。` +
              `这是防误伤的静态检查，不是沙箱：确有需要时让用户在插件设置里关闭「Live 安全模式」，` +
              `或改用 headless 通道（blender 插件的 run_python，走审批流）。`,
          );
        }
      }
      const result = await callAddon("execute_code", { code }, TIMEOUTS.execute_code);
      content.push({ type: "text", text: result.stdout ? `stdout:\n${result.stdout}` : "执行成功（无输出）" });
      return { content };
    }

    if (name === "viewport_screenshot") {
      const payload = {};
      if (args?.maxSize) payload.maxSize = args.maxSize;
      if (args?.savePath) payload.savePath = guardWorkspacePath(args.savePath);
      const result = await callAddon("viewport_screenshot", payload, TIMEOUTS.viewport_screenshot);
      const { image_base64, ...summary } = result;
      content.push({ type: "text", text: JSON.stringify(summary, null, 2) });
      if (image_base64) content.push({ type: "image", data: image_base64, mimeType: "image/png" });
      return { content };
    }

    const commandByTool = {
      connection_status: "ping",
      get_scene_info: "get_scene_info",
      get_object_info: "get_object_info",
      polyhaven_search: "polyhaven_search",
      polyhaven_import: "polyhaven_import",
      addon_status: "addon_status",
    };
    const command = commandByTool[name];
    if (!command) return fail(`unknown tool: ${name}`);

    const payloadByTool = {
      get_object_info: { name: args?.name },
      polyhaven_search: { query: args?.query, assetType: args?.assetType, limit: args?.limit },
      polyhaven_import: {
        assetId: args?.assetId,
        assetType: args?.assetType,
        resolution: args?.resolution,
        applyTo: args?.applyTo,
      },
    };
    const result = await callAddon(command, payloadByTool[name] ?? {}, TIMEOUTS[name] ?? TIMEOUTS.default);
    content.push({ type: "text", text: JSON.stringify(result, null, 2) });
    return { content };
  } catch (error) {
    return fail(error.message);
  }
}

// ---------------------------------------------------------------------------
// MCP stdio（newline JSON-RPC）
// ---------------------------------------------------------------------------

const SERVER_INFO = { name: "blender-live", version: SERVER_VERSION };

function writeLine(payload) {
  process.stdout.write(JSON.stringify(payload) + "\n");
}

function handleRequest(message) {
  const { id, method, params } = message;
  switch (method) {
    case "initialize":
      return {
        protocolVersion: params?.protocolVersion ?? "2024-11-05",
        capabilities: { tools: {}, logging: {} },
        serverInfo: SERVER_INFO,
      };
    case "ping":
      return {};
    case "tools/list":
      return { tools: TOOLS };
    case "prompts/list":
      return { prompts: [] };
    case "resources/list":
      return { resources: [] };
    case "resources/templates/list":
      return { resourceTemplates: [] };
    case "completion/complete":
      return { completion: { values: [], hasMore: false } };
    case "tools/call": {
      const name = params?.name;
      const tool = TOOLS.find((t) => t.name === name);
      if (!tool) {
        return { content: [{ type: "text", text: `unknown tool: ${name}` }], isError: true };
      }
      return callTool(name, params?.arguments ?? {}).then((result) => result);
    }
    default:
      return { __rpcError: { code: -32601, message: `method not found: ${method}` } };
  }
}

let buffer = "";
process.stdin.setEncoding("utf-8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let newline;
  while ((newline = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (!line) continue;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      continue;
    }
    if (message.id === undefined || message.id === null) continue; // notification，只吞不答
    try {
      const result = handleRequest(message);
      if (result instanceof Promise) {
        result
          .then((value) => sendResult(message.id, value))
          .catch((error) => sendResult(message.id, { __rpcError: { code: -32603, message: String(error?.message ?? error) } }));
      } else {
        sendResult(message.id, result);
      }
    } catch (error) {
      sendResult(message.id, { __rpcError: { code: -32603, message: String(error?.message ?? error) } });
    }
  }
});
process.stdin.on("end", () => process.exit(0));
process.on("SIGINT", () => process.exit(0));
process.on("SIGTERM", () => process.exit(0));

function sendResult(id, value) {
  if (value && typeof value === "object" && value.__rpcError) {
    writeLine({ jsonrpc: "2.0", id, error: value.__rpcError });
  } else {
    writeLine({ jsonrpc: "2.0", id, result: value });
  }
}
