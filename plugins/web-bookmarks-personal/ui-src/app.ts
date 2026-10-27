import {
  App,
  applyDocumentTheme,
  applyHostFonts,
  applyHostStyleVariables,
} from "@modelcontextprotocol/ext-apps";

type Bookmark = {
  id: string;
  title: string;
  url: string;
  note?: string;
  createdAt: number;
};

type ListResult = { bookmarks: Bookmark[]; storeFile: string };
type AddResult = {
  bookmark: Bookmark;
  bookmarks: Bookmark[];
  existed: boolean;
  storeFile: string;
};
type UpdateResult = { bookmark: Bookmark; bookmarks: Bookmark[]; storeFile: string };
type RemoveResult = { bookmarks: Bookmark[]; removed: string; storeFile: string };

const app = new App({ name: "web-bookmarks", version: "0.1.0" }, {});

function byId<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`面板缺少元素 #${id}`);
  return node as T;
}

const el = {
  status: byId<HTMLDivElement>("status"),
  addBtn: byId<HTMLButtonElement>("addBtn"),
  search: byId<HTMLInputElement>("search"),
  searchClear: byId<HTMLButtonElement>("searchClear"),
  main: byId<HTMLElement>("main"),
  heroWrap: byId<HTMLDivElement>("heroWrap"),
  list: byId<HTMLDivElement>("list"),
  count: byId<HTMLSpanElement>("count"),
  refreshBtn: byId<HTMLButtonElement>("refreshBtn"),
  overlay: byId<HTMLDivElement>("overlay"),
  sheetTitle: byId<HTMLHeadingElement>("sheetTitle"),
  closeSheet: byId<HTMLButtonElement>("closeSheet"),
  form: byId<HTMLFormElement>("bookmarkForm"),
  fTitle: byId<HTMLInputElement>("fTitle"),
  fUrl: byId<HTMLInputElement>("fUrl"),
  fNote: byId<HTMLInputElement>("fNote"),
  formError: byId<HTMLParagraphElement>("formError"),
  cancelBtn: byId<HTMLButtonElement>("cancelBtn"),
  saveBtn: byId<HTMLButtonElement>("saveBtn"),
  confirmOverlay: byId<HTMLDivElement>("confirmOverlay"),
  confirmText: byId<HTMLParagraphElement>("confirmText"),
  confirmCancel: byId<HTMLButtonElement>("confirmCancel"),
  confirmDelete: byId<HTMLButtonElement>("confirmDelete"),
  toast: byId<HTMLDivElement>("toast"),
};

const state = {
  bookmarks: [] as Bookmark[],
  loading: true,
  error: "",
  filter: "",
  mode: "add" as "add" | "edit",
  editingId: null as string | null,
  pendingDelete: null as Bookmark | null,
};

let toastTimer: number | undefined;

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => {
    switch (char) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      default:
        return "&#39;";
    }
  });
}

function hostOf(url: string): string {
  try {
    return new URL(url).host.replace(/^www\./, "");
  } catch {
    return url;
  }
}

function hueFor(value: string): number {
  let hue = 0;
  for (const char of value) hue = (hue * 31 + char.charCodeAt(0)) % 360;
  return hue;
}

function initialFor(bookmark: Bookmark): string {
  const title = bookmark.title.trim();
  return (title[0] ?? hostOf(bookmark.url)[0] ?? "?").toUpperCase();
}

function isDeepSeek(bookmark: Bookmark): boolean {
  try {
    return new URL(bookmark.url).hostname.toLowerCase().endsWith("deepseek.com");
  } catch {
    return false;
  }
}

function matchesFilter(bookmark: Bookmark): boolean {
  if (!state.filter) return true;
  const haystack = `${bookmark.title} ${bookmark.url} ${bookmark.note ?? ""}`.toLowerCase();
  return haystack.includes(state.filter);
}

function showToast(message: string): void {
  el.toast.textContent = message;
  el.toast.hidden = false;
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => {
    el.toast.hidden = true;
  }, 2400);
}

function errorText(result: unknown): string {
  const content = (result as { content?: unknown }).content;
  if (!Array.isArray(content)) return "操作失败";
  const text = content
    .filter((block): block is { type: "text"; text: string } => {
      return Boolean(
        block &&
          typeof block === "object" &&
          (block as { type?: unknown }).type === "text" &&
          typeof (block as { text?: unknown }).text === "string",
      );
    })
    .map((block) => block.text)
    .join("\n")
    .trim();
  return text || "操作失败";
}

