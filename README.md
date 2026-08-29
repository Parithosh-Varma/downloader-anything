# downloader-anything

Simple **video / post / music** downloader using **yt-dlp**, with frontend on **Cloudflare Pages** and backend on **Cloudflare Workers**.

- Frontend: static `frontend/` → Cloudflare Pages
- Backend: `src/index.ts` (Hono on Workers) → Cloudflare Workers
  - Standalone: YouTube works via Innertube (no external server)
  - Proxied (full): 1800+ sites via `server/` (real yt-dlp + ffmpeg) — deploy once, Worker proxies to it
- Alternative: `worker-python/` → 100% Cloudflare Python Worker with `yt-dlp` pip package (Pyodide, metadata only, no ffmpeg)
- Full server: `server/` → FastAPI + yt-dlp + ffmpeg (Docker, deploy to Fly/Render/Cloudflare Containers)

---

## Architecture

```
[ User ] -> Cloudflare Pages (frontend/index.html)
              |
              v
        Cloudflare Worker (src/index.ts, Hono)
          /                 \
   Innertube (YT)      YT_DLP_API_URL -> server/main.py (FastAPI + yt-dlp + ffmpeg)
        |                      |
        v                      v
   direct cdn URL -> /api/download proxy -> streaming download with Content-Disposition
```

**Why hybrid?** Workers can't run `ffmpeg` or spawn `yt-dlp` subprocess. So:
- Worker handles CORS, rate-limiting, proxy streaming, and YouTube Innertube extraction (works 100% on edge).
- For TikTok/Instagram/Twitter/etc and best merged quality, Worker forwards to `server/` which runs real yt-dlp.

If you only need YouTube, you don't need `server/` at all.

---

## Quick Start (local)

```bash
# 1. Install
npm install

# 2. Dev Worker (Hono + Innertube)
npx wrangler dev

# 3. In another terminal, serve frontend
npx serve frontend
# or: npx wrangler pages dev frontend

# 4. (Optional) Run yt-dlp server for full site support
cd server
pip install -r requirements.txt
uvicorn main:app --reload --port 8000
# then set in wrangler.toml:
# YT_DLP_API_URL = "http://localhost:8000"
```

Test:

```bash
curl -X POST http://localhost:8787/api/info \
  -H "Content-Type: application/json" \
  -d '{"url":"https://www.youtube.com/watch?v=jNQXAC9IVRw"}'
```

---

## Deploy

### A. Worker (backend) — Cloudflare Workers

You already have `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` in `~/Downloads/CODING/global-env.env`.

```bash
source ~/Downloads/CODING/global-env.env
# or: source ~/bin/load-env.zsh

# Deploy Worker
npx wrangler deploy
# -> https://downloader-anything.<subdomain>.workers.dev

# Check health
curl https://downloader-anything.<subdomain>.workers.dev/api/health
```

Set the yt-dlp server URL later:

```bash
# In wrangler.toml set:
# YT_DLP_API_URL = "https://your-yt-dlp-server.fly.dev"
npx wrangler deploy
# Or via dashboard: Workers -> Settings -> Variables
```

### B. Frontend — Cloudflare Pages

```bash
# Deploy static frontend
npx wrangler pages deploy frontend --project-name=downloader-anything

# Or connect GitHub repo in Cloudflare dashboard:
# Pages -> Create project -> Connect Git -> Build: none, Output: frontend
```

After deploy, open your Pages URL and set the **Worker URL** in the input at top (persisted in localStorage), e.g. `https://downloader-anything.<subdomain>.workers.dev`, then click **Test** and **Fetch**.

> You can also serve frontend *from the Worker* via `[assets]` in `wrangler.toml` — uncomment it to make Worker serve `frontend/` directly, single deployment.

### C. yt-dlp Server (full 1800+ sites) — pick one

#### Option 1: Fly.io (recommended, free tier, ffmpeg included)

```bash
cd server
fly launch --dockerfile Dockerfile --name downloader-anything-yt-dlp --region sin
fly deploy
fly open
# set as YT_DLP_API_URL in Worker, redeploy Worker
```

#### Option 2: Render

```bash
# Push to GitHub, then in Render dashboard:
# New -> Web Service -> Connect repo -> Docker -> Dockerfile: server/Dockerfile
# Health check: /health
```

#### Option 3: Cloudflare Containers (beta)

