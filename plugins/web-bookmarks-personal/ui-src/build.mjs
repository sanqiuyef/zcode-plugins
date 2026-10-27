import { build } from "esbuild";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const pluginRoot = join(here, "..");
const outDir = join(pluginRoot, "ui", "dist");

const nodePaths = process.env.ESBUILD_NODE_PATH
  ? process.env.ESBUILD_NODE_PATH.split(delimiter).filter(Boolean)
  : [join(pluginRoot, "ui-src", "node_modules")];

const bundle = await build({
  entryPoints: [join(here, "app.ts")],
  bundle: true,
  format: "iife",
  platform: "browser",
  target: "es2022",
  minify: true,
  write: false,
  legalComments: "none",
  nodePaths,
});

const script = (bundle.outputFiles[0]?.text ?? "").replace(/<\/script/gi, "<\\/script");
const css = (await readFile(join(here, "panel.css"), "utf8")).replace(/<\/style/gi, "<\\/style");
const template = await readFile(join(here, "panel.template.html"), "utf8");
const html = template.replace("/*__CSS__*/", () => css).replace("/*__JS__*/", () => script);

await mkdir(outDir, { recursive: true });
await writeFile(join(outDir, "panel.html"), html, "utf8");
console.log(`[web-bookmarks] panel.html ${(Buffer.byteLength(html) / 1024).toFixed(1)} KiB`);
