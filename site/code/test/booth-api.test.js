// site/code/targi-pracy/orlen/api.php under PHP's built-in server; jobs land in a temp dir.
const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");
const { until } = require("./fake-cpanel");

const php = spawnSync("php", ["-r", 'echo function_exists("imagecreatefromstring") ? "gd" : "";']).stdout?.toString() === "gd";
const skip = !php && "php with gd not installed";
const png = php ? spawnSync("php", ["-r", "imagepng(imagecreatetruecolor(2048, 1024));"]).stdout : null;

async function booth() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "booth-api-"));
  const docroot = path.join(home, "public_html");
  fs.cpSync(path.join(__dirname, "..", "targi-pracy"), path.join(docroot, "targi-pracy"), { recursive: true });
  const port = 20000 + Math.floor(Math.random() * 20000);
  // Upload limits above MAX_BYTES, so api.php itself decides on large photos.
  const srv = spawn("php", ["-d", "upload_max_filesize=32M", "-d", "post_max_size=32M", "-S", `127.0.0.1:${port}`, "-t", docroot], { stdio: "ignore" });
  assert.ok(await until(() => spawnSync("php", ["-r", `exit(@fsockopen("127.0.0.1", ${port}) ? 0 : 1);`]).status === 0, 5000));
  const base = `http://127.0.0.1:${port}/targi-pracy/orlen/api.php`;
  const jobs = path.join(home, "targi-jobs");
  fs.mkdirSync(jobs);
  fs.writeFileSync(path.join(jobs, ".alive"), "1"); // the worker's heartbeat
  const submit = (style, body = png) => {
    const fd = new FormData();
    fd.append("style", style);
    fd.append("photo", new Blob([body]), "p.png");
    return fetch(base + "?a=submit", { method: "POST", body: fd });
  };
  const status = async (id) => (await fetch(`${base}?a=status&id=${id}`)).json();
  return { base, jobs, submit, status, close: () => srv.kill() };
}

test("api.php: submit, queue, claim, result and the per-IP limit", { skip }, async () => {
  const b = await booth();
  try {
    assert.equal((await b.submit("nope")).status, 400);
    assert.equal((await b.submit("racer", Buffer.from("not an image"))).status, 400);
    assert.equal((await b.submit("racer", Buffer.alloc(13 * 1024 * 1024))).status, 400, "over 12 MB");
    const noPhoto = new FormData();
    noPhoto.append("style", "racer");
    assert.equal((await fetch(b.base + "?a=submit", { method: "POST", body: noPhoto })).status, 400, "no photo");
    // A tiny PNG whose header claims 20000×20000 px is refused before GD decodes it.
    const bomb = Buffer.from(png);
    bomb.writeUInt32BE(20000, 16);
    bomb.writeUInt32BE(20000, 20);
    assert.equal((await b.submit("racer", bomb)).status, 400, "declared size over the pixel cap");

    const r = await b.submit("racer");
    assert.equal(r.status, 200);
    const { id } = await r.json();
    assert.match(id, /^[a-f0-9]{16}$/);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(b.jobs, id + ".meta.json"))).style, "racer");
    const jpeg = Buffer.from(fs.readFileSync(path.join(b.jobs, id + ".in.b64"), "utf8"), "base64");
    const size = spawnSync("php", ["-r", "echo json_encode(getimagesizefromstring(stream_get_contents(STDIN)));"], { input: jpeg }).stdout;
    const { 0: w, 1: h, 2: type } = JSON.parse(size);
    assert.deepEqual([w, h, type], [1024, 512, 2], "re-encoded to a JPEG with the long side at 1024");

    assert.deepEqual(await b.status(id), { state: "queued", ahead: 0 });
    fs.writeFileSync(path.join(b.jobs, id + ".work"), "1");
    assert.deepEqual(await b.status(id), { state: "working" });
    fs.writeFileSync(path.join(b.jobs, id + ".out.jpg"), jpeg.subarray(0, jpeg.length - 10));
    assert.deepEqual(await b.status(id), { state: "working" }, "a half-uploaded result is not done");
    assert.equal((await fetch(`${b.base}?a=img&id=${id}`)).status, 404);
    fs.writeFileSync(path.join(b.jobs, id + ".out.jpg"), jpeg);
    assert.deepEqual(await b.status(id), { state: "done", img: `api.php?a=img&id=${id}` });
    const img = await fetch(`${b.base}?a=img&id=${id}&dl=1`);
    assert.equal(img.headers.get("content-type"), "image/jpeg");
    assert.match(img.headers.get("content-disposition"), /attachment/);
    assert.ok(Buffer.from(await img.arrayBuffer()).equals(jpeg));
    assert.equal((await fetch(`${b.base}?a=img&id=0123456789abcdef`)).status, 404);

    const probe = await (await fetch(`${b.base}?a=status&id=0000000000000000`)).json();
    const md5 = require("node:crypto").createHash("md5").update(fs.readFileSync(path.join(__dirname, "..", "targi-pracy", "orlen", "api.php"))).digest("hex");
    assert.deepEqual(probe, { state: "gone", rev: md5.slice(0, 12) }, "deploy.sh's revision probe");
    const gone = await fetch(`${b.base}?a=status&id=0123456789abcdef`);
    assert.equal(gone.status, 200);
    assert.deepEqual(await gone.json(), { state: "gone" });
    assert.equal((await fetch(`${b.base}?a=status&id=../etc`)).status, 400);
    assert.equal((await fetch(`${b.base}?a=nope`)).status, 404);

    // Sixty photos per address per hour: with 59 on record the next is taken, the one after refused.
    const drain = () => { for (const f of fs.readdirSync(b.jobs)) if (f.endsWith(".in.b64")) fs.unlinkSync(path.join(b.jobs, f)); };
    const stats = path.join(b.jobs, ".stats.json");
    const day = new Date().toISOString().slice(0, 10);
    const key = require("node:crypto").createHash("sha256").update(day + "127.0.0.1").digest("hex").slice(0, 16);
    fs.writeFileSync(stats, JSON.stringify({ day, count: 59, ip: { [key]: Array(59).fill(Math.floor(Date.now() / 1000)) } }));
    drain();
    assert.equal((await b.submit("oil")).status, 200);
    drain();
    const capped = await b.submit("oil");
    assert.equal(capped.status, 429);
    assert.deepEqual(await capped.json(), { error: "ip_cap" });
  } finally {
    b.close();
  }
});