```bash
# Create Container with server/Dockerfile, expose port 8000
# Set YT_DLP_API_URL to container URL
```

#### Option 4: Local Docker

```bash
cd server
docker build -t downloader-yt-dlp .
docker run -p 8000:8000 downloader-yt-dlp
```

### D. Python Worker alternative (100% Cloudflare, no external server)

If you want yt-dlp *directly* on Workers without a separate server (Pyodide, works for metadata, no ffmpeg merging):

```bash
cd worker-python
# needs uv: https://docs.astral.sh/uv/
uvx --from workers-py pywrangler dev   # local
uvx --from workers-py pywrangler deploy
```

Frontend can point to this Worker's URL instead of the JS Worker. Tradeoff: slower cold start, limited binary deps, but no Docker.

---

## API

### `POST /api/info`

```json
// Request
{ "url": "https://www.youtube.com/watch?v=..." }

// Response
{
  "id": "...",
  "title": "...",
  "thumbnail": "https://...",
  "duration": 123,
  "uploader": "...",
  "extractor": "youtube",
  "webpage_url": "https://...",
  "formats": [
    {
      "format_id": "22",
      "ext": "mp4",
      "resolution": "1280x720",
      "height": 720,
      "vcodec": "avc1",
      "acodec": "aac",
      "filesize": 12345678,
      "url": "https://...",
      "has_video": true,
      "has_audio": true
    }
  ]
}
```

### `GET /api/download?direct_url=&filename=&url=&format_id=&audio_only=`

Proxies the direct cdn URL with `Content-Disposition: attachment` and streams it. Supports `Range` for resume.

- If `direct_url` is given, proxies it directly.
- If `url` + `format_id` is given and `YT_DLP_API_URL` is configured, resolves via yt-dlp server first.
- `filename` controls download name.

### `GET /api/proxy?url=&filename=`

Generic proxy (same as download).

### `GET /api/health`

---

## Frontend usage

1. Paste URL → **Fetch** → see title/thumb/formats.
2. Tabs: **Combined** (single file, no ffmpeg), **Video only**, **Audio only**.
3. **Quick Download**: Best Video+Audio, Audio Only, Lowest.
4. Each format card has **Download** → opens proxied stream (bypasses CORS, correct filename).

Pages sets `API_BASE` via the input at top (saved to localStorage). Leave empty for same-origin if you serve frontend from Worker assets.

---

## Env vars

| Var | Where | Purpose |
|-----|-------|---------|
| `YT_DLP_API_URL` | Worker `wrangler.toml` / dashboard | URL to `server/` FastAPI (e.g. `https://...fly.dev`). If empty, Worker is standalone (YT only). |
| `ALLOWED_ORIGIN` | Worker | CORS origin, `*` or `https://your-pages.pages.dev` |

Add via `wrangler.toml` `[vars]` or `wrangler secret put`.

---

## Supported sites

Without `server/`: YouTube (full via Innertube), others via oEmbed fallback metadata only.

With `server/` (yt-dlp): **1800+** — `yt-dlp --list-extractors` includes YouTube, TikTok, Instagram, Twitter/X, Facebook, Reddit, SoundCloud, Vimeo, Twitch, Bilibili, etc.

Keep yt-dlp fresh: `pip install -U yt-dlp` or rebuild Docker.

---

## Local testing without Cloudflare

```bash
# Worker dev
npx wrangler dev --port 8787

# Server dev (if you want full sites locally)
cd server && uvicorn main:app --reload --port 8000
```

---

## Notes

- Worker streaming uses `fetch` + `Response` passthrough — no buffering, supports large files and Range.
- For merged best quality (video+audio muxed) you need ffmpeg, which only `server/` has. Worker standalone offers already-muxed formats (e.g. 720p mp4) — max combined quality without ffmpeg.
- Respect TOS and copyright. Only download content you have rights to.

---

## Project structure

```
downloader-anything/
├── src/index.ts          # Hono Worker (main backend)
├── wrangler.toml         # Worker config
├── frontend/
│   ├── index.html        # Pages frontend (Tailwind, vanilla JS)
│   └── app.js
├── server/
│   ├── main.py           # FastAPI + yt-dlp (Docker)
│   ├── requirements.txt
│   └── Dockerfile
└── worker-python/
    ├── src/entry.py      # Python Worker with yt-dlp (alternative)
    └── pyproject.toml
```
