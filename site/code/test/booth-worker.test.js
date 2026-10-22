// site/deploy.sh and site/booth-worker/worker.py against a fake cPanel (test/fake-cpanel.js).
const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");
const { fakeCpanel, copySite, run, until } = require("./fake-cpanel");

test("deploy.sh publishes only the named subdirectory into public_html", async () => {
  const cp = await fakeCpanel();
  const root = copySite();
  const r = await run("bash", [path.join(root, "site/deploy.sh"), "targi-pracy/orlen", "targi-pracy/orlen-preview"], { env: { ...process.env, ...cp.env } });
  cp.server.close();
  assert.equal(r.code, 0, r.out);
  assert.deepEqual([...cp.dirs], ["public_html/targi-pracy", "public_html/targi-pracy/orlen-preview"]);
  assert.deepEqual([...cp.files.keys()].sort(), ["api.php", "index.html", "styles.json"].map((f) => "public_html/targi-pracy/orlen-preview/" + f));
  assert.equal(cp.uploads.at(-1), "api.php", "api.php goes last");
  const src = fs.readFileSync(path.join(root, "site/code/targi-pracy/orlen/api.php"));
  assert.ok(cp.files.get("public_html/targi-pracy/orlen-preview/api.php").body.equals(src));
});

test("deploy.sh fails while the host still serves the previous api.php", async () => {
  const cp = await fakeCpanel();
  cp.state.staleApi = true;
  const root = copySite();
  const r = await run("bash", [path.join(root, "site/deploy.sh"), "targi-pracy/orlen"], { env: { ...process.env, ...cp.env, SMOKE_TRIES: "2" } });
  cp.server.close();
  assert.notEqual(r.code, 0);
  assert.match(r.out, /does not serve revision/);
});

test("deploy.sh fails loudly on a refused upload or a missing argument", async () => {
  const cp = await fakeCpanel();
  cp.state.failUploads = true;
  const root = copySite();
  const env = { ...process.env, ...cp.env };
  const refused = await run("bash", [path.join(root, "site/deploy.sh"), "targi-pracy/orlen"], { env });
  const bare = await run("bash", [path.join(root, "site/deploy.sh")], { env });
  cp.server.close();
  assert.notEqual(refused.code, 0);
  assert.match(refused.out, /upload failed/);
  assert.notEqual(bare.code, 0);
  assert.match(bare.out, /usage/);
});

const tools = ["python3", "ffmpeg"].every((t) => spawnSync(t, ["-version"]).error === undefined);
const photo = tools ? spawnSync("ffmpeg", ["-loglevel", "error", "-f", "lavfi", "-i", "color=c=red:s=64x64", "-frames:v", "1", "-f", "mjpeg", "-"]).stdout : null;