test("api.php: queue position, error state, 24 h purge, queue and day caps", { skip }, async () => {
  const b = await booth();
  try {
    const old = Date.now() / 1000 - 100;
    const seed = (id, ext, t = old) => { const p = path.join(b.jobs, `${id}.${ext}`); fs.writeFileSync(p, "x"); fs.utimesSync(p, t, t); };
    seed("aaaaaaaaaaaaaaaa", "in.b64");             // queued earlier
    seed("bbbbbbbbbbbbbbbb", "in.b64"); seed("bbbbbbbbbbbbbbbb", "work"); // claimed: not ahead of anyone
    seed("cccccccccccccccc", "err");
    const day = Date.now() / 1000 - 90000; // older than 24 h
    seed("dddddddddddddddd", "out.jpg", day);
    seed("ffffffffffffffff", "in.b64", day); seed("ffffffffffffffff", "meta.json", day);
    seed("ffffffffffffffff", "work", Date.now() / 1000 - 60); // a live claim is younger than the TTL
    seed("9999999999999999", "in.b64", Date.now() / 1000 - 700); // never claimed, older than QUEUE_EXPIRY

    const { id } = await (await b.submit("pixar")).json();
    assert.deepEqual(await b.status(id), { state: "queued", ahead: 1 });
    assert.deepEqual(await b.status("cccccccccccccccc"), { state: "error" });
    assert.ok(!fs.existsSync(path.join(b.jobs, "dddddddddddddddd.out.jpg")), "results older than 24 h are deleted");
    assert.ok(!fs.existsSync(path.join(b.jobs, "ffffffffffffffff.in.b64")) && !fs.existsSync(path.join(b.jobs, "ffffffffffffffff.meta.json")), "old photos too");
    assert.ok(fs.existsSync(path.join(b.jobs, "ffffffffffffffff.work")), "younger files stay");
    assert.deepEqual(await b.status("9999999999999999"), { state: "error" }, "a photo the worker never took is closed");
    assert.ok(!fs.existsSync(path.join(b.jobs, "9999999999999999.in.b64")));

    // Six photos waiting, claimed or not (aaaa, bbbb, the one above and three more): the next is refused.
    for (let i = 0; i < 3; i++) seed(`e${String(i).padStart(15, "0")}`, "in.b64");
    const busy = await b.submit("pixar");
    assert.equal(busy.status, 503);
    assert.deepEqual(await busy.json(), { error: "busy" });

    for (const f of fs.readdirSync(b.jobs)) if (f.endsWith(".in.b64")) fs.unlinkSync(path.join(b.jobs, f));
    const stats = path.join(b.jobs, ".stats.json");
    fs.writeFileSync(stats, JSON.stringify({ ...JSON.parse(fs.readFileSync(stats)), count: 200 }));
    fs.utimesSync(path.join(b.jobs, ".alive"), new Date(), new Date());
    const capped = await b.submit("pixar");
    assert.equal(capped.status, 429);
    assert.deepEqual(await capped.json(), { error: "day_cap" });
  } finally {
    b.close();
  }
});

test("every error code api.php can return has a message on the page", () => {
  const api = fs.readFileSync(path.join(__dirname, "..", "targi-pracy", "orlen", "api.php"), "utf8");
  const page = fs.readFileSync(path.join(__dirname, "..", "targi-pracy", "orlen", "index.html"), "utf8");
  const shown = new Set([...page.matchAll(/^\s{4}(\w+): "/gm)].map((m) => m[1]));
  assert.ok(shown.size >= 5, "the page's ERR map was found");
  // bad_style, bad_id and unknown_action cannot come from the page's own requests.
  const visitorFacing = [...api.matchAll(/'(?:error|state)' => '(\w+)'/g)].map((m) => m[1])
    .filter((c) => !["bad_style", "bad_id", "unknown_action", "done", "queued", "working"].includes(c));
  assert.ok(visitorFacing.length >= 5, "api.php codes were found");
  for (const code of visitorFacing) assert.ok(shown.has(code), `no message for ${code}`);
});

test("api.php refuses new photos while the worker is silent", { skip }, async () => {
  const b = await booth();
  try {
    const old = new Date(Date.now() - 120000);
    fs.utimesSync(path.join(b.jobs, ".alive"), old, old);
    const r = await b.submit("racer");
    assert.equal(r.status, 503);
    assert.deepEqual(await r.json(), { error: "offline" });
  } finally {
    b.close();
  }
});
