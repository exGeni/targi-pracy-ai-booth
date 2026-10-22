# AI photo booth: built during a job fair

**Live demo:** https://exgenius.pro/targi-pracy/orlen/

At the IT job fair at Warsaw University of Technology (Targi Pracy IT PW, 22 October 2026),
ORLEN's stand had an AI photo booth: you take a photo, pick a theme, and AI redraws you in
it. This repository is our copy of that idea. It was built, reviewed and shipped on the day
of the fair, while the fair was going on.

Take a selfie on your phone, pick one of six styles (retro astronaut, superhero, engineer
of the future, F1 driver, Dutch-master oil portrait, 3D animation hero), and about a minute
later you get your portrait to download or share.

## How it works

```
 phone ──photo──▶ api.php (shared PHP hosting) ──job files──▶ ~/targi-jobs (outside web root)
   ▲                    │                                         ▲      │
   └──status / result───┘                         cPanel UAPI     │      ▼
                                              booth-worker/worker.py (private container)
                                                         │
                                                         ▼
                                     codex exec + built-in image generation
```

- **Page** (`site/code/targi-pracy/orlen/index.html`): one static file with no framework.
  The browser shrinks the photo to 1024 px (honouring EXIF rotation) before upload, then
  polls for the result with backoff. The job id goes into the URL, so a reload or a phone
  that went to sleep resumes the wait.
- **API** (`site/code/targi-pracy/orlen/api.php`): about 200 lines of PHP on ordinary
  shared hosting. It re-encodes every photo through GD, so no EXIF and nothing but pixels
  reaches the worker. It admits a job before decoding anything: queue slot, per-address and
  per-day limits. It writes job files atomically outside the web root and deletes
  everything after 24 hours. It holds no secret.
- **Worker** (`site/booth-worker/worker.py`): Python standard library only. It reaches the
  job directory over the hosting's cPanel API, so it needs no inbound port. It renders each
  photo with `codex exec` using Codex's built-in image generation on a ChatGPT
  subscription, and uploads the JPEG back.
- **Deploy** (`site/deploy.sh`): publishes one built subdirectory over cPanel UAPI and
  waits until the host serves the new `api.php` revision. That catches OPcache serving the
  old file.

## Treating the AI step as untrusted

The model sees photos from strangers, so the worker treats every render as hostile input:

- Codex runs in a read-only sandbox. Shell, exec, web search, plugins, hooks and
  multi-agent are switched off.
- Every configured MCP server is disabled by name, and that is verified before each render
  (`codex mcp list`). The check fails closed: if it cannot confirm, there is no render.
  This replaced a `mcp_servers={}` override, which turned out to *merge* into the config
  rather than replace it. The outside Codex review caught that.
- The Codex process gets an allow-listed environment. The hosting keys never reach it.
- Generated images and temp files are deleted after every render, whichever way it ended.
  The whole Codex process group is killed on timeout or shutdown.
- Results are served only once the JPEG end marker is present. Uploads are not atomic.

## How it was built

The build was one Claude Code session working through [gstack](https://github.com/garrytan/gstack)
skills, with a human checking in from the fair floor:

1. **Research** the fair and the original promo, then **probe** the available
   image-generation routes. The free API tier allowed zero image requests, so the build
   switched to Codex on a ChatGPT subscription.
2. **Prototype**. A hidden preview URL was live within the first hour, for the walk back to
   the recruiter.
3. **`/qa`**: browser checks on mobile and desktop, plus the functional API path. It fixed
   a never-ending wait and an error code.
4. **`/ship`**: a pre-landing review with seven parallel specialist reviewers (testing,
   maintainability, security, performance, design, simplification, state machines) and a
   red team, over three rounds. Then an adversarial pass by Claude and a structured review
   by Codex as an outside model. Roughly 70 findings were fixed along the way. They
   included a worker slot leak, re-rendering finished jobs, a visitor-photo cleanup race
   between parallel renders, and the MCP isolation gap above.
5. Tests for every fix: the PHP API runs under `php -S`, and `deploy.sh` and the worker run
   against an in-memory fake cPanel with a fake `codex`.

## Run the tests

```bash
cd site/code
npm test          # node:test; the API tests need php with gd, the worker tests need python3 and ffmpeg
```

## Run it yourself

1. Publish `site/code/targi-pracy/orlen/` to any PHP 8 host where
   `dirname(DOCUMENT_ROOT)/targi-jobs` is writable and not web-served.
2. On a machine signed in to Codex (`codex login`), run the worker with the hosting's cPanel
   credentials in its environment:
   ```bash
   MOCHAHOST_CPANEL_URL=https://host:2083 MOCHAHOST_CPANEL_USER=... MOCHAHOST_CPANEL_API_TOKEN=... \
     python3 -I site/booth-worker/worker.py
   ```
3. Styles live in `styles.json`: a label, an emoji and the scene prompt.

---

Built by [ExGenius](https://exgenius.pro): sites, bots, automation and AI agents.
