// downloader-anything frontend logic
const $ = (s) => document.querySelector(s);
const $$ = (s) => document.querySelectorAll(s);

const urlInput = $("#urlInput");
const fetchBtn = $("#fetchBtn");
const pasteBtn = $("#pasteBtn");
const apiUrlInput = $("#apiUrl");
const testApiBtn = $("#testApiBtn");
const apiStatus = $("#apiStatus");
const apiBadge = $("#apiBadge");

const stateLoading = $("#stateLoading");
const stateError = $("#stateError");
const stateIdle = $("#stateIdle");
const errorMsg = $("#errorMsg");
const errorHint = $("#errorHint");
const result = $("#result");

const thumb = $("#thumb");
const durBadge = $("#durBadge");
const extBadge = $("#extBadge");
const titleEl = $("#title");
const uploaderEl = $("#uploader");
const viewsEl = $("#views");
const descEl = $("#desc");
const openOriginal = $("#openOriginal");
const formatList = $("#formatList");
const formatCount = $("#formatCount");

let lastInfo = null;
let currentTab = "combined";

// Persist API URL — default to deployed Worker
const DEFAULT_WORKER = "https://downloader-anything.parithosh.workers.dev";
const LS_KEY = "dl_api_url";
apiUrlInput.value = localStorage.getItem(LS_KEY) || DEFAULT_WORKER;
if (!localStorage.getItem(LS_KEY)) localStorage.setItem(LS_KEY, DEFAULT_WORKER);
apiUrlInput.placeholder = DEFAULT_WORKER;
apiUrlInput.addEventListener("change", () => localStorage.setItem(LS_KEY, apiUrlInput.value.trim()));
apiUrlInput.addEventListener("input", () => localStorage.setItem(LS_KEY, apiUrlInput.value.trim()));

function getApiBase() {
  const v = apiUrlInput.value.trim().replace(/\/$/, "");
  if (v) return v;
  return DEFAULT_WORKER;
}

function toast(msg) {
  const t = $("#toast");
  t.textContent = msg;
  t.classList.remove("hidden");
  setTimeout(() => t.classList.add("hidden"), 2200);
}

function showState(which) {
  for (const el of [stateLoading, stateError, result]) el.classList.add("hidden");
  if (which) which.classList.remove("hidden");
}

function formatDuration(sec) {
  if (!sec && sec !== 0) return "";
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  if (h) return `${h}:${String(m).padStart(2,"0")}:${String(s).padStart(2,"0")}`;
  return `${m}:${String(s).padStart(2,"0")}`;
}
function formatBytes(b) {
  if (!b) return "";
  if (b < 1024) return `${b} B`;
  if (b < 1024*1024) return `${(b/1024).toFixed(1)} KB`;
  return `${(b/1024/1024).toFixed(1)} MB`;
}

async function testApi() {
  const base = getApiBase();
  apiStatus.textContent = "checking...";
  try {
    const r = await fetch(`${base}/api/health`, { method: "GET" });
    const j = await r.json();
    apiStatus.textContent = `✓ ${j.mode || j.status} ${j.yt_dlp_version ? "• yt-dlp " + j.yt_dlp_version : ""}`;
    apiStatus.className = "text-xs text-emerald-300";
    apiBadge.classList.remove("hidden");
    apiBadge.href = base;
    apiBadge.title = JSON.stringify(j, null, 2);
    if (j.mode === "proxied" || j.yt_dlp_server) {
      apiBadge.innerHTML = `<span class="w-2 h-2 rounded-full bg-emerald-400 animate-pulse"></span> Proxied • Full 1800+`;
    } else {
      apiBadge.innerHTML = `<span class="w-2 h-2 rounded-full bg-amber-400 animate-pulse"></span> Standalone • YouTube`;
    }
  } catch (e) {
    apiStatus.textContent = "✗ unreachable — set Workers URL";
    apiStatus.className = "text-xs text-red-300";
    apiBadge.classList.add("hidden");
  }
}
testApiBtn.addEventListener("click", testApi);
// auto test on load
setTimeout(testApi, 500);

pasteBtn.addEventListener("click", async () => {
  try {
    const t = await navigator.clipboard.readText();
    urlInput.value = t.trim();
    urlInput.focus();
  } catch {
    toast("Clipboard blocked — paste manually");
  }
});
$$(".ex-link").forEach(b => b.addEventListener("click", () => {
  urlInput.value = b.dataset.url;
  fetchInfo();
}));
urlInput.addEventListener("keydown", (e) => { if (e.key === "Enter") fetchInfo(); });
fetchBtn.addEventListener("click", fetchInfo);
$("#copyInfo").addEventListener("click", () => {
  if (!lastInfo) return;
  navigator.clipboard.writeText(JSON.stringify(lastInfo, null, 2));
  toast("Info copied");
});

