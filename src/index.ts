import { Hono } from "hono";
import { cors } from "hono/cors";

type Env = {
  YT_DLP_API_URL?: string;
  ALLOWED_ORIGIN?: string;
};

const app = new Hono<{ Bindings: Env }>();

// CORS
app.use(
  "/*",
  cors({
    origin: (origin, c) => {
      const allowed = c.env.ALLOWED_ORIGIN || "*";
      if (allowed === "*") return "*";
      return allowed;
    },
    allowMethods: ["GET", "POST", "OPTIONS"],
    allowHeaders: ["Content-Type", "Range"],
    exposeHeaders: ["Content-Length", "Content-Range", "Content-Disposition"],
  })
);

// Helpers
const YT_REGEX = /(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/shorts\/|youtube\.com\/embed\/)([a-zA-Z0-9_-]{11})/;
const URL_REGEX = /^https?:\/\/.+/;

function jsonError(c: any, msg: string, status = 400, extra: any = {}) {
  return c.json({ error: msg, ...extra }, status);
}

function sanitizeFilename(name: string): string {
  return name.replace(/[^\w\-\.\s]/g, "").replace(/\s+/g, "_").slice(0, 80) || "download";
}

function formatBytes(bytes?: number): string {
  if (!bytes) return "unknown";
  const units = ["B", "KB", "MB", "GB"];
  let i = 0;
  let n = bytes;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

// Extract YouTube videoId
function parseYouTubeId(url: string): string | null {
  const m = url.match(YT_REGEX);
  return m ? m[1] : null;
}

// Innertube extraction for YouTube (no yt-dlp needed, works on Workers)
// NOTE: YouTube now forces SABR for WEB clients and requires PO Token for ANDROID/IOS.
// Standalone Innertube may only return limited formats (e.g. 240p) or none. For full 1080p+,
// deploy server/ and configure YT_DLP_API_URL — yt-dlp handles PO token rotation.
// This function returns whatever is available and includes a helpful note.
async function extractYouTubeInnertube(videoId: string) {
  const INNERTUBE_KEY = "AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8";
  // Try multiple clients — ordered by likelihood to return at least 240p without PO token
  const clients: any[] = [
    { clientName: "WEB", clientVersion: "2.20250222.10.00", hl: "en", gl: "US", timeZone: "UTC", utcOffsetMinutes: 0 },
    { clientName: "ANDROID", clientVersion: "19.09.37", androidSdkVersion: 30, hl: "en", gl: "US", utcOffsetMinutes: 0 },
    { clientName: "MWEB", clientVersion: "2.20250222.10.00", hl: "en", gl: "US", utcOffsetMinutes: 0 },
    { clientName: "WEB_EMBEDDED_PLAYER", clientVersion: "1.20250222.10.00", hl: "en", gl: "US", utcOffsetMinutes: 0 },
  ];

  let lastDetails: any = null;
  let bestResult: any = null;

  for (const client of clients) {
    try {
      const res = await fetch(`https://www.youtube.com/youtubei/v1/player?key=${INNERTUBE_KEY}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Origin": "https://www.youtube.com",
          "Referer": "https://www.youtube.com/",
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
        },
        body: JSON.stringify({
          context: { client },
          videoId,
          contentCheckOk: true,
          racyCheckOk: true,
          playbackContext: { contentPlaybackContext: { html5Preference: "HTML5_PREF_WANTS" } },
        }),
      });
      if (!res.ok) continue;
      const data: any = await res.json();
      const details = data.videoDetails || data.microformat?.playerMicroformatRenderer || {};
      if (details) lastDetails = data;
      const streaming = data.streamingData || {};
      const formats: any[] = [...(streaming.formats || []), ...(streaming.adaptiveFormats || [])];
      // Keep best attempt (most formats)
      if (formats.length === 0) continue;

      const normalized = formats
        .filter((f: any) => f.url) // SABR may return formats without url
        .map((f: any, idx: number) => {
          const isVideo = !!f.width;
          const isAudio = !f.width && !!f.audioQuality;
          const height = f.height;
          const ext = f.mimeType?.includes("mp4") ? "mp4" : f.mimeType?.includes("webm") ? "webm" : "m4a";
          return {
            format_id: f.itag?.toString() || `fmt-${idx}`,
            ext,
            resolution: f.width ? `${f.width}x${f.height}` : "audio only",
            height: height || null,
            width: f.width || null,
            fps: f.fps || null,
            vcodec: f.mimeType?.includes("avc1") ? "avc1" : f.mimeType?.includes("vp9") ? "vp9" : isAudio ? "none" : "unknown",
            acodec: isAudio || f.audioQuality ? "aac" : "none",
            filesize: f.contentLength ? parseInt(f.contentLength) : undefined,
            filesize_approx: f.contentLength ? parseInt(f.contentLength) : undefined,
            tbr: f.bitrate ? f.bitrate / 1000 : undefined,
            url: f.url,
            protocol: "https",
            format_note: f.qualityLabel || (isVideo && isAudio ? `${height || ""}p` : isVideo ? `${height}p (video only)` : `audio ${f.audioQuality || ""}`),
            hasVideo: !!f.width,
            hasAudio: !!f.audioQuality || !!f.audioSampleRate || f.mimeType?.includes("audio"),
            mimeType: f.mimeType,
            qualityLabel: f.qualityLabel || null,
            bitrate: f.bitrate,
          };
        });

      if (normalized.length === 0) continue;
      normalized.sort((a, b) => {
        const score = (f: any) => (f.hasVideo && f.hasAudio ? 10000 + (f.height || 0) : f.hasVideo ? 5000 + (f.height || 0) : (f.bitrate || 0) / 1000);
        return score(b) - score(a);
      });

      const thumbnails = data.videoDetails?.thumbnail?.thumbnails || [];
      const bestThumb = thumbnails[thumbnails.length - 1]?.url || `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`;
      const result = {
        id: videoId,
        title: data.videoDetails?.title || details.title?.simpleText || "YouTube Video",
        thumbnail: bestThumb,
        duration: parseInt(data.videoDetails?.lengthSeconds) || null,
        uploader: data.videoDetails?.author || data.videoDetails?.channelId || "Unknown",
        channel: data.videoDetails?.author,
        extractor: "youtube (innertube)",
        webpage_url: `https://www.youtube.com/watch?v=${videoId}`,
        description: data.videoDetails?.shortDescription || "",
        view_count: data.videoDetails?.viewCount ? parseInt(data.videoDetails.viewCount) : null,
        formats: normalized,
        _source: "innertube",
        _note: normalized.length <= 1 ? "Limited formats: YouTube now requires PO Token for HD. Deploy server/ (yt-dlp) with PO token support for 1080p+. This standalone gives 240p/best available without server." : undefined,
      };
      // Prefer result with most formats / highest quality
      if (!bestResult || normalized.length > bestResult.formats.length || (normalized[0]?.height || 0) > (bestResult.formats[0]?.height || 0)) {
        bestResult = result;
      }
      // If we got a good combined format, return early
      if (normalized.some((f) => f.hasVideo && f.hasAudio && (f.height || 0) >= 720)) return result;
    } catch (e) {
      continue;
    }
  }
  if (bestResult) return bestResult;
  // Fallback: try HTML scraping for YouTube (watch page contains ytInitialPlayerResponse with streamingData)
  try {
    const htmlInfo = await extractYouTubeViaHTML(videoId);
    if (htmlInfo && htmlInfo.formats.length > 0) return htmlInfo;
    if (htmlInfo) return htmlInfo; // even if no formats, return metadata
  } catch {}
  // Fallback: return metadata even without formats (so frontend shows title/thumb)
  if (lastDetails?.videoDetails) {
    const d = lastDetails.videoDetails;
    const thumbs = d.thumbnail?.thumbnails || [];
    return {
      id: videoId,
      title: d.title || "YouTube Video",
      thumbnail: thumbs[thumbs.length - 1]?.url || `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
      duration: parseInt(d.lengthSeconds) || null,
      uploader: d.author || "Unknown",
      channel: d.author,
      extractor: "youtube (innertube)",
      webpage_url: `https://www.youtube.com/watch?v=${videoId}`,
      description: d.shortDescription || "",
      view_count: d.viewCount ? parseInt(d.viewCount) : null,
      formats: [],
      _source: "innertube",
      _note: "No streaming URLs returned (YouTube SABR/PO Token required). Deploy server/ with yt-dlp and PO token for downloads, or try Invidious/Piped instance. Metadata only.",
      _requires_server: true,
    };
  }
  throw new Error("Failed to extract YouTube info (all clients failed — YouTube may require PO Token/SABR). Deploy server/ (yt-dlp) for reliable extraction.");
}

// HTML fallback for YouTube — parses ytInitialPlayerResponse from watch page
async function extractYouTubeViaHTML(videoId: string): Promise<any | null> {
  try {
    const res = await fetch(`https://www.youtube.com/watch?v=${videoId}`, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
        "Accept-Language": "en-US,en;q=0.9",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      },
    });
    if (!res.ok) return null;
    const html = await res.text();
    const m = html.match(/ytInitialPlayerResponse\s*=\s*(\{.+?\});/);
    if (!m) return null;
    const data = JSON.parse(m[1]);
    const details = data.videoDetails || {};
    const streaming = data.streamingData || {};
    const formats: any[] = [...(streaming.formats || []), ...(streaming.adaptiveFormats || [])].filter((f: any) => f.url);
    if (formats.length === 0) {
      // still return metadata so frontend not empty
      const ogThumb = html.match(/<meta property="og:image" content="([^"]+)"/)?.[1] || `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`;
      return {
        id: videoId,
        title: details.title || html.match(/<meta property="og:title" content="([^"]+)"/)?.[1] || "YouTube Video",
        thumbnail: details.thumbnail?.thumbnails?.slice(-1)[0]?.url || ogThumb,
        duration: parseInt(details.lengthSeconds) || null,
        uploader: details.author || "Unknown",
        extractor: "youtube (html)",
        webpage_url: `https://www.youtube.com/watch?v=${videoId}`,
        description: details.shortDescription || "",
        formats: [],
        _source: "html",
        _note: "HTML contained no streaming URLs (YT bot check). Try server/ or different video.",
        _requires_server: true,
      };
    }
    const normalized = formats.map((f: any, idx: number) => {
      const isVideo = !!f.width;
      const height = f.height;
      const ext = f.mimeType?.includes("mp4") ? "mp4" : f.mimeType?.includes("webm") ? "webm" : "m4a";
      const isAudio = !f.width && !!f.audioQuality;
      return {
        format_id: f.itag?.toString() || `fmt-${idx}`,
        ext,
        resolution: f.width ? `${f.width}x${f.height}` : "audio only",
        height: height || null,
        width: f.width || null,
        fps: f.fps || null,
        vcodec: f.mimeType?.includes("avc1") ? "avc1" : f.mimeType?.includes("vp9") ? "vp9" : isAudio ? "none" : "unknown",
        acodec: isAudio ? "aac" : f.audioQuality ? "aac" : f.mimeType?.includes("audio") ? "aac" : "none",
        filesize: f.contentLength ? parseInt(f.contentLength) : undefined,
        filesize_approx: f.contentLength ? parseInt(f.contentLength) : undefined,
        tbr: f.bitrate ? f.bitrate / 1000 : undefined,
        url: f.url,
        protocol: "https",
        format_note: f.qualityLabel || (isVideo ? `${height}p` : "audio"),
        hasVideo: !!f.width,
        hasAudio: !!f.audioQuality || f.mimeType?.includes("audio") || !!f.audioSampleRate,
        mimeType: f.mimeType,
        qualityLabel: f.qualityLabel || null,
        bitrate: f.bitrate,
      };
    });
    normalized.sort((a, b) => {
      const sc = (f: any) => (f.hasVideo && f.hasAudio ? 10000 + (f.height || 0) : f.hasVideo ? 5000 + (f.height || 0) : f.bitrate || 0);
      return sc(b) - sc(a);
    });
    const thumbs = details.thumbnail?.thumbnails || [];
    return {
      id: videoId,
      title: details.title || "YouTube Video",
      thumbnail: thumbs[thumbs.length - 1]?.url || `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
      duration: parseInt(details.lengthSeconds) || null,
      uploader: details.author || "Unknown",
      extractor: "youtube (html)",
      webpage_url: `https://www.youtube.com/watch?v=${videoId}`,
      description: details.shortDescription || "",
      view_count: details.viewCount ? parseInt(details.viewCount) : null,
      formats: normalized,
      _source: "html",
      _note: normalized.length <= 2 ? "Limited via HTML (SABR). Self-hosted yt-dlp with PO token gives HD." : undefined,
    };
  } catch {
    return null;
  }
}

