// In-memory stand-in for the cPanel endpoints the booth worker and deploy.sh call:
// UAPI Fileman list_files / get_file_content / upload_files and API2 Fileman mkdir / fileop.
const http = require("node:http");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

const USER = "booth";
const TOKEN = "test-token";

function fakeCpanel() {
  const files = new Map(); // "dir/name" -> { body: Buffer, mtime }
  const dirs = new Set();
  const uploads = []; // upload order, as deploy.sh sends files
  // failUploads: refuse every upload; failUploadsNext / failUnlinksNext: refuse the next N.
  const state = { failUploads: false, failUploadsNext: 0, failUnlinksNext: 0, staleApi: false };
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://x");
    const q = url.searchParams;
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const json = (body) => { res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify(body)); };
      // The published api.php, as deploy.sh's smoke check sees it: its revision is the md5
      // prefix of the uploaded file, or none when state.staleApi plays a cached old file.
      if (url.pathname.endsWith("/api.php")) {
        const up = files.get("public_html" + url.pathname);
        const rev = up && !state.staleApi ? require("node:crypto").createHash("md5").update(up.body).digest("hex").slice(0, 12) : undefined;
        return json({ state: "gone", rev });
      }
      if (req.headers.authorization !== `cpanel ${USER}:${TOKEN}`) { res.statusCode = 401; return res.end(); }
      if (url.pathname === "/execute/Fileman/list_files") {
        const dir = q.get("dir") + "/";
        if (!dirs.has(q.get("dir")) && ![...files.keys()].some((k) => k.startsWith(dir))) return json({ status: 0, errors: ["no such directory"] });
        const data = [...files].filter(([k]) => k.startsWith(dir) && !k.slice(dir.length).includes("/"))
          .map(([k, f]) => ({ file: k.slice(dir.length), type: "file", mtime: f.mtime, size: f.body.length }));
        return json({ status: 1, data });
      }
      if (url.pathname === "/execute/Fileman/get_file_content") {
        const f = files.get(q.get("dir") + "/" + q.get("file"));
        return f ? json({ status: 1, data: { content: f.body.toString() } }) : json({ status: 0, errors: ["missing"] });
      }
      if (url.pathname === "/execute/Fileman/upload_files") {
        if (state.failUploadsNext > 0) { state.failUploadsNext--; return json({ status: 1, data: { succeeded: 0, failed: 1 } }); }
        if (state.failUploads) return json({ status: 1, data: { succeeded: 0, failed: 1 } });
        const body = Buffer.concat(chunks);
        const boundary = "--" + /boundary=(.+)$/.exec(req.headers["content-type"])[1];
        const parts = {};
        let name = null;
        for (const raw of body.toString("latin1").split(boundary).slice(1, -1)) {
          const [head, ...rest] = raw.split("\r\n\r\n");
          const field = /name="([^"]+)"/.exec(head)[1];
          const value = Buffer.from(rest.join("\r\n\r\n").slice(0, -2), "latin1");
          const fn = /filename="([^"]+)"/.exec(head);
          if (fn) { name = path.basename(fn[1]); parts.file = value; } else parts[field] = value.toString();
        }
        uploads.push(name);
        files.set(parts.dir + "/" + name, { body: parts.file, mtime: Math.floor(Date.now() / 1000) });
        return json({ status: 1, data: { succeeded: 1, failed: 0 } });
      }
      if (url.pathname === "/json-api/cpanel" && q.get("cpanel_jsonapi_func") === "mkdir") {
        dirs.add(q.get("path") + "/" + q.get("name"));
        return json({ cpanelresult: { event: { result: 1 } } });
      }
      if (url.pathname === "/json-api/cpanel" && q.get("cpanel_jsonapi_func") === "fileop") {
        // Like cPanel: HTTP 200 either way, the per-file result says whether it happened.
        const gone = state.failUnlinksNext > 0 ? (state.failUnlinksNext--, false) : files.delete(q.get("sourcefiles"));
        return json({ cpanelresult: { event: { result: 1 }, data: [{ result: gone ? 1 : 0 }] } });
      }
      res.statusCode = 404; res.end();
    });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({
    files, dirs, uploads, server, state,
    env: {
      MOCHAHOST_CPANEL_URL: `http://127.0.0.1:${server.address().port}/`, MOCHAHOST_CPANEL_USER: USER, MOCHAHOST_CPANEL_API_TOKEN: TOKEN,
      SITE_URL: `http://127.0.0.1:${server.address().port}`,
    },
  })));
}

// A private copy of site/ at <tmp>/site (code without dist/node_modules), so paths stay
// repo-relative and parallel test files never share dist/.
function copySite() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "booth-site-"));
  fs.cpSync(path.join(__dirname, "..", ".."), path.join(tmp, "site"), { recursive: true, filter: (p) => !/[\\/](dist|node_modules|__pycache__)$/.test(p) });
  return tmp;
}

function run(cmd, args, opts) {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { ...opts, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (out += d));
    p.on("close", (code) => resolve({ code, out }));
  });
}

const until = async (cond, ms) => {
  for (const t0 = Date.now(); Date.now() - t0 < ms; await new Promise((r) => setTimeout(r, 100))) if (cond()) return true;
  return false;
};

module.exports = { fakeCpanel, copySite, run, until };