$$(".tab-btn").forEach(btn => {
  btn.addEventListener("click", () => {
    $$(".tab-btn").forEach(b => b.classList.remove("active", "bg-accent", "text-white"));
    $$(".tab-btn").forEach(b => b.classList.add("bg-white/10", "text-zinc-300"));
    btn.classList.add("active", "bg-accent", "text-white");
    btn.classList.remove("bg-white/10", "text-zinc-300");
    currentTab = btn.dataset.tab;
    renderFormats();
  });
});
// init tab styles
document.querySelector('[data-tab="combined"]').classList.add("bg-accent","text-white");

$$(".quick-btn").forEach(btn => {
  btn.addEventListener("click", () => {
    if (!lastInfo) return toast("Fetch a URL first");
    const q = btn.dataset.quick;
    const base = getApiBase();
    const safeTitle = (lastInfo.title || "download").replace(/[^\w\- ]/g, "").slice(0, 60).trim() || "download";
    if (q === "best") {
      // pick best combined or highest
      const fmts = lastInfo.formats || [];
      let best = fmts.find(f => f.has_video && f.has_audio) || fmts[0];
      if (!best) return toast("No formats");
      const dl = `${base}/api/download?direct_url=${encodeURIComponent(best.url)}&filename=${encodeURIComponent(safeTitle + "." + (best.ext || "mp4"))}`;
      window.open(dl, "_blank");
    } else if (q === "audio") {
      const fmts = (lastInfo.formats || []).filter(f => !f.has_video && f.has_audio);
      let best = fmts.sort((a,b) => (b.tbr||0)-(a.tbr||0))[0];
      if (!best) {
        // fallback: bestaudio via resolve
        const pageUrl = lastInfo.webpage_url || urlInput.value.trim();
        const dl = `${base}/api/download?url=${encodeURIComponent(pageUrl)}&audio_only=true&filename=${encodeURIComponent(safeTitle + ".m4a")}`;
        window.open(dl, "_blank");
        return;
      }
      const dl = `${base}/api/download?direct_url=${encodeURIComponent(best.url)}&filename=${encodeURIComponent(safeTitle + "." + (best.ext || "m4a"))}`;
      window.open(dl, "_blank");
    } else {
      const fmts = lastInfo.formats || [];
      let smallest = [...fmts].sort((a,b) => (a.filesize||a.filesize_approx||Infinity) - (b.filesize||b.filesize_approx||Infinity))[0];
      if (!smallest) smallest = fmts[fmts.length-1];
      if (!smallest) return toast("No formats");
      const dl = `${base}/api/download?direct_url=${encodeURIComponent(smallest.url)}&filename=${encodeURIComponent(safeTitle + "." + (smallest.ext || "mp4"))}`;
      window.open(dl, "_blank");
    }
  });
});

async function fetchInfo() {
  const url = urlInput.value.trim();
  if (!url) return toast("Paste a URL first");
  if (!/^https?:\/\//.test(url)) return toast("URL must start with https://");
  showState(stateLoading);
  fetchBtn.disabled = true;
  fetchBtn.innerHTML = `<span class="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin"></span> Fetching`;
  try {
    const base = getApiBase();
    const res = await fetch(`${base}/api/info`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url }),
    });
    const data = await res.json();
    if (!res.ok) {
      throw { message: data.error || `HTTP ${res.status}`, hint: data.hint || data.docs || "", data };
    }
    if (data.error) throw { message: data.error, hint: data.hint || "" };
    lastInfo = data;
    renderResult(data);
    showState(result);
    // update badge if we learned mode
    if (data._source) apiStatus.textContent = `via ${data._source}`;
  } catch (e) {
    const msg = e.message || String(e);
    errorMsg.textContent = msg;
    if (e.hint) {
      errorHint.textContent = e.hint;
      errorHint.classList.remove("hidden");
    } else if (e.data && e.data.hint) {
      errorHint.textContent = e.data.hint;
      errorHint.classList.remove("hidden");
    } else {
      errorHint.classList.add("hidden");
    }
    // Include raw if 501 with requires server
    if (e.data && e.data._requires_server) {
      errorHint.textContent = "Deploy server/ (see README) and set YT_DLP_API_URL in wrangler.toml, then redeploy Worker for full support.";
      errorHint.classList.remove("hidden");
    }
    showState(stateError);
  } finally {
    fetchBtn.disabled = false;
    fetchBtn.innerHTML = `<i class="ri-search-line"></i> Fetch`;
  }
}

function renderResult(info) {
  thumb.src = info.thumbnail || info.thumbnails?.slice(-1)[0]?.url || "";
  thumb.onerror = () => { thumb.style.display = "none"; };
  thumb.style.display = "block";
  durBadge.textContent = info.duration ? formatDuration(info.duration) : "";
  durBadge.style.display = info.duration ? "block" : "none";
  extBadge.textContent = (info.extractor || "yt-dlp").toUpperCase();
  titleEl.textContent = info.title || "Untitled";
  uploaderEl.querySelector("span").textContent = info.uploader || info.channel || "Unknown";
  viewsEl.textContent = info.view_count ? `${Number(info.view_count).toLocaleString()} views` : "";
  descEl.textContent = info.description || "";
  descEl.style.display = info.description ? "block" : "none";
  openOriginal.href = info.webpage_url || urlInput.value.trim();

  // expose for debugging
  window._lastInfo = info;

  renderFormats();
}

