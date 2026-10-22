const { test } = require("node:test");
const assert = require("node:assert");
const { execFileSync, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const root = path.join(__dirname, "..");
const booth = path.join(root, "targi-pracy", "orlen");

// Builds a private copy: test files run in parallel and build.test.js rebuilds the shared dist/.
test("build publishes the photo booth page, its API and its styles", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "booth-build-"));
  fs.cpSync(root, tmp, { recursive: true, filter: (p) => !/[\\/](dist|node_modules)$/.test(p) });
  execFileSync(process.execPath, [path.join(tmp, "build.js")], { stdio: "pipe" });
  for (const f of ["index.html", "api.php", "styles.json"]) {
    assert.ok(fs.existsSync(path.join(tmp, "dist", "targi-pracy", "orlen", f)), f + " must be published");
  }
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("every booth style has a label, an emoji and a prompt", () => {
  const styles = JSON.parse(fs.readFileSync(path.join(booth, "styles.json"), "utf8"));
  assert.ok(Object.keys(styles).length > 0);
  for (const [key, s] of Object.entries(styles)) {
    assert.match(key, /^[a-z]+$/);
    for (const field of ["label", "emoji", "prompt"]) assert.ok(s[field], `${key}.${field}`);
  }
});

const php = spawnSync("php", ["-v"]).status === 0;
test("api.php parses", { skip: !php && "php not installed" }, () => {
  execFileSync("php", ["-l", path.join(booth, "api.php")], { stdio: "pipe" });
});
