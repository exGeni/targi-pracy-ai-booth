// Stage the static site into dist/: every file under this directory except the build
// tooling itself. The site chain has no bundler; dist/ is what a deploy publishes.
const fs = require("fs");
const path = require("path");
const root = __dirname;
const out = path.join(root, "dist");
const skip = new Set(["dist", "node_modules", "test", "build.js", "package.json", "package-lock.json"]);
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out);
for (const name of fs.readdirSync(root)) {
  if (skip.has(name) || name.startsWith(".")) continue;
  fs.cpSync(path.join(root, name), path.join(out, name), { recursive: true });
}
if (!fs.existsSync(path.join(out, "index.html"))) {
  console.error("build: no index.html in " + root);
  process.exit(1);
}
console.log("build: staged " + fs.readdirSync(out).length + " entries into dist/");