// Cobalt fallback — public yt-dlp API (handles PO tokens, 1800+ sites, no self-host needed)
// Tries api.cobalt.tools then co.wuk.sh; returns normalized info with one combined format
async function tryCobalt(pageUrl: string): Promise<any | null> {
  const instances = [
    "https://api.cobalt.tools",
    "https://co.wuk.sh",
  ];
  for (const base of instances) {
    try {
      const res = await fetch(`${base}/`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Accept": "application/json",
        },
        body: JSON.stringify({
          url: pageUrl,
          downloadMode: "auto",
          videoQuality: "720",
          audioFormat: "mp3",
          filenameStyle: "pretty",
        }),
      });
      if (!res.ok) continue;
      const data: any = await res.json();
      // cobalt returns {status, url, filename, picker?}
      if (data.status === "error" || data.error) continue;
      const direct = data.url as string;
      if (!direct || !direct.startsWith("http")) {
        // picker type (multiple files) — use first item
        if (Array.isArray(data.picker) && data.picker[0]?.url) {
          const first = data.picker[0];
          const u = first.url as string;
          const fname = first.filename || data.filename || "download";
          return {
            id: null,
            title: data.filename || fname || "Cobalt download",
            thumbnail: null,
            duration: null,
            uploader: null,
            extractor: `cobalt (${new URL(base).hostname})`,
            webpage_url: pageUrl,
            description: null,
            formats: [
              {
                format_id: "cobalt-720",
                ext: (fname.split(".").pop() || "mp4").toLowerCase(),
                resolution: "720p",
                height: 720,
                width: 1280,
                fps: null,
                vcodec: "avc1",
                acodec: "aac",
                filesize: null,
                filesize_approx: null,
                tbr: null,
                url: u,
                protocol: "https",
                format_note: "720p via cobalt (fallback)",
                hasVideo: true,
                hasAudio: true,
              },
            ],
            _source: "cobalt",
            _picker: data.picker,
          };
        }
        continue;
      }
      const filename = (data.filename || "download").toString();
      const ext = filename.includes(".") ? filename.split(".").pop()!.toLowerCase() : "mp4";
      // Try to get title via oembed/noembed in parallel would be nice, but cobalt's filename is title-ish
      const title = filename.replace(/\.[^/.]+$/, "").replace(/_/g, " ") || "Download";
      // Attempt to fetch oembed for thumb/title in background (non-blocking for now)
      let thumb: string | null = null;
      let oembedTitle: string | null = null;
      try {
        const oR = await fetch(`https://noembed.com/embed?url=${encodeURIComponent(pageUrl)}`);
        if (oR.ok) {
          const o: any = await oR.json();
          if (!o.error) {
            thumb = o.thumbnail_url || null;
            oembedTitle = o.title || null;
          }
        }
      } catch {}
      return {
        id: null,
        title: oembedTitle || title,
        thumbnail: thumb,
        duration: null,
        uploader: null,
        extractor: `cobalt (${new URL(base).hostname})`,
        webpage_url: pageUrl,
        description: null,
        view_count: null,
        formats: [
          {
            format_id: "cobalt-auto",
            ext,
            resolution: "720p",
            height: 720,
            width: 1280,
            fps: null,
            vcodec: "avc1",
            acodec: "aac",
            filesize: null,
            filesize_approx: null,
            tbr: null,
            url: direct,
            protocol: "https",
            format_note: "via cobalt (auto, no self-host needed)",
            hasVideo: true,
            hasAudio: true,
          },
        ],
        _source: "cobalt",
        _cobalt: { status: data.status, filename: data.filename, base },
      };
    } catch {
      continue;
    }
  }
  return null;
}

