import { createRequire } from "node:module";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const pluginRoot = join(here, "..");
const require = createRequire(join(pluginRoot, "ui-src", "package.json"));
const { build } = require("esbuild");

const nodePaths = process.env.ESBUILD_NODE_PATH
  ? process.env.ESBUILD_NODE_PATH.split(delimiter).filter(Boolean)
  : [join(pluginRoot, "ui-src", "node_modules")];

await build({
  entryPoints: [join(here, "server.ts")],
  outfile: join(pluginRoot, "dist", "server.mjs"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  minify: false,
  legalComments: "none",
  banner: { js: "#!/usr/bin/env node" },
  nodePaths,
});

console.log("[web-bookmarks] dist/server.mjs");