async function call<T>(name: string, args: Record<string, unknown> = {}): Promise<T> {
  const result = await app.callServerTool({ name, arguments: args }, { timeout: 30_000 });
  if (result.isError) throw new Error(errorText(result));
  const structured = result.structuredContent;
  if (!structured) throw new Error("服务端没有返回结构化数据");
  return structured as T;
}

function applyHostTheme(): void {
  const context = app.getHostContext();
  const theme = context?.theme ?? "light";
  document.documentElement.dataset.theme = theme;
  applyDocumentTheme(theme);
  const variables = context?.styles?.variables;
  if (variables) applyHostStyleVariables(variables);
  const fonts = context?.styles?.css?.fonts;
  if (fonts) applyHostFonts(fonts);
}

function cardHtml(bookmark: Bookmark): string {
  const host = hostOf(bookmark.url);
  return `<div class="card" role="button" tabindex="0" data-open="${escapeHtml(bookmark.id)}" aria-label="打开 ${escapeHtml(bookmark.title)}">
    <div class="avatar" style="--hue:${hueFor(host)}" aria-hidden="true">${escapeHtml(initialFor(bookmark))}</div>
    <div class="meta">
      <div class="title">${escapeHtml(bookmark.title)}</div>
      <div class="url">${escapeHtml(host)}</div>
      ${bookmark.note ? `<div class="note">${escapeHtml(bookmark.note)}</div>` : ""}
    </div>
    <div class="actions">
      <button class="act" type="button" data-edit="${escapeHtml(bookmark.id)}" title="编辑" aria-label="编辑">✎</button>
      <button class="act danger" type="button" data-delete="${escapeHtml(bookmark.id)}" title="删除" aria-label="删除">✕</button>
    </div>
  </div>`;
}

function renderHero(bookmark: Bookmark | null): void {
  if (!bookmark) {
    el.heroWrap.innerHTML = "";
    return;
  }
  el.heroWrap.innerHTML = `<section class="hero" role="button" tabindex="0" data-open="${escapeHtml(
    bookmark.id,
  )}" aria-label="打开 ${escapeHtml(bookmark.title)}">
    <div class="hero-logo" aria-hidden="true">DS</div>
    <div class="hero-text">
      <div class="hero-title">${escapeHtml(bookmark.title)}</div>
      <div class="hero-sub">点一下就在内置浏览器打开</div>
    </div>
    <button class="hero-open" type="button" data-open="${escapeHtml(bookmark.id)}">打开</button>
    <button class="hero-edit" type="button" data-edit="${escapeHtml(bookmark.id)}" title="编辑" aria-label="编辑">✎</button>
  </section>`;
}

function updateStatus(): void {
  if (state.loading) {
    el.status.textContent = "正在加载…";
    el.count.textContent = "—";
    return;
  }
  if (state.error) {
    el.status.textContent = "连接异常";
    el.count.textContent = "—";
    return;
  }
  el.status.textContent = `${state.bookmarks.length} 个收藏 · 点击直接打开`;
  el.count.textContent = `${state.bookmarks.length} 个收藏`;
}

function renderList(): void {
  el.searchClear.hidden = !state.filter;

  if (state.loading) {
    el.heroWrap.innerHTML = "";
    el.list.innerHTML = `<div class="empty"><div class="empty-title">加载中…</div></div>`;
    updateStatus();
    return;
  }

  if (state.error) {
    el.heroWrap.innerHTML = "";
    el.list.innerHTML = `<div class="error">${escapeHtml(
      state.error,
    )}</div><div class="empty"><button class="btn" type="button" data-retry>重试</button></div>`;
    updateStatus();
    return;
  }

  const filtered = state.bookmarks.filter(matchesFilter);
  const hero = filtered.find(isDeepSeek) ?? null;
  renderHero(hero);

  const rest = filtered.filter((bookmark) => !isDeepSeek(bookmark));

  if (state.bookmarks.length === 0) {
    el.list.innerHTML = `<div class="empty">
      <div class="empty-icon" aria-hidden="true">☆</div>
      <div class="empty-title">收藏夹还是空的</div>
      <div class="empty-sub">把常用网站放进来，以后一键打开。</div>
      <button class="btn primary" type="button" data-add>添加第一个网站</button>
    </div>`;
  } else if (filtered.length === 0) {
    el.list.innerHTML = `<div class="empty">
      <div class="empty-title">没有匹配的收藏</div>
      <div class="empty-sub">换个关键词试试。</div>
    </div>`;
  } else {
    el.list.innerHTML =
      rest.map(cardHtml).join("") +
      `<button class="card add-card" type="button" data-add>＋ 添加网站</button>`;
  }

  updateStatus();
}

