import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const NAME = "web-bookmarks";
const VERSION = "0.1.0";
const PANEL_URI = "ui://web-bookmarks/panel.html";
const HTML_MIME = "text/html;profile=mcp-app";
const MAX_BOOKMARKS = 500;

type Bookmark = {
  id: string;
  title: string;
  url: string;
  note?: string;
  createdAt: number;
};

type Store = {
  version: 1;
  bookmarks: Bookmark[];
};

const DEFAULT_BOOKMARKS: Bookmark[] = [
  {
    id: "deepseek-web",
    title: "DeepSeek 网页端",
    url: "https://chat.deepseek.com/",
    note: "网页版对话",
    createdAt: 0,
  },
];

function usableDir(value: string | undefined): string | null {
  const text = value?.trim();
  if (!text || text.includes("${")) return null;
  return text;
}

const STORE_DIR =
  usableDir(process.env.ZCODE_BOOKMARKS_DATA) ??
  usableDir(process.env.ZCODE_PLUGIN_DATA) ??
  join(homedir(), ".zcode", "plugin-data", NAME);
const STORE_FILE = join(STORE_DIR, "bookmarks.json");

function isBookmark(value: unknown): value is Bookmark {
  if (!value || typeof value !== "object") return false;
  const item = value as Record<string, unknown>;
  return (
    typeof item.id === "string" &&
    item.id.length > 0 &&
    typeof item.title === "string" &&
    typeof item.url === "string" &&
    typeof item.createdAt === "number"
  );
}

function normalizeStoredBookmark(bookmark: Bookmark): Bookmark {
  return {
    id: bookmark.id.slice(0, 100),
    title: bookmark.title.trim().slice(0, 120) || "未命名网站",
    url: bookmark.url,
    ...(typeof bookmark.note === "string" && bookmark.note.trim()
      ? { note: bookmark.note.trim().slice(0, 200) }
      : {}),
    createdAt: Number.isFinite(bookmark.createdAt) ? bookmark.createdAt : Date.now(),
  };
}