function renderFormats() {
  if (!lastInfo) return;
  const all = lastInfo.formats || [];
  let filtered = [];
  if (currentTab === "combined") filtered = all.filter(f => f.has_video && f.has_audio);
  else if (currentTab === "video") filtered = all.filter(f => f.has_video && !f.has_audio);
  else if (currentTab === "audio") filtered = all.filter(f => !f.has_video && f.has_audio);

  // if combined empty, show message
  formatCount.textContent = `${filtered.length} formats • ${all.length} total`;
  formatList.innerHTML = "";

  if (all.length === 0) {
    formatList.innerHTML = `<div class="rounded-xl border border-amber-500/20 bg-amber-500/10 p-4 text-xs text-amber-200">No downloadable formats returned. ${lastInfo._note || "This site may need the yt-dlp server (deploy server/ and set YT_DLP_API_URL). YouTube works standalone."}</div>`;
    return;
  }
  if (filtered.length === 0) {
    formatList.innerHTML = `<div class="rounded-xl border border-white/10 bg-white/5 p-6 text-center text-sm text-zinc-400">No ${currentTab} formats in this tab. Try another tab. <br><span class="text-xs text-zinc-500">Tip: Combined = video+audio single file (no ffmpeg). Video-only + Audio-only need merging on server — deploy server/ for best quality.</span></div>`;
    return;
  }

  const base = getApiBase();
  const safeTitle = (lastInfo.title || "download").replace(/[^\w\- ]/g, "").slice(0, 60).trim() || "download";

  for (const f of filtered.slice(0, 30)) {
    const row = document.createElement("div");
    row.className = "format-card flex items-center gap-3 p-3 rounded-xl border border-white/10 bg-white/[0.03] transition";
    const badge = f.has_video && f.has_audio ? "COMBINED" : f.has_video ? "VIDEO" : "AUDIO";
    const res = f.height ? `${f.height}p${f.fps ? " • " + f.fps + "fps" : ""}` : f.format_note || badge;
    const size = formatBytes(f.filesize || f.filesize_approx);
    const ext = (f.ext || "").toUpperCase();
    const tbr = f.tbr ? `${Math.round(f.tbr)} kbps` : "";
    row.innerHTML = `
      <div class="shrink-0 w-14 h-14 rounded-lg bg-ink border border-white/10 flex flex-col items-center justify-center">
        <span class="text-[10px] font-mono tracking-widest text-zinc-500">${ext || "MP4"}</span>
        <span class="text-xs font-bold">${f.height ? f.height + "p" : badge}</span>
      </div>
      <div class="flex-1 min-w-0">
        <div class="flex flex-wrap items-center gap-1.5">
          <span class="text-xs font-mono px-1.5 py-0.5 rounded bg-white/10 border border-white/10">${f.format_id}</span>
          <span class="text-xs text-zinc-300">${res}</span>
          <span class="text-xs text-zinc-500">${f.vcodec !== "none" ? f.vcodec : ""} ${f.acodec !== "none" ? "• " + f.acodec : ""}</span>
        </div>
        <div class="mt-1 flex flex-wrap items-center gap-2 text-[11px] text-zinc-500 font-mono">
          <span>${size || "size unknown"}</span>
          ${tbr ? `<span>• ${tbr}</span>` : ""}
          ${f.format_note ? `<span>• ${f.format_note}</span>` : ""}
        </div>
      </div>
      <button class="shrink-0 h-9 px-4 rounded-xl bg-white text-ink text-xs font-bold hover:bg-zinc-100 flex items-center gap-1.5"><i class="ri-download-line"></i> Download</button>
    `;
    const btn = row.querySelector("button");
    btn.addEventListener("click", () => {
      // If format has direct url, proxy it; else ask server to resolve
      if (f.url) {
        const dl = `${base}/api/download?direct_url=${encodeURIComponent(f.url)}&filename=${encodeURIComponent(safeTitle + "." + (f.ext || "mp4"))}`;
        window.open(dl, "_blank");
      } else {
        const pageUrl = lastInfo.webpage_url || urlInput.value.trim();
        const dl = `${base}/api/download?url=${encodeURIComponent(pageUrl)}&format_id=${encodeURIComponent(f.format_id)}&filename=${encodeURIComponent(safeTitle + "." + (f.ext || "mp4"))}`;
        window.open(dl, "_blank");
      }
    });
    formatList.appendChild(row);
  }
  if (filtered.length > 30) {
    const more = document.createElement("div");
    more.className = "text-center text-xs text-zinc-500 py-2";
    more.textContent = `+ ${filtered.length - 30} more formats not shown`;
    formatList.appendChild(more);
  }
}

// Init
showState(null);
