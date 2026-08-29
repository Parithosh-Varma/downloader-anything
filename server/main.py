"""
yt-dlp backend for Cloudflare Workers
Deploy to: Fly.io, Render, Cloudflare Containers, Railway, or any Docker host
Provides /api/info and /api/resolve for the Worker to proxy
"""
from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, HttpUrl
import yt_dlp
import tempfile
import asyncio
from typing import Optional, List
import os

app = FastAPI(title="downloader-anything yt-dlp server", version="1.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)

class InfoRequest(BaseModel):
    url: str
    format_id: Optional[str] = None
    audio_only: Optional[bool] = False

class ResolveRequest(BaseModel):
    url: str
    format_id: Optional[str] = None
    audio_only: Optional[bool] = False

# yt-dlp options for info extraction (no download)
# YouTube now requires PO Token for HD; without it yt-dlp falls back to 240p (format 18)
# These opts mirror what works standalone without PO token. For HD, configure
# yt-dlp with --extractor-args "youtube:po_token=..." via env or tunneled server.
YDL_OPTS_INFO = {
    "quiet": True,
    "no_warnings": True,
    "skip_download": True,
    "noplaylist": True,
    "extract_flat": False,
    "socket_timeout": 15,
    "extractor_args": {
        "youtube": {
            "player_client": ["android,web"],  # best without PO token (gives 240p fallback)
            # For HD, add po_token or use: player_client=["tv","web"] with PO token provider
        }
    },
}

def extract_info(url: str):
    opts = {**YDL_OPTS_INFO}
    # Use temp cache dir to avoid permission issues
    with yt_dlp.YoutubeDL(opts) as ydl:
        info = ydl.extract_info(url, download=False)
        # If playlist, take first
        if "entries" in info:
            entries = list(info["entries"])
            if not entries:
                raise ValueError("No entries found (playlist empty or private)")
            info = entries[0]
        return info

def sanitize_formats(info: dict):
    formats = info.get("formats") or []
    # yt-dlp already provides request_formats, but expose all
    normalized = []
    for f in formats:
        normalized.append({
            "format_id": f.get("format_id"),
            "ext": f.get("ext"),
            "resolution": f.get("resolution") or (f"{f.get('width')}x{f.get('height')}" if f.get("width") else "audio only"),
            "height": f.get("height"),
            "width": f.get("width"),
            "fps": f.get("fps"),
            "vcodec": f.get("vcodec"),
            "acodec": f.get("acodec"),
            "filesize": f.get("filesize"),
            "filesize_approx": f.get("filesize_approx"),
            "tbr": f.get("tbr"),
            "url": f.get("url"),
            "protocol": f.get("protocol"),
            "format_note": f.get("format_note"),
            "quality": f.get("quality"),
            "has_video": f.get("vcodec") != "none",
            "has_audio": f.get("acodec") != "none",
        })
    # Sort: combined (video+audio) first, then video-only by height desc, then audio by abr desc
    def sort_key(f):
        has_v = f["has_video"]
        has_a = f["has_audio"]
        if has_v and has_a:
            return (2, f.get("height") or 0, f.get("tbr") or 0)
        if has_v:
            return (1, f.get("height") or 0, f.get("tbr") or 0)
        return (0, f.get("tbr") or 0, f.get("quality") or 0)
    normalized.sort(key=sort_key, reverse=True)
    return normalized

@app.get("/")
def root():
    return {
        "status": "ok",
        "service": "downloader-anything yt-dlp server",
        "endpoints": ["/api/info", "/api/resolve", "/health"],
        "yt_dlp_version": yt_dlp.version.__version__,
    }

@app.get("/health")
def health():
    return {"status": "ok", "yt_dlp_version": yt_dlp.version.__version__}

@app.post("/api/info")
def api_info(req: InfoRequest):
    if not req.url or not req.url.startswith("http"):
        raise HTTPException(400, "Invalid url")
    try:
        info = extract_info(req.url)
        formats = sanitize_formats(info)
        return {
            "id": info.get("id"),
            "title": info.get("title"),
            "thumbnail": info.get("thumbnail"),
            "thumbnails": info.get("thumbnails"),
            "duration": info.get("duration"),
            "uploader": info.get("uploader"),
            "uploader_id": info.get("uploader_id"),
            "channel": info.get("channel"),
            "extractor": info.get("extractor"),
            "webpage_url": info.get("webpage_url") or req.url,
            "description": (info.get("description") or "")[:2000],
            "view_count": info.get("view_count"),
            "like_count": info.get("like_count"),
            "age_limit": info.get("age_limit"),
            "live_status": info.get("live_status"),
            "formats": formats,
            "_source": "yt-dlp",
            "_yt_dlp_version": yt_dlp.version.__version__,
        }
    except yt_dlp.utils.DownloadError as e:
        msg = str(e)[:600]
        # Detect bot / login errors and make them actionable
        if "Sign in to confirm" in msg or "bot" in msg.lower():
            msg = f"YouTube bot-check from datacenter IP (Render/Vercel/Cloudflare flagged). Try locally on residential IP: pip install yt-dlp && yt-dlp --extractor-args 'youtube:player_client=android,web' '{req.url}' — Original: {msg}"
        raise HTTPException(400, f"yt-dlp error: {msg}")
    except Exception as e:
        raise HTTPException(500, f"Extraction failed: {str(e)[:500]}")

# For backward compat, also allow GET
@app.get("/api/info")
def api_info_get(url: str = Query(..., description="URL to extract")):
    return api_info(InfoRequest(url=url))

@app.post("/api/resolve")
def api_resolve(req: ResolveRequest):
    """Resolve a page URL + format_id to a direct cdn URL for the Worker to proxy"""
    if not req.url or not req.url.startswith("http"):
        raise HTTPException(400, "Invalid url")
    try:
        # Use format selection if provided
        ydl_opts = {**YDL_OPTS_INFO}
        if req.audio_only:
            ydl_opts["format"] = "bestaudio/best"
        elif req.format_id:
            ydl_opts["format"] = req.format_id

        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            info = ydl.extract_info(req.url, download=False)
            if "entries" in info:
                info = list(info["entries"])[0]
            
            # If format_id specified, find that format's URL
            direct_url = None
            ext = info.get("ext") or "mp4"
            filename = info.get("title") or "download"
            
            if req.format_id:
                for f in info.get("formats") or []:
                    if f.get("format_id") == req.format_id:
                        direct_url = f.get("url")
                        ext = f.get("ext") or ext
                        break
                if not direct_url:
                    # Let yt-dlp pick best for that format string
                    direct_url = info.get("url")
            else:
                direct_url = info.get("url")
                # If info has no url (no format selected), pick best
                if not direct_url and info.get("formats"):
                    # Best combined
                    best = None
                    for f in reversed(info["formats"]):
                        if f.get("vcodec") != "none" and f.get("acodec") != "none":
                            best = f
                            break
                    if not best:
                        best = info["formats"][-1]
                    direct_url = best.get("url")
                    ext = best.get("ext") or ext

            if not direct_url:
                raise HTTPException(500, "Could not resolve direct URL")

            # Sanitize filename for content-disposition
            safe = "".join(c if c.isalnum() or c in " -_." else "_" for c in filename)[:80].strip() or "download"

            return {
                "url": direct_url,
                "direct_url": direct_url,
                "filename": safe,
                "ext": ext,
                "title": info.get("title"),
                "thumbnail": info.get("thumbnail"),
                "duration": info.get("duration"),
                "extractor": info.get("extractor"),
            }
    except HTTPException:
        raise
    except yt_dlp.utils.DownloadError as e:
        raise HTTPException(400, f"yt-dlp error: {str(e)[:500]}")
    except Exception as e:
        raise HTTPException(500, f"Resolve failed: {str(e)[:500]}")
