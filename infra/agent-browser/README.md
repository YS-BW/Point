# Agent browser you can watch

> Historical experiment. Point now uses Pi Durable for the Agent layer and the published Steel WebRTC image from the domestic Tencent registry. Use the [current browser design](../../docs/design/browser-infrastructure.md) and [image-only Compose](../pi-durable-validation/steel/docker-compose.yml). The old `steel` / `steel-ui` containers below were removed; this experiment's Compose is not the current deployment entry point.

Two containers give you the whole loop, and your agent stays a normal process of yours
(Playwright / Puppeteer / browser-use / MCP) — it is not a container.

```
your agent ──CDP/WS──▶ steel:3000 ──▶ Chromium ──screencast──▶ steel-ui:5173 ◀── you
```

| Piece | Role | Port |
| --- | --- | --- |
| `steel` | Chrome + CDP + session pool + screencast streamer | `3000` API/WS, `9223` raw DevTools |
| `steel-ui` | the viewer SPA | `5173` |

## Run

```bash
cd infra/agent-browser
docker compose up -d          # first run pulls ~5 GB
open http://localhost:5173    # viewer

npm install
npm start                     # creates a session, drives it, prints the viewer URL, releases
```

The script prints `watch live: http://localhost:5173/sessions/<id>`. Open it while it runs:
left pane = the live browser, right pane = `Details / Logs / DevTools`. The picture is
interactive — clicking/typing in it drives the remote browser.

Expected output (verified):

```
session   : 8e03f021-…
watch live: http://localhost:5173/sessions/8e03f021-…
agent opened tab 7FCE6CE8 in the session
agent navigated to: https://juejin.cn/ | 稀土掘金

viewer received 232 frames / 25812.2 KB while the agent worked
```

## The four things that actually matter

### 1. `API_URL` is mandatory on the UI container

The UI image's entrypoint `sed`-substitutes `__API_URL__` in
`/etc/nginx/nginx.conf.template` to render `/etc/nginx/nginx.conf`. With the variable
unset you get `proxy_pass ;` and nginx refuses to boot:
`[emerg] invalid URL prefix in /etc/nginx/nginx.conf:13`.
Don't hand-write an nginx config — just set `API_URL=http://steel:3000` (the template
already proxies both `/api/` and `/ws/`).

### 2. `DOMAIN` is what makes the viewer connectable

Sessions report `websocketUrl` / `sessionViewerUrl` built from `DOMAIN`. Left unset they
come back as `0.0.0.0` and the viewer cannot attach. Set
`DOMAIN=localhost:3000` (or your real host).

### 3. The screencast follows a **pageId**

```
ws://localhost:3000/v1/sessions/cast?sessionId=<id>&pageId=<targetId>
```

Not a video stream: the server calls CDP `Page.startScreencast` (`format: jpeg`,
`quality: 75`, `maxWidth/maxHeight` = session dimensions) and forwards every
`Page.screencastFrame` as a JSON text frame —

```json
{"pageId":"…","url":"https://juejin.cn/","title":"稀土掘金","favicon":"…","data":"<base64 jpeg>"}
```

The player turns `data` into `data:image/jpeg;base64,…`, draws it on a `<canvas>`
(one websocket + one canvas per tab), and immediately acks via
`Page.screencastFrameAck`. Measured at 1280×800: **~14 fps, ~115 KB per message**
(base64; 37–87 KB decoded JPEG), roughly 1.1 MB/s per viewer while the page repaints.
Two traps:

* the path is `/v1/sessions/cast` — a path like `/v1/sessions/<id>/cast` silently
  matches no handler and you get a socket that opens and delivers nothing;
* omit `pageId` and the stream attaches to another tab: measured **1 frame** versus
  **232 frames** once the agent's own tab is pinned. So either drive the tab the viewer
  already shows, or pass that tab's id.

### 4. Egress is not what you think

Docker Desktop injects your macOS system proxy into every container
(`http_proxy=http://host.docker.internal:7897`). That silently couples this stack to
whether your local proxy happens to be running, and it is *not* removed by restarting the
container. The compose file overrides all four proxy variables from `BROWSER_PROXY`:

```bash
# .env
BROWSER_PROXY=                                  # direct egress (default)
BROWSER_PROXY=http://host.docker.internal:7897  # route the browser through a local proxy
```

Verified from inside the container: direct egress reaches domestic sites fine
(`baidu.com`, `sspai.com`, `juejin.cn`, `zhihu.com` all 200 via `/v1/scrape`), while
`ai.meta.com` is unreachable direct and needs the proxy. Set it per environment, don't
rely on inheritance.

## Bandwidth and CPU: the real cost of "watch it live"

`Page.startScreencast` pushes a frame on **every compositor repaint** and Steel does not set
`everyNthFrame`, so there is no frame-rate cap. Measured on the same page (juejin.cn),
one viewer, 10s windows:

| Case | Frames/10s | Bandwidth | Bitrate | Per message |
| --- | --- | --- | --- | --- |
| 1280×800, idle page | 1 | 14 KB/s | 0.12 Mbps | 145 KB |
| 1280×800, scrolling | 112 | 1.4 MB/s | **11.9 Mbps** | 134 KB |
| 1280×800, full-screen animation | 597 | 5.5 MB/s | **46.4 Mbps** | 95 KB |
| 640×400, full-screen animation | 598 | 1.9 MB/s | 16.3 Mbps | 33 KB |

