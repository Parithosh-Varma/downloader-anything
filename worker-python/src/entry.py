"""
Python Worker with yt-dlp - 100% Cloudflare, no external server needed
Uses Pyodide + yt-dlp pip package. Works for metadata extraction (no ffmpeg merging).
For full ffmpeg merging, deploy server/ to Containers/Fly/Render and use the JS Worker with YT_DLP_API_URL.
"""
from workers import WorkerEntrypoint, Response
import json
import re
import yt_dlp

URL_RE = re.compile(r"^https?://.+")

YDL_OPTS = {
    "quiet": True,
    "no_warnings": True,
    "skip_download": True,
    "noplaylist": True,
    "socket_timeout": 15,
}

def cors_headers(origin="*"):
    return {
        "Access-Control-Allow-Origin": origin,
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Range",
        "Access-Control-Expose-Headers": "Content-Length, Content-Range, Content-Disposition",
    }

class Default(WorkerEntrypoint):
    async def fetch(self, request):
        url = request.url
        method = request.method
        # url is a string in Python workers? Actually request.url is string-like
        try:
            from urllib.parse import urlparse, parse_qs
            parsed = urlparse(str(url))
            path = parsed.path
            query = parse_qs(parsed.query)
        except:
            path = "/"
            query = {}

        # Handle CORS preflight
        if method == "OPTIONS":
            return Response("", status=204, headers=cors_headers(self.env.ALLOWED_ORIGIN if hasattr(self.env, "ALLOWED_ORIGIN") else "*"))

        origin = getattr(self.env, "ALLOWED_ORIGIN", "*") if hasattr(self.env, "ALLOWED_ORIGIN") else "*"
        headers = cors_headers(origin)
        headers["Content-Type"] = "application/json"

        if path == "/" and method == "GET":
            return Response.json({
                "name": "downloader-anything (python)",
                "status": "ok",
                "runtime": "python_workers + yt-dlp",
                "yt_dlp_version": yt_dlp.version.__version__,
                "endpoints": ["POST /api/info", "GET /api/info?url=", "GET /api/proxy?url="],
            }, headers=headers)

        if path == "/api/health":
            return Response.json({
                "status": "ok",
                "runtime": "python",
                "yt_dlp_version": yt_dlp.version.__version__,
            }, headers=headers)

        if path == "/api/info" and method == "POST":
            try:
                body = await request.json()
                target = (body.get("url") or body.get("link") or "").strip()
            except:
                return Response.json({"error": "Invalid JSON"}, status=400, headers=headers)
            if not target or not URL_RE.match(target):
                return Response.json({"error": "Missing or invalid url"}, status=400, headers=headers)
            try:
                with yt_dlp.YoutubeDL(YDL_OPTS) as ydl:
                    info = ydl.extract_info(target, download=False)
                    if "entries" in info:
                        info = list(info["entries"])[0]
                    formats = []
                    for f in info.get("formats") or []:
                        formats.append({
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
                            "has_video": f.get("vcodec") != "none",
                            "has_audio": f.get("acodec") != "none",
                        })
                    # sort
                    def sk(f):
                        hv = f["has_video"]; ha = f["has_audio"]
                        if hv and ha: return (2, f.get("height") or 0, f.get("tbr") or 0)
                        if hv: return (1, f.get("height") or 0, 0)
                        return (0, f.get("tbr") or 0, 0)
                    formats.sort(key=sk, reverse=True)
                    return Response.json({
                        "id": info.get("id"),
                        "title": info.get("title"),
                        "thumbnail": info.get("thumbnail"),
                        "duration": info.get("duration"),
                        "uploader": info.get("uploader"),
                        "extractor": info.get("extractor"),
                        "webpage_url": info.get("webpage_url") or target,
                        "description": (info.get("description") or "")[:2000],
                        "view_count": info.get("view_count"),
                        "formats": formats,
                        "_source": "yt-dlp (python worker)",
                        "_yt_dlp_version": yt_dlp.version.__version__,
                    }, headers=headers)
            except Exception as e:
                return Response.json({"error": str(e)[:600]}, status=500, headers=headers)

        if path == "/api/info" and method == "GET":
            target = query.get("url", [None])[0]
            if not target:
                return Response.json({"error": "Missing ?url="}, status=400, headers=headers)
            # reuse POST logic via synthetic request
            fake_req = type("obj", (object,), {"json": lambda: {"url": target}})()
            # just extract directly
            try:
                with yt_dlp.YoutubeDL(YDL_OPTS) as ydl:
                    info = ydl.extract_info(target, download=False)
                    if "entries" in info:
                        info = list(info["entries"])[0]
                    formats = []
                    for f in info.get("formats") or []:
                        formats.append({
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
                            "has_video": f.get("vcodec") != "none",
                            "has_audio": f.get("acodec") != "none",
                        })
                    def sk(f):
                        hv = f["has_video"]; ha = f["has_audio"]
                        if hv and ha: return (2, f.get("height") or 0, f.get("tbr") or 0)
                        if hv: return (1, f.get("height") or 0, 0)
                        return (0, f.get("tbr") or 0, 0)
                    formats.sort(key=sk, reverse=True)
                    return Response.json({
                        "id": info.get("id"),
                        "title": info.get("title"),
                        "thumbnail": info.get("thumbnail"),
                        "duration": info.get("duration"),
                        "uploader": info.get("uploader"),
                        "extractor": info.get("extractor"),
                        "webpage_url": info.get("webpage_url") or target,
                        "formats": formats,
                    }, headers=headers)
            except Exception as e:
                return Response.json({"error": str(e)[:600]}, status=500, headers=headers)

        # Proxy endpoint - streams target URL
        if path == "/api/proxy" and method == "GET":
            target = query.get("url", [None])[0]
            filename = query.get("filename", ["download"])[0]
            if not target or not URL_RE.match(target):
                return Response.json({"error": "Missing ?url="}, status=400, headers=headers)
            try:
                # Use JS fetch via FFI
                from js import fetch as js_fetch
                # Python workers can call js fetch
                # Fallback: use Response redirect? We'll use js_fetch
                # Note: This is simplified - for full streaming, use JS Worker instead
                # Python worker proxy is limited but works for small files
                import js
                res = await js_fetch(target)
                # Can't easily stream binary in Python worker - return redirect
                return Response.json({
                    "proxy_url": target,
                    "filename": filename,
                    "note": "Python worker proxy limited - use JS Worker (/src/index.ts) for full streaming proxy with Range support. This endpoint returns URL for client-side download.",
                    "direct_url": target,
                }, headers=headers)
            except Exception as e:
                return Response.json({"error": str(e)[:500]}, status=500, headers=headers)

        return Response.json({"error": "Not found", "path": path}, status=404, headers=headers)