async function loadStore(): Promise<Store> {
  try {
    const raw = await readFile(STORE_FILE, "utf8");
    const parsed = JSON.parse(raw) as Partial<Store>;
    if (parsed.version !== 1 || !Array.isArray(parsed.bookmarks)) {
      throw new Error("收藏文件格式不正确");
    }
    return {
      version: 1,
      bookmarks: parsed.bookmarks
        .filter(isBookmark)
        .map(normalizeStoredBookmark)
        .slice(0, MAX_BOOKMARKS),
    };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return {
        version: 1,
        bookmarks: DEFAULT_BOOKMARKS.map((bookmark) => ({
          ...bookmark,
          createdAt: Date.now(),
        })),
      };
    }
    throw new Error(
      `无法读取收藏文件 ${STORE_FILE}：${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

async function saveStore(store: Store): Promise<void> {
  await mkdir(dirname(STORE_FILE), { recursive: true });
  const temp = `${STORE_FILE}.${process.pid}.tmp`;
  await writeFile(temp, `${JSON.stringify(store, null, 2)}\n`, "utf8");
  await rename(temp, STORE_FILE);
}

let mutationQueue: Promise<unknown> = Promise.resolve();

function mutate<T>(work: (store: Store) => T | Promise<T>): Promise<T> {
  const next = mutationQueue.then(async () => {
    const store = await loadStore();
    const result = await work(store);
    await saveStore(store);
    return result;
  });
  mutationQueue = next.catch(() => undefined);
  return next;
}

function parseHttpUrl(input: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(input.trim());
  } catch {
    throw new Error("网址格式不对，请填写完整地址，例如 https://example.com");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("只支持 http / https 网址");
  }
  if (!parsed.hostname) {
    throw new Error("网址缺少域名");
  }
  return parsed;
}

function normalizeUrl(input: string): string {
  const parsed = parseHttpUrl(input);
  parsed.hash = "";
  let path = parsed.pathname.replace(/\/+$/, "");
  if (!path) path = "/";
  return `${parsed.protocol}//${parsed.host.toLowerCase()}${path}${parsed.search}`;
}

function urlKey(input: string): string {
  const parsed = parseHttpUrl(input);
  let path = parsed.pathname.replace(/\/+$/, "");
  if (!path) path = "/";
  return `${parsed.host.toLowerCase()}${path}${parsed.search}`;
}

function displayTitle(input: string | undefined, url: URL): string {
  const title = input?.trim();
  if (title) return title.slice(0, 120);
  return url.hostname.replace(/^www\./, "") || "未命名网站";
}

const bookmarkSchema = z.object({
  id: z.string(),
  title: z.string(),
  url: z.string(),
  note: z.string().optional(),
  createdAt: z.number(),
});

const listOutput = { bookmarks: z.array(bookmarkSchema), storeFile: z.string() };

const server = new McpServer({ name: NAME, version: VERSION });

server.registerTool(
  "bookmarks_list",
  {
    title: "列出网站收藏",
    description:
      "列出侧栏网站收藏夹中的网站。用户询问「收藏了哪些网站」或需要在内置浏览器打开某个常用网站时使用。",
    inputSchema: {},
    outputSchema: listOutput,
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    _meta: { ui: { resourceUri: PANEL_URI, visibility: ["model", "app"] } },
  },
  async () => {
    const store = await loadStore();
    return {
      content: [{ type: "text", text: `共 ${store.bookmarks.length} 条网站收藏。` }],
      structuredContent: { bookmarks: store.bookmarks, storeFile: STORE_FILE },
    };
  },
);

server.registerTool(
  "bookmarks_add",
  {
    title: "添加网站收藏",
    description:
      "把一个 http/https 网站加入侧栏收藏夹。仅在用户明确要求收藏某个网站时调用；重复网址会返回已有条目。",
    inputSchema: {
      title: z.string().min(1).max(120).describe("网站显示名称"),
      url: z.string().min(1).max(2048).describe("完整网址，必须带 http:// 或 https://"),
      note: z.string().max(200).optional().describe("可选备注"),
    },
    outputSchema: {
      bookmark: bookmarkSchema,
      bookmarks: z.array(bookmarkSchema),
      existed: z.boolean(),
      storeFile: z.string(),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    _meta: { ui: { resourceUri: PANEL_URI, visibility: ["model", "app"] } },
  },
  async ({ title, url, note }) => {
    const parsed = parseHttpUrl(url);
    const normalized = normalizeUrl(url);
    const key = urlKey(normalized);
    return mutate((store) => {
      if (store.bookmarks.length >= MAX_BOOKMARKS) {
        throw new Error(`收藏数量已达上限（${MAX_BOOKMARKS} 条）`);
      }
      const existing = store.bookmarks.find((bookmark) => urlKey(bookmark.url) === key);
      if (existing) {
        return {
          content: [{ type: "text" as const, text: `该网址已在收藏中：${existing.title}` }],
          structuredContent: {
            bookmark: existing,
            bookmarks: store.bookmarks,
            existed: true,
            storeFile: STORE_FILE,
          },
        };
      }
      const bookmark: Bookmark = {
        id: randomUUID(),
        title: displayTitle(title, parsed),
        url: normalized,
        ...(note?.trim() ? { note: note.trim().slice(0, 200) } : {}),
        createdAt: Date.now(),
      };
      store.bookmarks.push(bookmark);
      return {
        content: [{ type: "text" as const, text: `已添加收藏：${bookmark.title}` }],
        structuredContent: {
          bookmark,
          bookmarks: store.bookmarks,
          existed: false,
          storeFile: STORE_FILE,
        },
      };
    });
  },
);

server.registerTool(
  "bookmarks_update",
  {
    title: "修改网站收藏",
    description: "修改某条网站收藏的名称、网址或备注。",
    inputSchema: {
      id: z.string().min(1).max(100),
      title: z.string().min(1).max(120).optional(),
      url: z.string().min(1).max(2048).optional(),
      note: z.string().max(200).optional(),
    },
    outputSchema: {
      bookmark: bookmarkSchema,
      bookmarks: z.array(bookmarkSchema),
      storeFile: z.string(),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    _meta: { ui: { resourceUri: PANEL_URI, visibility: ["app"] } },
  },
  async ({ id, title, url, note }) =>
    mutate((store) => {
      const bookmark = store.bookmarks.find((item) => item.id === id);
      if (!bookmark) throw new Error("收藏不存在，可能已被删除");
      if (url !== undefined) {
        const key = urlKey(normalizeUrl(url));
        if (store.bookmarks.some((item) => item.id !== id && urlKey(item.url) === key)) {
          throw new Error("这个网址已经在收藏里了");
        }
        bookmark.url = normalizeUrl(url);
      }
      if (title !== undefined) {
        const nextTitle = title.trim();
        if (!nextTitle) throw new Error("名称不能为空");
        bookmark.title = nextTitle.slice(0, 120);
      }
      if (note !== undefined) {
        const nextNote = note.trim();
        if (nextNote) bookmark.note = nextNote.slice(0, 200);
        else delete bookmark.note;
      }
      return {
        content: [{ type: "text" as const, text: `已更新收藏：${bookmark.title}` }],
        structuredContent: {
          bookmark,
          bookmarks: store.bookmarks,
          storeFile: STORE_FILE,
        },
      };
    }),
);

server.registerTool(
  "bookmarks_remove",
  {
    title: "删除网站收藏",
    description: "删除某条网站收藏（仅侧栏面板可调用）。",
    inputSchema: { id: z.string().min(1).max(100) },
    outputSchema: {
      bookmarks: z.array(bookmarkSchema),
      removed: z.string(),
      storeFile: z.string(),
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
    _meta: { ui: { resourceUri: PANEL_URI, visibility: ["app"] } },
  },
  async ({ id }) =>
    mutate((store) => {
      const index = store.bookmarks.findIndex((item) => item.id === id);
      if (index < 0) throw new Error("收藏不存在，可能已被删除");
      const [removed] = store.bookmarks.splice(index, 1);
      return {
        content: [{ type: "text" as const, text: `已删除收藏：${removed.title}` }],
        structuredContent: {
          bookmarks: store.bookmarks,
          removed: removed.id,
          storeFile: STORE_FILE,
        },
      };
    }),
);

const serverDir = dirname(fileURLToPath(import.meta.url));
const panelFile = join(serverDir, "..", "ui", "dist", "panel.html");

server.registerResource(
  "panel",
  PANEL_URI,
  {
    title: "网站收藏",
    description: "侧栏网站收藏面板：一键在内置浏览器打开常用网站。",
    mimeType: HTML_MIME,
    _meta: { ui: { prefersBorder: false } },
  },
  async () => ({
    contents: [
      {
        uri: PANEL_URI,
        mimeType: HTML_MIME,
        text: await readFile(panelFile, "utf8"),
      },
    ],
  }),
);

const transport = new StdioServerTransport();
await server.connect(transport);
console.error(`[web-bookmarks] ready: ${STORE_FILE}`);
