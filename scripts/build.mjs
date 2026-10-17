// Builds the browser extension (extension/dist) and the web pages the Worker
// serves (worker/public). BACKROW_SERVER picks which server the extension talks to.
import { build } from "esbuild";
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";

// Only production builds go to extension/dist, which is committed so people can
// clone and Load unpacked. Builds for any other server stay out of git.
const DEFAULT_SERVER = "https://backrow.n3el.dev";
const SERVER = (process.env.BACKROW_SERVER ?? DEFAULT_SERVER).replace(/\/$/, "");
const OUT = SERVER === DEFAULT_SERVER ? "extension/dist" : "extension/dist-dev";
const pkg = JSON.parse(readFileSync("package.json", "utf8"));
const common = { bundle: true, target: "es2022", minify: true, sourcemap: false, logLevel: "warning", legalComments: "none" };

// Extension
rmSync(OUT, { recursive: true, force: true });
mkdirSync(`${OUT}/icons`, { recursive: true });
const define = { __BACKROW_SERVER__: JSON.stringify(SERVER) };
await build({ ...common, entryPoints: { background: "extension/src/background.ts" }, outdir: OUT, format: "esm", define });
// Scripts that run inside web pages must not leak top-level names: Netflix's
// own minified globals (e.g. \`i\`) silently replaced ours when this was ESM.
await build({
  ...common,
  entryPoints: {
    content: "extension/src/content.ts",
    "netflix-main": "extension/src/netflix-main.ts",
    "hulu-main": "extension/src/hulu-main.ts",
    "fullscreen-main": "extension/src/fullscreen-main.ts",
    "peacock-main": "extension/src/peacock-main.ts",
    "join-bridge": "extension/src/join-bridge.ts",
    popup: "extension/src/popup.ts",
  },
  outdir: OUT,
  format: "iife",
  define,
});
const sites = ["https://www.netflix.com/*", "https://www.hulu.com/*", "https://www.peacocktv.com/*", "https://www.youtube.com/*", "https://m.youtube.com/*"];
const manifest = {
  manifest_version: 3,
  name: "Backrow: watch parties",
  short_name: "Backrow",
  version: pkg.version,
  description: "Free, end-to-end encrypted watch parties for Netflix, Hulu, Peacock and YouTube.",
  icons: { 16: "icons/16.png", 32: "icons/32.png", 48: "icons/48.png", 128: "icons/128.png" },
  action: { default_popup: "popup.html", default_title: "Backrow", default_icon: { 16: "icons/16.png", 32: "icons/32.png" } },
  background: { service_worker: "background.js", type: "module" },
  permissions: ["storage", "tabs"],
  host_permissions: [...sites, `${SERVER}/*`],
  content_scripts: [
    { matches: sites, js: ["content.js"], css: ["page.css"], run_at: "document_start" },
    { matches: ["https://www.netflix.com/*"], js: ["netflix-main.js"], run_at: "document_start", world: "MAIN" },
    { matches: ["https://www.hulu.com/*"], js: ["hulu-main.js"], run_at: "document_start", world: "MAIN" },
    { matches: sites, js: ["fullscreen-main.js"], run_at: "document_start", world: "MAIN" },
    { matches: ["https://www.peacocktv.com/*"], js: ["peacock-main.js"], run_at: "document_start", world: "MAIN" },
    { matches: [`${SERVER}/p/*`], js: ["join-bridge.js"], run_at: "document_start" },
  ],
  minimum_chrome_version: "116",
};
writeFileSync(`${OUT}/manifest.json`, JSON.stringify(manifest, null, 2));
cpSync("extension/popup.html", `${OUT}/popup.html`);
cpSync("extension/popup.css", `${OUT}/popup.css`);
cpSync("extension/page.css", `${OUT}/page.css`);
cpSync("extension/icons", `${OUT}/icons`, { recursive: true });

// Web pages served by the Worker
mkdirSync("worker/public", { recursive: true });
await build({
  ...common,
  entryPoints: { home: "web/src/home.ts", join: "web/src/join.ts", watch: "web/src/watch.ts" },
  outdir: "worker/public",
  format: "esm",
});
for (const f of ["index.html", "join.html", "watch.html", "site.css", "icon.svg", "og.png"]) cpSync(`web/${f}`, `worker/public/${f}`);
writeFileSync("worker/public/_headers", [
  "/*",
  "  X-Content-Type-Options: nosniff",
  "  Referrer-Policy: no-referrer",
  "  Permissions-Policy: camera=(), microphone=(), geolocation=()",
  "  Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:; media-src 'self' blob:; connect-src 'self'; worker-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
  "",
].join("\n"));
// Downloadable extension: a zip whose single folder is what "Load unpacked" wants.
rmSync("dist", { recursive: true, force: true });
mkdirSync("dist", { recursive: true });
cpSync(OUT, "dist/backrow-extension", { recursive: true });
execFileSync("zip", ["-qr", "-X", "backrow-extension.zip", "backrow-extension"], { cwd: "dist" });
cpSync("dist/backrow-extension.zip", "worker/public/backrow-extension.zip");

console.log(`built extension + web for ${SERVER}`);