// Generic proxy to external yt-dlp server (FastAPI/Docker)
async function proxyToYtDlpServer(env: Env, path: string, init?: RequestInit) {
  if (!env.YT_DLP_API_URL) return null;
  const base = env.YT_DLP_API_URL.replace(/\/$/, "");
  const url = `${base}${path}`;
  const res = await fetch(url, init);
  return res;
}

// Routes
app.get("/", (c) => {
  return c.json({
    name: "downloader-anything",
    status: "ok",
    version: "1.0.0",
    endpoints: {
      "POST /api/info": "Extract video info (yt-dlp compatible)",
      "GET /api/download?url=&format_id=&filename=": "Proxy download with proper headers",
      "GET /api/proxy?url=&filename=": "Direct URL proxy",
      "GET /api/health": "Health check",
    },
    mode: c.env.YT_DLP_API_URL ? `proxied -> ${c.env.YT_DLP_API_URL}` : "standalone (YouTube Innertube, others need YT_DLP_API_URL)",
    docs: "Deploy server/ to get full 1800+ site support via real yt-dlp + ffmpeg",
  });
});

app.get("/api/health", (c) => {
  return c.json({
    status: "ok",
    timestamp: new Date().toISOString(),
    yt_dlp_server: c.env.YT_DLP_API_URL || null,
    mode: c.env.YT_DLP_API_URL ? "proxied" : "standalone",
    supported: c.env.YT_DLP_API_URL
      ? "1800+ sites via yt-dlp (full)"
      : "YouTube (full), others limited - deploy server/ for full support",
  });
});