// Starts worker.py with a fake codex on PATH. The fake records each argv and leaves the
// attached photo as the "generated" image. Two test-only styles drive its failure modes:
// "failtest" exits without starting a thread, "noimage" starts one but writes no PNG,
// "badthread" reports a path-like thread id.
async function worker(seed, before = () => {}) {
  const cp = await fakeCpanel();
  const root = copySite();
  const stylesPath = path.join(root, "site/code/targi-pracy/orlen/styles.json");
  const styles = JSON.parse(fs.readFileSync(stylesPath, "utf8"));
  styles.failtest = { label: "t", emoji: "t", prompt: "FAIL_ME" };
  styles.noimage = { label: "t", emoji: "t", prompt: "NO_IMAGE" };
  styles.badthread = { label: "t", emoji: "t", prompt: "BAD_THREAD" };
  fs.writeFileSync(stylesPath, JSON.stringify(styles));
  const home = fs.mkdtempSync(path.join(root, "home-"));
  // Images that are not this worker's: the owner's own Codex output and a sibling of the dir.
  fs.mkdirSync(path.join(home, ".codex/generated_images/owner-image"), { recursive: true });
  fs.mkdirSync(path.join(home, ".codex/outside"), { recursive: true });
  const bin = fs.mkdtempSync(path.join(root, "bin-"));
  fs.writeFileSync(path.join(bin, "codex"), `#!/usr/bin/env node
const fs = require("fs"), path = require("path");
const a = process.argv.slice(2);
// \`codex mcp list --json\`: one configured server, disabled only by its own override.
if (a[0] === "mcp") { console.log(JSON.stringify([{ name: "gbrain", enabled: !a.includes("mcp_servers.gbrain.enabled=false") }])); process.exit(0); }
fs.appendFileSync(path.join(process.env.HOME, "argv.jsonl"), JSON.stringify({ argv: a, env: Object.keys(process.env) }) + "\\n");
if (a.some((x) => x.includes("FAIL_ME"))) process.exit(1);
if (a.some((x) => x.includes("BAD_THREAD"))) { console.log(JSON.stringify({ type: "thread.started", thread_id: "../outside" })); process.exit(0); }
const thread = "thread-" + Date.now() + "-" + Math.floor(Math.random() * 1e6);
const dir = path.join(process.env.HOME, ".codex/generated_images", thread);
fs.mkdirSync(dir, { recursive: true });
if (a.some((x) => x.includes("NO_IMAGE"))) fs.writeFileSync(path.join(dir, "partial.webp"), "x");
else fs.copyFileSync(a[a.indexOf("-i") + 1], path.join(dir, "exec-1.png"));
console.log(JSON.stringify({ type: "thread.started", thread_id: thread }));
`, { mode: 0o755 });
  seed(cp.files);
  before(cp.state);
  const w = spawn("python3", ["-I", path.join(root, "site/booth-worker/worker.py")], {
    env: { ...process.env, ...cp.env, HOME: home, TMPDIR: root, PATH: bin + path.delimiter + process.env.PATH, BOOTH_TEST_SECRET: "x" }, stdio: "ignore",
  });
  const runs = () => fs.existsSync(path.join(home, "argv.jsonl"))
    ? fs.readFileSync(path.join(home, "argv.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l)) : [];
  const images = () => fs.readdirSync(path.join(home, ".codex/generated_images")).filter((d) => d !== "owner-image");
  return { cp, root, home, runs, images, stop: () => { w.kill(); cp.server.close(); } };
}

function job(files, id, style, mtime = Math.floor(Date.now() / 1000)) {
  files.set(`targi-jobs/${id}.meta.json`, { body: Buffer.from(JSON.stringify({ style })), mtime });
  files.set(`targi-jobs/${id}.in.b64`, { body: Buffer.from(photo.toString("base64")), mtime });
}

const finished = (files, id) => !files.has(`targi-jobs/${id}.in.b64`) && !files.has(`targi-jobs/${id}.work`)
  && (files.has(`targi-jobs/${id}.out.jpg`) || files.has(`targi-jobs/${id}.err`));
const skipW = !tools && "python3 or ffmpeg missing";

test("worker renders a queued job, uploads the result and deletes the photo", { skip: skipW }, async () => {
  const w = await worker((files) => job(files, "abc", "racer"));
  const done = await until(() => finished(w.cp.files, "abc"), 20000);
  w.stop();
  const files = w.cp.files;
  assert.ok(done, "job finished: " + [...files.keys()].join(", "));
  assert.ok(!files.has("targi-jobs/abc.err"));
  assert.equal(files.get("targi-jobs/abc.out.jpg").body.subarray(0, 2).toString("hex"), "ffd8", "uploads a JPEG");
  const [{ argv, env }] = w.runs();
  const styles = JSON.parse(fs.readFileSync(path.join(w.root, "site/code/targi-pracy/orlen/styles.json"), "utf8"));
  assert.ok(argv.some((a) => a.includes(styles.racer.prompt)), "prompt carries the chosen style");
  const off = ["shell_tool", "unified_exec", "view_image", "multi_agent", "browser_use", "computer_use", "tool_suggest", "hooks", "plugins", "apps", "goals", "skill_search"];
  for (const flag of off) assert.equal(argv[argv.indexOf(flag) - 1], "--disable", "codex runs with --disable " + flag);
  assert.equal(argv[argv.indexOf("-s") + 1], "read-only");
  for (const a of ["--ephemeral", "mcp_servers.gbrain.enabled=false", "web_search=disabled"]) assert.ok(argv.includes(a), a);
  assert.ok(!env.some((k) => k.startsWith("MOCHAHOST_") || k === "BOOTH_TEST_SECRET"), "codex gets only allow-listed variables");
  assert.ok(files.has("targi-jobs/.alive"), "heartbeat written");
  assert.deepEqual(w.images(), [], "generated image removed locally");
});

test("worker marks failed renders as errors, cleans up and keeps serving", { skip: skipW }, async () => {
  const t = Math.floor(Date.now() / 1000);
  const w = await worker((files) => {
    job(files, "bad", "failtest", t - 30); job(files, "noimg", "noimage", t - 20); job(files, "badth", "badthread", t - 10); job(files, "good", "racer", t);
  });
  const done = await until(() => ["bad", "noimg", "badth", "good"].every((id) => finished(w.cp.files, id)), 40000);
  w.stop();
  const files = w.cp.files;
  assert.ok(done, "all jobs finished: " + [...files.keys()].join(", "));
  for (const id of ["bad", "noimg", "badth"]) assert.ok(files.has(`targi-jobs/${id}.err`) && !files.has(`targi-jobs/${id}.out.jpg`), id);
  assert.ok(files.has("targi-jobs/good.out.jpg") && !files.has("targi-jobs/good.err"));
  assert.deepEqual(w.images(), [], "a turn that made no image leaves nothing behind");
  assert.ok(fs.existsSync(path.join(w.home, ".codex/generated_images/owner-image")), "other images untouched");
  assert.ok(fs.existsSync(path.join(w.home, ".codex/outside")), "a path-like thread id touches nothing");
});

test("worker re-queues the claims a dead run left, half-written results included", { skip: skipW }, async () => {
  const t = Math.floor(Date.now() / 1000);
  const w = await worker((files) => {
    job(files, "old", "racer", t - 100);
    files.set("targi-jobs/old.work", { body: Buffer.from("1"), mtime: t - 500 });
    job(files, "recent", "racer", t - 100);
    files.set("targi-jobs/recent.work", { body: Buffer.from("1"), mtime: t - 60 }); // one worker per machine: also dead
    files.set("targi-jobs/recent.out.jpg", { body: photo.subarray(0, 10), mtime: t - 50 }); // cut off mid-upload
  });
  const done = await until(() => finished(w.cp.files, "old") && finished(w.cp.files, "recent"), 25000);
  w.stop();
  assert.ok(done, "both re-rendered: " + [...w.cp.files.keys()].join(", "));
  assert.ok(w.cp.files.get("targi-jobs/recent.out.jpg").body.length > 10, "the truncated result was replaced");
  assert.equal(w.runs().length, 2);
});

test("worker finishes cleanup instead of rendering a finished job again", { skip: skipW }, async () => {
  const t = Math.floor(Date.now() / 1000);
  const w = await worker((files) => {
    job(files, "doneOld", "racer", t - 30);
    files.set("targi-jobs/doneOld.out.jpg", { body: photo, mtime: t - 20 });
    job(files, "errOld", "racer", t - 30);
    files.set("targi-jobs/errOld.err", { body: Buffer.from("1"), mtime: t - 20 });
    files.set("targi-jobs/errOld.work", { body: Buffer.from("1"), mtime: t - 500 });
  });
  const done = await until(() => finished(w.cp.files, "doneOld") && finished(w.cp.files, "errOld"), 15000);
  w.stop();
  assert.ok(done, "leftovers removed: " + [...w.cp.files.keys()].join(", "));
  assert.equal(w.runs().length, 0, "no render");
});

test("worker drops photos the visitor stopped waiting for", { skip: skipW }, async () => {
  const t = Math.floor(Date.now() / 1000);
  const w = await worker((files) => {
    job(files, "late", "racer", t - 700);
    job(files, "lateClaim", "racer", t - 700); // a dead worker's claim on a photo that is too old now
    files.set("targi-jobs/lateClaim.work", { body: Buffer.from("1"), mtime: t - 500 });
    files.set("targi-jobs/ancient.out.jpg", { body: photo, mtime: t - 90000 }); // older than the 24 h TTL
  });
  const done = await until(() => finished(w.cp.files, "late") && finished(w.cp.files, "lateClaim"), 15000);
  w.stop();
  assert.ok(done, "expired jobs closed: " + [...w.cp.files.keys()].join(", "));
  assert.ok(w.cp.files.has("targi-jobs/late.err") && w.cp.files.has("targi-jobs/lateClaim.err"));
  assert.ok(!w.cp.files.has("targi-jobs/ancient.out.jpg"), "the worker keeps the 24 h promise without visitor traffic");
  assert.equal(w.runs().length, 0, "no render");
});

test("worker survives a failed claim upload and a failed photo delete", { skip: skipW }, async () => {
  const w = await worker((files) => job(files, "flaky", "racer"), (state) => { state.failUploadsNext = 2; state.failUnlinksNext = 1; }); // heartbeat + claim, then the photo delete
  const done = await until(() => finished(w.cp.files, "flaky"), 30000);
  w.stop();
  assert.ok(done, "job finished after transient failures: " + [...w.cp.files.keys()].join(", "));
  assert.ok(w.cp.files.has("targi-jobs/flaky.out.jpg"));
  assert.equal(w.runs().length, 1, "rendered once");
});