CPU while driving the last case: **~80–90% of one core**, sustained, in the `steel` container
(Chromium + JPEG encoding). Memory stays ~710 MB.

Two consequences:

* **Idle pages are nearly free; animated/video pages are expensive.** 46 Mbps is four 1080p
  video streams, from one viewer.
* **There is no fan-out.** Every websocket client attached to `/v1/sessions/cast` gets its own
  `Page.startScreencast`, so N viewers = N × the numbers above. Ten concurrent viewers on an
  animated page ≈ 460 Mbps egress and ~8.5 cores.

Levers, cheapest first:

1. Only attach the stream when a human actually asks for it; drop it after N seconds idle.
   (Pure product decision, no code change — the biggest win.)
2. `everyNthFrame: 2..5` in `Page.startScreencast` (CDP supports it, Steel does not set it).
   Line-level change, divides bandwidth and CPU by the same factor.
3. Lower `quality` (75 → 40–50) and/or shrink session `dimensions` (maxWidth/maxHeight follow
   the session): 640×400 measured at ~1/3 the bitrate.
4. Send binary frames instead of JSON+base64: measured overhead is **+34%** (21.1 KB JPEG →
   28.3 KB message).
5. Fan out on your side: hold one cast connection and rebroadcast, instead of one per viewer.
   If you need real scale, that is where WebRTC/H.264 pays off (roughly 1–3 Mbps for the same
   picture) — it is also why cloud browser vendors end up there.
6. If "live" is not required, poll `/v1/screenshot` at 1 fps — KB-scale instead of Mbps.

## Sizing (measured on Docker Desktop, arm64)

What is expensive is not Steel — it is Chromium plus the screencast encoder.

| State | CPU | Memory | Notes |
| --- | --- | --- | --- |
| container up, 0 sessions | 0.3% | 491 MB | 395 processes (Chromium tree) |
| 1 session, page loaded, nobody watching | 0.2–1.8% | ~480 MB | background tabs are frozen — nearly free |
| 1 session + 1 viewer, animated page | **80–90% of 1 core** | ~710 MB | 46 Mbps, 60 fps |
| 3 tabs in one container, all streamed | 89% of 1 core | 1.21 GB | 582 processes |

Disk: `steel` image **4.95 GB** (one-time, layers shared across containers), `steel-ui` 96.7 MB,
container writable layer **66 MB after 20+ sessions**, `/tmp/steel-chrome` ~63 MB.
Cold start: API answers `/v1/health` in ~2 s, browser ready a few seconds later.

Rules of thumb:

* per **idle** session page: ~0 CPU (frozen), memory is shared with the browser baseline;
* per **actively rendering + watched** page: ~1 core and ~0.2–0.7 GB on top of baseline;
* per **container** (own Chromium): ~500 MB baseline.

Suggested floors: 2 vCPU / 2 GB / 6 GB disk for a single-agent demo; 4 vCPU / 4 GB for
one agent plus live viewing; for N *independent* agents run N containers
(≈ 0.5 GB × N idle, ≈ 1 core × N when all are watched).

### Three constraints that decide the architecture

1. **The unit of isolation is the container, not the session.** Creating a second session does
   not give you a second browser: session A's listed page turned into session B's URL, and B
   reported 0 pages. One container ≈ one shared page. N independent browsers ⇒ N containers.
2. **Background tabs are throttled.** Three tabs streamed simultaneously gave 1155 / 57 / 6
   frames — only the foreground tab runs at full rate. So one container effectively has one
   smoothly viewable page; agents that only need the DOM are unaffected.
3. **Process count is high** (395 idle → 582 with 3 tabs). Do not set a low `--pids-limit`;
   keep it default/unlimited. Keep `shm_size: 2gb` (Chromium needs it) and note that no GPU
   is required — Steel passes `--disable-gpu` and rasterizes in software.

On macOS, Docker Desktop runs a Linux VM: everything above shares the VM's CPU/RAM budget,
and performance is below a native Linux host.



## Session lifecycle

```js
const session = await fetch("http://localhost:3000/v1/sessions", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ dimensions: { width: 1280, height: 800 }, blockAds: true }),
}).then((r) => r.json());

const browser = await puppeteer.connect({ browserWSEndpoint: session.websocketUrl });
const page = await browser.newPage();          // a tab inside *this* session
await page.goto("https://example.com");

await browser.disconnect();
await fetch(`http://localhost:3000/v1/sessions/${session.id}/release`, { method: "POST" });
```

* One session = one isolated context (cookies, storage, proxy, fingerprint). One session
  per agent/task is the normal shape. For process-level isolation, run one `steel`
  container per agent instead.
* Always release; a forgotten session keeps a browser (and its cost, if self-hosted: RAM)
  alive until timeout.

## Other traps found while building this

* `/v1/search` is broken against today's search-engine DOM — it waits for a hard-coded
  `#results` selector and times out. Use `/v1/scrape` on a search URL instead
  (`bing.com` may 403 you based on container IP; `search.brave.com`, `google.com`,
  `lite.duckduckgo.com` worked).
* Logging is very chatty by default (every CDP request). `LOG_LEVEL=warn` plus
  `ENABLE_CDP_LOGGING=false` keeps it readable.
* Ports `3000` and `9223` have no authentication. Do not expose them beyond localhost
  or a private network.