// POST /api/info
app.post("/api/info", async (c) => {
  let body: any;
  try {
    body = await c.req.json();
  } catch {
    return jsonError(c, "Invalid JSON body", 400);
  }
  const url = (body.url || body.link || "").trim();
  if (!url) return jsonError(c, "Missing 'url' field");
  if (!URL_REGEX.test(url)) return jsonError(c, "Invalid URL");

  // If external yt-dlp server configured, proxy there first (best quality, all sites)
  if (c.env.YT_DLP_API_URL) {
    try {
      const proxied = await proxyToYtDlpServer(c.env, "/api/info", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url }),
      });
      if (proxied && proxied.ok) {
        const data = await proxied.json();
        // If proxied returned 0 formats due to bot, still return it (frontend will show helpful note)
        return c.json(data);
      }
      if (proxied) {
        const errText = await proxied.text();
        console.warn("yt-dlp server failed:", proxied.status, errText);
        // If bot / login error, return it directly so frontend shows actionable hint instead of oEmbed
        if (/Sign in to confirm|bot|login required|rate-limit/i.test(errText)) {
          let detail = errText;
          try { detail = JSON.parse(errText).detail || detail; } catch {}
          return jsonError(c, detail.slice(0, 600), 400, {
            hint: "YouTube blocks datacenter IPs. Try SoundCloud example (works on edge) or run locally: `pip install yt-dlp && yt-dlp --extractor-args 'youtube:player_client=android,web' 'URL'`",
            _source: "yt-dlp (proxied, bot-blocked)",
            _requires_server: false,
          });
        }
        // otherwise fall through to local extraction
      }
    } catch (e: any) {
      console.warn("proxy error", e.message);
    }
  }

  // Local extraction (Workers standalone)
  const ytId = parseYouTubeId(url);
  if (ytId) {
    try {
      const info = await extractYouTubeInnertube(ytId);
      // If innertube returned formats, done. If not, try HTML fallback + oembed
      if (info.formats && info.formats.length > 0) return c.json(info);
      // innertube gave metadata but no formats (SABR/PO token block) -> try oembed/HTML for title/thumb
      // Still return info with note so frontend shows metadata
      return c.json(info);
    } catch (e: any) {
      // Fallback: try to scrape YouTube HTML for og:title/thumb (works even when innertube blocked from edge)
      try {
        const htmlRes = await fetch(`https://www.youtube.com/watch?v=${ytId}`, {
          headers: {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
            "Accept-Language": "en-US,en;q=0.9",
          },
        });
        if (htmlRes.ok) {
          const html = await htmlRes.text();
          const ogTitle = html.match(/<meta property="og:title" content="([^"]+)"/)?.[1] || html.match(/<title>([^<]+)<\/title>/)?.[1]?.replace(" - YouTube","") || "YouTube Video";
          const ogThumb = html.match(/<meta property="og:image" content="([^"]+)"/)?.[1] || `https://i.ytimg.com/vi/${ytId}/hqdefault.jpg`;
          const ogDesc = html.match(/<meta property="og:description" content="([^"]+)"/)?.[1] || "";
          return c.json({
            id: ytId,
            title: ogTitle,
            thumbnail: ogThumb,
            duration: null,
            uploader: html.match(/"author":"([^"]+)"/)?.[1] || "Unknown",
            extractor: "youtube (html fallback)",
            webpage_url: `https://www.youtube.com/watch?v=${ytId}`,
            description: ogDesc.slice(0, 500),
            view_count: null,
            formats: [],
            _source: "html",
            _note: "Innertube blocked from edge (YouTube SABR/PO Token). Deploy server/ (yt-dlp) to Fly/Render for reliable downloads. Metadata via HTML fallback.",
            _requires_server: true,
            _original_error: e.message,
          });
        }
      } catch {}
      // Last fallback: noembed
      try {
        const oembedRes = await fetch(`https://noembed.com/embed?url=${encodeURIComponent(url)}`);
        if (oembedRes.ok) {
          const oembed: any = await oembedRes.json();
          if (!oembed.error) {
            return c.json({
              id: ytId,
              title: oembed.title || "YouTube Video",
              thumbnail: oembed.thumbnail_url || `https://i.ytimg.com/vi/${ytId}/hqdefault.jpg`,
              duration: null,
              uploader: oembed.author_name || "Unknown",
              extractor: "oembed (fallback)",
              webpage_url: url,
              description: null,
              formats: [],
              _note: "Innertube blocked, oEmbed fallback. Deploy server/ for downloads.",
              _requires_server: true,
              _original_error: e.message,
            });
          }
        }
      } catch {}
      return jsonError(c, e.message || "YouTube extraction failed (edge IP may be blocked, deploy server/ for reliable)", 500, { extractor: "youtube", hint: "Deploy server/ to Fly.io/Render and set YT_DLP_API_URL — that IP is less flagged than Workers edge.", _requires_server: true });
    }
  }

  // If no yt-dlp server and YouTube innertube failed, try Cobalt API (public yt-dlp wrapper, works for YT HD, TikTok, IG, X, etc)
  // Cobalt is free, open-source, and handles PO tokens — perfect fallback for Workers edge
  try {
    const cobaltUrl = await tryCobalt(url);
    if (cobaltUrl) return c.json(cobaltUrl);
  } catch (e) {
    console.warn("cobalt fallback failed", e);
  }

  // For non-YouTube, if no yt-dlp server, return helpful error with oembed attempt
  // Try oEmbed for some providers as fallback (Twitter, TikTok, Instagram limited)
  try {
    // Attempt generic oembed via noembed.com (works for many sites, gives title+thumb)
    const oembedRes = await fetch(`https://noembed.com/embed?url=${encodeURIComponent(url)}`);
    if (oembedRes.ok) {
      const oembed: any = await oembedRes.json();
      if (!oembed.error) {
        // Also try cobalt-derived formats if available (already tried above, but oembed still useful for metadata)
        return c.json({
          id: null,
          title: oembed.title || "Untitled",
          thumbnail: oembed.thumbnail_url || null,
          duration: null,
          uploader: oembed.author_name || null,
          extractor: "oembed (limited)",
          webpage_url: url,
          description: null,
          formats: [],
          _note: "Full formats require yt-dlp server or Cobalt (auto-tried). If Cobalt was blocked, deploy server/ (see README) for 1800+ sites. This is oEmbed fallback metadata only.",
          oembed,
          _requires_server: true,
          _hint: "Tip: Paste a YouTube/TikTok/IG/X URL — Cobalt handles most. If still no formats, your link may be private or need the self-hosted server.",
        });
      }
    }
  } catch {}

  return jsonError(
    c,
    "No downloadable formats found. This link may be private/geo-blocked, or Cobalt + oEmbed both failed.",
    501,
    {
      url,
      hint: "Deploy the Python server (server/) to enable full yt-dlp (1800+ sites, no cobalt limits). Set YT_DLP_API_URL in wrangler.toml, redeploy Worker. Cobalt was auto-tried and failed — likely private content.",
      docs: "See README: server/Dockerfile → Fly/Render/Containers. Or try again with a public video (e.g. https://www.youtube.com/watch?v=jNQXAC9IVRw).",
      supported_standalone: "YouTube (via Cobalt fallback) + oEmbed metadata; full needs yt-dlp server.",
    }
  );
});