async function openBookmark(bookmark: Bookmark): Promise<void> {
  const capabilities = app.getHostCapabilities();
  if (!capabilities?.openLinks) {
    await copyText(bookmark.url);
    showToast("当前宿主不支持直接打开，网址已复制");
    return;
  }
  try {
    const result = await app.openLink({ url: bookmark.url });
    if ((result as { isError?: boolean } | undefined)?.isError) {
      throw new Error("宿主拒绝了打开请求");
    }
    showToast(`已在内置浏览器打开：${bookmark.title}`);
  } catch (error) {
    await copyText(bookmark.url);
    showToast(
      `打开失败，网址已复制：${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

async function openBookmarkById(id: string): Promise<void> {
  const bookmark = state.bookmarks.find((item) => item.id === id);
  if (bookmark) await openBookmark(bookmark);
}

async function copyText(text: string): Promise<void> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return;
    }
  } catch {
    // Fall through to the legacy path.
  }
  const area = document.createElement("textarea");
  area.value = text;
  area.style.position = "fixed";
  area.style.opacity = "0";
  document.body.appendChild(area);
  area.select();
  try {
    document.execCommand("copy");
  } catch {
    // Nothing else to do; the caller still shows the failure.
  }
  area.remove();
}

function showFormError(message: string): void {
  el.formError.textContent = message;
  el.formError.hidden = false;
}

function setFormBusy(busy: boolean): void {
  el.saveBtn.disabled = busy;
  el.saveBtn.textContent = busy ? "保存中…" : "保存";
}

function openAdd(): void {
  state.mode = "add";
  state.editingId = null;
  el.sheetTitle.textContent = "添加网站";
  el.fTitle.value = "";
  el.fUrl.value = "";
  el.fNote.value = "";
  el.formError.hidden = true;
  el.overlay.hidden = false;
  el.fUrl.focus();
}

function openEdit(id: string): void {
  const bookmark = state.bookmarks.find((item) => item.id === id);
  if (!bookmark) return;
  state.mode = "edit";
  state.editingId = id;
  el.sheetTitle.textContent = "编辑网站";
  el.fTitle.value = bookmark.title;
  el.fUrl.value = bookmark.url;
  el.fNote.value = bookmark.note ?? "";
  el.formError.hidden = true;
  el.overlay.hidden = false;
  el.fTitle.focus();
  el.fTitle.select();
}

function closeSheet(): void {
  el.overlay.hidden = true;
  el.formError.hidden = true;
}

function askDelete(id: string): void {
  const bookmark = state.bookmarks.find((item) => item.id === id);
  if (!bookmark) return;
  state.pendingDelete = bookmark;
  el.confirmText.textContent = `「${bookmark.title}」将从收藏夹移除，之后仍可重新添加。`;
  el.confirmOverlay.hidden = false;
  el.confirmDelete.focus();
}

function closeConfirm(): void {
  el.confirmOverlay.hidden = true;
  state.pendingDelete = null;
}

async function doDelete(): Promise<void> {
  const bookmark = state.pendingDelete;
  if (!bookmark) return;
  el.confirmDelete.disabled = true;
  try {
    const result = await call<RemoveResult>("bookmarks_remove", { id: bookmark.id });
    state.bookmarks = result.bookmarks;
    closeConfirm();
    renderList();
    showToast("已删除");
  } catch (error) {
    showToast(`删除失败：${error instanceof Error ? error.message : String(error)}`);
  } finally {
    el.confirmDelete.disabled = false;
  }
}

async function refresh(): Promise<void> {
  state.loading = true;
  state.error = "";
  renderList();
  try {
    const result = await call<ListResult>("bookmarks_list");
    state.bookmarks = result.bookmarks ?? [];
  } catch (error) {
    state.error = error instanceof Error ? error.message : String(error);
  } finally {
    state.loading = false;
    renderList();
  }
}

function wireEvents(): void {
  el.addBtn.addEventListener("click", openAdd);
  el.refreshBtn.addEventListener("click", () => void refresh());
  el.search.addEventListener("input", () => {
    state.filter = el.search.value.trim().toLowerCase();
    renderList();
  });
  el.searchClear.addEventListener("click", () => {
    el.search.value = "";
    state.filter = "";
    renderList();
    el.search.focus();
  });

  el.main.addEventListener("click", (event) => {
    const target = event.target as HTMLElement | null;
    if (!target) return;
    if (target.closest("[data-add]")) {
      openAdd();
      return;
    }
    if (target.closest("[data-retry]")) {
      void refresh();
      return;
    }
    const editId = target.closest<HTMLElement>("[data-edit]")?.dataset.edit;
    if (editId) {
      openEdit(editId);
      return;
    }
    const deleteId = target.closest<HTMLElement>("[data-delete]")?.dataset.delete;
    if (deleteId) {
      askDelete(deleteId);
      return;
    }
    const openId = target.closest<HTMLElement>("[data-open]")?.dataset.open;
    if (openId) void openBookmarkById(openId);
  });

  el.main.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    const target = event.target as HTMLElement | null;
    if (!target || target.closest("button")) return;
    const openId = target.closest<HTMLElement>("[data-open]")?.dataset.open;
    if (openId) {
      event.preventDefault();
      void openBookmarkById(openId);
    }
  });

  el.form.addEventListener("submit", (event) => {
    event.preventDefault();
    void submitForm();
  });
  el.cancelBtn.addEventListener("click", closeSheet);
  el.closeSheet.addEventListener("click", closeSheet);
  el.overlay.addEventListener("click", (event) => {
    if (event.target === el.overlay) closeSheet();
  });

  el.confirmCancel.addEventListener("click", closeConfirm);
  el.confirmDelete.addEventListener("click", () => void doDelete());
  el.confirmOverlay.addEventListener("click", (event) => {
    if (event.target === el.confirmOverlay) closeConfirm();
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "/" && !(event.target instanceof HTMLInputElement) && !(event.target instanceof HTMLTextAreaElement)) {
      event.preventDefault();
      el.search.focus();
      return;
    }
    if (event.key === "Escape") {
      if (!el.confirmOverlay.hidden) closeConfirm();
      else if (!el.overlay.hidden) closeSheet();
    }
  });
}

async function submitForm(): Promise<void> {
  const title = el.fTitle.value.trim();
  const url = el.fUrl.value.trim();
  const note = el.fNote.value.trim();
  el.formError.hidden = true;

  if (!url) {
    showFormError("请填写网址");
    el.fUrl.focus();
    return;
  }

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    showFormError("网址格式不对，请填写完整地址，例如 https://example.com");
    el.fUrl.focus();
    return;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    showFormError("只支持 http / https 网址");
    el.fUrl.focus();
    return;
  }

  const finalTitle = title || parsed.hostname.replace(/^www\./, "") || "未命名网站";
  setFormBusy(true);
  try {
    if (state.mode === "add") {
      const result = await call<AddResult>("bookmarks_add", {
        title: finalTitle,
        url,
        note,
      });
      state.bookmarks = result.bookmarks;
      closeSheet();
      renderList();
      showToast(result.existed ? "这个网址已经在收藏里了" : "已添加收藏");
    } else {
      const id = state.editingId;
      if (!id) throw new Error("缺少收藏 ID");
      const result = await call<UpdateResult>("bookmarks_update", {
        id,
        title: finalTitle,
        url,
        note,
      });
      state.bookmarks = result.bookmarks;
      closeSheet();
      renderList();
      showToast("已保存");
    }
  } catch (error) {
    showFormError(error instanceof Error ? error.message : String(error));
  } finally {
    setFormBusy(false);
  }
}

async function main(): Promise<void> {
  applyHostTheme();
  app.onhostcontextchanged = () => applyHostTheme();
  app.ontoolresult = (params) => {
    const structured = params.structuredContent as { bookmarks?: Bookmark[] } | undefined;
    if (structured && Array.isArray(structured.bookmarks)) {
      state.bookmarks = structured.bookmarks;
      state.loading = false;
      state.error = "";
      renderList();
    }
  };

  wireEvents();
  renderList();

  try {
    const connected = await Promise.race([
      app.connect().then(() => true),
      new Promise<boolean>((resolve) => window.setTimeout(() => resolve(false), 10_000)),
    ]);
    if (!connected) throw new Error("连接宿主超时");
  } catch (error) {
    state.loading = false;
    state.error = `无法连接 ZCode 宿主：${error instanceof Error ? error.message : String(error)}`;
    renderList();
    return;
  }

  applyHostTheme();
  await refresh();
}

void main();