// GET /api/info?url= (convenience for testing)
app.get("/api/info", async (c) => {
  const url = c.req.query("url");
  if (!url) return jsonError(c, "Missing ?url= query");
  // Reuse POST logic by internal fetch
  const req = new Request(c.req.url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url }),
  });
  // Inject env via fetch to self? Simpler: duplicate logic
  // Just call handler directly by invoking fetch internally
  return app.fetch(req, c.env as any);
});

// GET /api/download - proxy download with disposition
app.get("/api/download", async (c) => {
  const url = c.req.query("url");
  const directUrl = c.req.query("direct_url") || c.req.query("format_url");
  const filename = c.req.query("filename") || "download";
  const formatId = c.req.query("format_id");
  const audioOnly = c.req.query("audio_only") === "true";

  // If yt-dlp server is configured and client sent original page URL, let server resolve best format
  if (url && c.env.YT_DLP_API_URL) {
    try {
      // Ask yt-dlp server to resolve direct URL
      const resolveRes = await proxyToYtDlpServer(c.env, "/api/resolve", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url, format_id: formatId, audio_only: audioOnly }),
      });
      if (resolveRes && resolveRes.ok) {
        const resolved: any = await resolveRes.json();
        const finalUrl = resolved.url || resolved.direct_url;
        if (finalUrl) {
          return proxyStream(c, finalUrl, resolved.filename || filename, resolved.ext || "mp4");
        }
      }
    } catch (e) {
      console.warn("resolve via yt-dlp server failed", e);
    }
  }

  // Direct URL proxy
  const target = directUrl || url;
  if (!target || !URL_REGEX.test(target)) return jsonError(c, "Missing or invalid ?url= or ?direct_url=");
  return proxyStream(c, target, filename);
});

// GET /api/proxy - generic proxy
app.get("/api/proxy", async (c) => {
  const target = c.req.query("url");
  const filename = c.req.query("filename") || "download";
  if (!target || !URL_REGEX.test(target)) return jsonError(c, "Missing ?url=");
  return proxyStream(c, target, filename);
});

async function proxyStream(c: any, targetUrl: string, filename: string, extFallback = "mp4") {
  try {
    const range = c.req.header("Range");
    const headers: Record<string, string> = {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    };
    if (range) headers["Range"] = range;

    const upstream = await fetch(targetUrl, { headers });

    if (!upstream.ok && upstream.status !== 206) {
      return jsonError(c, `Upstream fetch failed: ${upstream.status} ${upstream.statusText}`, 502);
    }

    const contentType = upstream.headers.get("Content-Type") || (filename.endsWith(".mp3") ? "audio/mpeg" : "video/mp4");
    const contentLength = upstream.headers.get("Content-Length");
    const contentRange = upstream.headers.get("Content-Range");
    const safeName = sanitizeFilename(filename);
    const ext = safeName.includes(".") ? "" : `.${extFallback}`;
    const disposition = `attachment; filename="${safeName}${ext}"; filename*=UTF-8''${encodeURIComponent(safeName + ext)}`;

    const resHeaders = new Headers();
    resHeaders.set("Content-Type", contentType);
    resHeaders.set("Content-Disposition", disposition);
    resHeaders.set("Accept-Ranges", "bytes");
    resHeaders.set("Cache-Control", "private, max-age=86400");
    if (contentLength) resHeaders.set("Content-Length", contentLength);
    if (contentRange) resHeaders.set("Content-Range", contentRange);
    if (range && upstream.status === 206) resHeaders.set("Content-Range", contentRange || "");

    // Stream body
    return new Response(upstream.body, {
      status: upstream.status,
      headers: resHeaders,
    });
  } catch (e: any) {
    return jsonError(c, e.message || "Proxy failed", 500);
  }
}

// Fallback
app.all("*", (c) => jsonError(c, "Not found", 404));

export default app;
