// comfy-colab-kit Studio — a one-page video maker on top of ComfyUI, for people who do not want the node graph.
//
// Loaded by the frontend from the kit's ComfyUI node (custom_nodes/kit_heartbeat/web/studio/), so it is served
// by ComfyUI itself: it works the same through the gate's proxy and through a plain SSH tunnel to :8188.
// It only shows when the profile marks workflows with `studio: t2v | i2v | r2v | keyframes` (see /kit/info).
//
// A run = the installed workflow for the chosen mode, converted by the frontend's own graphToPrompt() once per
// page, then patched (patch.js) and queued with POST /prompt. Results and the inputs that made them are kept in
// this browser's IndexedDB, because the Colab disk is wiped when the GPU is released.
import { app } from "../../../scripts/app.js";
import { api } from "../../../scripts/api.js";
import * as P from "./patch.js";

const VERSION = 1;
const MODE_LABEL = { t2v: "文生视频", i2v: "首尾帧", r2v: "参考生成", keyframes: "参考 + 固定画面" };
const FAMILY = { t2v: "fl2va", i2v: "fl2va", r2v: "ref2va", keyframes: "ref2va" };
const RES = [
  { key: "480", label: "480P", mp: 0.4, hint: "最快，适合试效果" },
  { key: "720", label: "720P", mp: 0.88, hint: "约 2 倍耗时" },
  { key: "768", label: "768P", mp: 1.0, hint: "约 2.5 倍耗时" },
];
const ASPECT_ZH = {
  "16:9": "16:9 横屏", "9:16": "9:16 竖屏", "1:1": "1:1 方形", "4:3": "4:3", "3:4": "3:4",
  "21:9": "21:9 宽银幕", "3:2": "3:2 照片", "2:3": "2:3 竖版照片",
};
const DEFAULT_ASPECTS = ["16:9 (Widescreen)", "9:16 (Portrait Widescreen)", "1:1 (Square)", "4:3 (Standard)",
  "3:4 (Portrait Standard)", "21:9 (Ultrawide)", "3:2 (Photo)", "2:3 (Portrait Photo)"];
const DURATIONS = [4, 5, 8, 10, 15];
const LIMITS = { images: 9, videos: 3, audios: 3, anchors: 8 };
const INSPIRATIONS = [
  { label: "东方奇幻", text: "东方奇幻电影质感。黄昏的云海之上，一位身穿青色长袍的年轻剑客踏着飞剑穿过层层云雾，衣袂与长发被风吹起，远处是悬浮在空中的古老楼阁和瀑布。\n镜头：从剑客背后低角度跟拍，随后缓慢环绕到侧面，展示云海与夕阳。\n声音：呼啸的风声、衣袍猎猎作响，远处隐约的钟声，空灵的古琴配乐逐渐升起。" },
  { label: "城市电影", text: "写实电影质感，雨后的夜晚都市。霓虹灯倒映在湿漉漉的街道上，一位穿风衣的女人撑着透明雨伞穿过人群，停下脚步回头看向镜头。\n镜头：浅景深，长焦镜头缓慢推近，背景的车灯化成光斑。\n声音：雨滴落在伞面上的声音、远处的车流与人声，低沉的电子配乐。" },
  { label: "生活片段", text: "温暖的生活纪录片质感。清晨的厨房里，阳光从窗户斜照进来，一位老人系着围裙在案板上揉面团，面粉在光线里轻轻飘起，他抬头对镜头露出微笑。\n镜头：手持轻微晃动，先拍揉面的双手特写，再拉开到中景。\n声音：揉面的声音、窗外的鸟叫、锅里水开的咕嘟声，轻柔的吉他配乐。" },
];

// ───────────────────────── tiny DOM helpers ─────────────────────────
function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k === "style" && typeof v === "object") Object.assign(el.style, v);
    else if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2), v);
    else if (k === "html") el.innerHTML = v;
    else if (v === true) el.setAttribute(k, "");
    else el.setAttribute(k, v);
  }
  for (const c of kids.flat(Infinity)) if (c != null && c !== false) el.append(c.nodeType ? c : document.createTextNode(String(c)));
  return el;
}
const $ = (sel, root = document) => root.querySelector(sel);
const clear = (el) => { while (el.firstChild) el.firstChild.remove(); return el; };
const ICON = {
  spark: '<path d="M12 3l1.8 4.6L18 9.4l-4.2 1.8L12 16l-1.8-4.8L6 9.4l4.2-1.8z"/><path d="M19 15l.8 2 2 .8-2 .8-.8 2-.8-2-2-.8 2-.8z"/>',
  history: '<path d="M3 12a9 9 0 1 0 3-6.7"/><path d="M3 4v4h4"/><path d="M12 7v5l3 2"/>',
  graph: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/><path d="M10 6.5h4a3 3 0 0 1 3 3V14"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
  moon: '<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/>',
  gear: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
  help: '<circle cx="12" cy="12" r="9"/><path d="M9.5 9a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .9-1 1.6v.6"/><path d="M12 17h.01"/>',
  image: '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="9" cy="9" r="2"/><path d="M21 15l-5-5L5 21"/>',
  sliders: '<path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6"/>',
  chevron: '<path d="M9 6l6 6-6 6"/>',
  refresh: '<path d="M21 12a9 9 0 1 1-2.6-6.4"/><path d="M21 3v6h-6"/>',
  trash: '<path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/>',
  dice: '<rect x="3" y="3" width="18" height="18" rx="3"/><circle cx="8" cy="8" r="1.2"/><circle cx="16" cy="16" r="1.2"/><circle cx="16" cy="8" r="1.2"/><circle cx="8" cy="16" r="1.2"/><circle cx="12" cy="12" r="1.2"/>',
  x: '<path d="M6 6l12 12M18 6L6 18"/>',
  play: '<path d="M7 4l13 8-13 8z"/>',
  download: '<path d="M12 3v12M7 10l5 5 5-5M4 21h16"/>',
  copy: '<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/>',
  power: '<path d="M12 2v10"/><path d="M18.4 6.6a9 9 0 1 1-12.8 0"/>',
  bolt: '<path d="M13 2L4 14h7l-1 8 9-12h-7z"/>',
};
const icon = (name, size = 16) => {
  const s = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  s.setAttribute("viewBox", "0 0 24 24"); s.setAttribute("width", size); s.setAttribute("height", size);
  s.setAttribute("fill", "none"); s.setAttribute("stroke", "currentColor"); s.setAttribute("stroke-width", "1.8");
  s.setAttribute("stroke-linecap", "round"); s.setAttribute("stroke-linejoin", "round"); s.setAttribute("aria-hidden", "true");
  s.innerHTML = ICON[name] || "";
  return s;
};
const fmtDur = (s) => {
  if (!(s >= 0)) return "";
  s = Math.round(s);
  if (s < 60) return `${s} 秒`;
  const m = Math.floor(s / 60), r = s % 60;
  return r ? `${m} 分 ${r} 秒` : `${m} 分钟`;
};
const fmtTime = (t) => {
  const d = new Date(t), now = new Date();
  const hm = d.toTimeString().slice(0, 5);
  if (d.toDateString() === now.toDateString()) return `今天 ${hm}`;
  return `${d.getMonth() + 1}月${d.getDate()}日 ${hm}`;
};
const fmtBytes = (b) => (b > 1e9 ? `${(b / 1e9).toFixed(1)} GB` : b > 1e6 ? `${(b / 1e6).toFixed(1)} MB` : `${Math.round(b / 1e3)} KB`);
const aspectKey = (a) => (/^(\d+:\d+)/.exec(a || "") || [])[1] || a;
const aspectLabel = (a) => ASPECT_ZH[aspectKey(a)] || a;
const randomSeed = () => Math.floor(Math.random() * 2 ** 48);
const uid = () => Math.random().toString(36).slice(2, 10);

// ───────────────────────── persistence ─────────────────────────
const LS = "kit.studio.v1";
const settings = Object.assign({ theme: "dark", gateBase: "http://localhost:8080", autoDownload: false, hidden: false,
  stats: {} }, (() => { try { return JSON.parse(localStorage.getItem(LS) || "{}"); } catch { return {}; } })());
const saveSettings = () => { try { localStorage.setItem(LS, JSON.stringify(settings)); } catch { /* private mode */ } };

const db = {
  _p: null,
  open() {
    if (!this._p) {
      this._p = new Promise((res, rej) => {
        const r = indexedDB.open("kit-studio", 1);
        r.onupgradeneeded = () => { r.result.createObjectStore("jobs", { keyPath: "id" }); r.result.createObjectStore("blobs"); };
        r.onsuccess = () => res(r.result);
        r.onerror = () => rej(r.error);
      }).catch((e) => { console.warn("[studio] IndexedDB unavailable", e); return null; });
    }
    return this._p;
  },
  async tx(store, mode, fn) {
    const d = await this.open();
    if (!d) return undefined;
    return new Promise((res, rej) => {
      const t = d.transaction(store, mode);
      const out = fn(t.objectStore(store));
      t.oncomplete = () => res(out && "result" in out ? out.result : undefined);
      t.onerror = () => rej(t.error);
      t.onabort = () => rej(t.error);
    });
  },
  allJobs() { return this.tx("jobs", "readonly", (s) => s.getAll()).then((r) => r || []); },
  // fields starting with "_" are page-lifetime state (live progress, an in-flight copy) and must not persist
  putJob(j) {
    const rest = Object.fromEntries(Object.entries(j).filter(([k]) => !k.startsWith("_")));
    return this.tx("jobs", "readwrite", (s) => s.put(rest)).catch((e) => console.warn("[studio] save job", e));
  },
  delJob(id) { return this.tx("jobs", "readwrite", (s) => s.delete(id)); },
  getBlob(k) { return this.tx("blobs", "readonly", (s) => s.get(k)); },
  putBlob(k, b) { return this.tx("blobs", "readwrite", (s) => s.put(b, k)); },
  delBlob(k) { return this.tx("blobs", "readwrite", (s) => s.delete(k)); },
};

// ───────────────────────── server access ─────────────────────────
const kit = { info: null, byMode: {} };
const gate = { mode: "unknown", status: null, lastPing: 0 };
const objInfo = new Map();

async function json(url, init) {
  const r = await fetch(url, { cache: "no-store", ...init });
  if (!r.ok) throw Object.assign(new Error(`${url} → HTTP ${r.status}`), { status: r.status, response: r });
  return r.json();
}

async function nodeDef(cls, fresh = false) {
  if (!fresh && objInfo.has(cls)) return objInfo.get(cls);
  const d = (await json(`/object_info/${encodeURIComponent(cls)}`))[cls] || null;
  objInfo.set(cls, d);
  return d;
}

function comboOptions(def, key) {
  const spec = (def && ((def.input.required || {})[key] || (def.input.optional || {})[key])) || null;
  if (!spec) return null;
  if (Array.isArray(spec[0])) return spec[0];
  if (spec[0] === "COMBO" && spec[1] && Array.isArray(spec[1].options)) return spec[1].options;
  return null;
}

async function detectGate() {
  try {
    const r = await fetch("/_gate/status", { cache: "no-store" });
    if (r.ok && (r.headers.get("content-type") || "").includes("json")) {
      const s = await r.json();
      if (s && s.state) { gate.mode = "same"; gate.status = s; return; }
    }
  } catch { /* not behind the gate */ }
  gate.mode = "remote";
}

/** Tell the gate someone is using the GPU, so auto-stop does not release it mid-render. Through a tunnel the
 * gate sees no open page, and its page_closed rule stops the GPU after just 60 s without activity, so ping every
 * 30 s while a job is active or the page was used in the last 10 minutes. */
const PING_MS = 30000;
const ACTIVE_WINDOW_MS = 10 * 60 * 1000;
function keepAlive(force = false) {
  const now = Date.now();
  if (!force && now - gate.lastPing < PING_MS) return;
  gate.lastPing = now;
  fetch("/kit/heartbeat", { cache: "no-store" }).catch(() => {});
  if (gate.mode === "remote" && settings.gateBase) {
    fetch(settings.gateBase.replace(/\/$/, "") + "/queue", { mode: "no-cors", cache: "no-store" }).catch(() => {});
  }
}

/** Through a tunnel, tell the gate this page is open (counts like its own tab for page_closed, but is not activity,
 * so an open page you stopped using still idles out). Behind the gate, ComfyUI's websocket already counts. */
const TAB_ID = uid() + uid();
function presence() {
  if (gate.mode !== "remote" || !settings.gateBase) return;
  fetch(`${settings.gateBase.replace(/\/$/, "")}/_gate/presence?cid=studio-${TAB_ID}`, { mode: "no-cors", cache: "no-store" }).catch(() => {});
}

/** setInterval that keeps its pace in a background tab: Chrome throttles a hidden page's timers to about once a
 * minute after 5 minutes, which is slower than the gate's 60-second page_closed window. A dedicated worker's
 * timers are not throttled that way, so the worker ticks and the page does the work. */
function everyUnthrottled(ms, fn) {
  try {
    const src = `let t; onmessage = (e) => { clearInterval(t); t = setInterval(() => postMessage(0), e.data); };`;
    const w = new Worker(URL.createObjectURL(new Blob([src], { type: "text/javascript" })));
    w.onmessage = () => { try { fn(); } catch (e) { console.warn("[studio] tick", e); } };
    w.postMessage(ms);
    return;
  } catch (e) { console.warn("[studio] worker timer unavailable, falling back to setInterval", e); }
  setInterval(fn, ms);
}

async function gatePost(path, body) {
  if (gate.mode === "same") {
    const r = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body || {}) });
    let data = {};
    try { data = await r.json(); } catch { /* empty */ }
    if (!r.ok) throw new Error(data.message || `HTTP ${r.status}`);
    return data;
  }
  // through a tunnel the gate is another origin without CORS: fire-and-forget (the gate parses the JSON body
  // whatever its content type), then watch the effect from this side
  await fetch(settings.gateBase.replace(/\/$/, "") + path, { method: "POST", mode: "no-cors", body: JSON.stringify(body || {}),
    headers: { "Content-Type": "text/plain" } });
  return { opaque: true };
}

// templates: one graphToPrompt per mode per page (each load opens a "Studio · …" tab in the graph view)
const templates = {};
let loadChain = Promise.resolve();
function template(mode) {
  if (!templates[mode]) {
    const p = loadChain.catch(() => {}).then(() => loadTemplate(mode));
    loadChain = p;
    templates[mode] = p.catch((e) => { delete templates[mode]; throw e; });
  }
  return templates[mode];
}
async function loadTemplate(mode) {
  const w = kit.byMode[mode];
  if (!w) throw new Error(`这个配置没有「${MODE_LABEL[mode]}」工作流`);
  const wf = await json(`/kit/workflows/${encodeURIComponent(w.file)}`);
  for (let attempt = 0; attempt < 2; attempt++) {
    const output = await convert(wf, `Studio · ${MODE_LABEL[mode]}`);
    try {
      const d = P.describe(output);
      const ok = (mode === "t2v" || mode === "i2v") ? !d.hasRefs : d.hasRefs && (mode !== "keyframes" || d.guides > 0);
      if (ok) return output;
    } catch { /* another load raced ours; retry once */ }
  }
  throw new Error(`工作流「${w.title}」不是预期的 MiniMax-H3 ${MODE_LABEL[mode]}模板`);
}

/** graphToPrompt() of a workflow, without leaving a tab behind (the frontend restores open tabs on reload). */
async function convert(wf, label) {
  const ws = app.extensionManager?.workflow;
  const prev = ws?.activeWorkflow || null;
  const quiet = { skipAssetScans: true, silentAssetErrors: true, deferWarnings: true };
  await app.loadGraphData(wf, true, false, label, quiet);
  const { output } = await app.graphToPrompt();
  try {
    const tmp = ws?.activeWorkflow;
    if (tmp && prev && tmp !== prev && tmp.isTemporary && prev.activeState) {
      await app.loadGraphData(prev.activeState, true, true, prev, quiet);
      await ws.closeWorkflow(tmp);
    }
  } catch (e) { console.warn("[studio] could not close the conversion tab", e); }
  return output;
}

async function outputClasses(prompt) {
  const out = new Set();
  await Promise.all([...new Set(Object.values(prompt).map((n) => n.class_type))].map(async (c) => {
    try { if ((await nodeDef(c))?.output_node) out.add(c); } catch { /* unknown class */ }
  }));
  return out;
}

async function missingModels(prompt) {
  const missing = [];
  const fresh = new Set();
  for (const f of P.modelFiles(prompt)) {
    const def = await nodeDef(f.cls, !fresh.has(f.cls));
    fresh.add(f.cls);
    const opts = comboOptions(def, f.key);
    if (opts && !opts.includes(f.value)) missing.push(f.value);
  }
  return [...new Set(missing)];
}

async function upload(item) {
  if (item.server) return item.server;
  const ext = (item.name.match(/\.[a-z0-9]{1,5}$/i) || [""])[0].toLowerCase() || { image: ".png", video: ".mp4", audio: ".wav" }[item.kind];
  const fd = new FormData();
  fd.append("image", item.file, `studio_${Date.now().toString(36)}_${uid()}${ext}`);
  fd.append("type", "input");
  fd.append("overwrite", "true");
  const r = await fetch("/upload/image", { method: "POST", body: fd });
  if (!r.ok) throw new Error(`上传「${item.name}」失败（HTTP ${r.status}）`);
  const j = await r.json();
  item.server = j.subfolder ? `${j.subfolder}/${j.name}` : j.name;
  return item.server;
}

// ───────────────────────── form state ─────────────────────────
const DRAFT = "kit.studio.draft";
const form = Object.assign({
  prompt: "", speed: "standard", duration: 5, res: "480", aspect: "16:9 (Widescreen)", refOpen: false,
  refMethod: "refs", advOpen: false, seed: "", preview: true, refImageSize: "match",
}, (() => { try { return JSON.parse(localStorage.getItem(DRAFT) || "{}"); } catch { return {}; } })());
Object.assign(form, { firstFrame: null, lastFrame: null, images: [], videos: [], audios: [], anchors: [] });
let draftTimer = 0;
function saveDraft() {
  clearTimeout(draftTimer);
  draftTimer = setTimeout(() => {
    const { firstFrame, lastFrame, images, videos, audios, anchors, ...plain } = form;
    try { localStorage.setItem(DRAFT, JSON.stringify(plain)); } catch { /* ignore */ }
  }, 400);
}

function mediaItem(file, kind, extra = {}) {
  return { id: uid(), file, name: file.name || `${kind}`, kind, url: URL.createObjectURL(file), server: null, ...extra };
}
function dropItem(item) { if (item?.url) URL.revokeObjectURL(item.url); }

function probeDuration(item) {
  if (item.kind === "image") return Promise.resolve();
  return new Promise((res) => {
    const el = document.createElement(item.kind === "video" ? "video" : "audio");
    el.preload = "metadata";
    el.onloadedmetadata = () => { item.seconds = el.duration; if (el.videoWidth) { item.width = el.videoWidth; item.height = el.videoHeight; } res(); };
    el.onerror = () => res();
    el.src = item.url;
  });
}
function probeImage(item) {
  return new Promise((res) => {
    const img = new Image();
    img.onload = () => { item.width = img.naturalWidth; item.height = img.naturalHeight; res(); };
    img.onerror = () => res();
    img.src = item.url;
  });
}

function resolveMode() {
  if (form.refMethod === "frames") {
    if (form.firstFrame) return "i2v";
    if (form.lastFrame) return { error: "首尾帧模式需要先放首帧（尾帧可以留空）" };
    return "t2v";
  }
  if (form.anchors.length) return "keyframes";
  if (form.images.length || form.videos.length || form.audios.length) return "r2v";
  return "t2v";
}

function nearestAspect(w, h) {
  if (!w || !h) return null;
  const r = w / h;
  let best = null, bestD = Infinity;
  for (const a of state.aspects) {
    const m = /^(\d+):(\d+)/.exec(a);
    if (!m) continue;
    const d = Math.abs(Math.log(r / (Number(m[1]) / Number(m[2]))));
    if (d < bestD) { bestD = d; best = a; }
  }
  return best;
}

function tags() {
  return P.referenceTags({ images: form.images, videos: form.videos, audios: form.audios });
}

// ───────────────────────── jobs ─────────────────────────
const jobs = new Map(); // id -> job
const ACTIVE = new Set(["preparing", "queued", "running"]);
const state = { tab: "create", filter: "all", search: "", running: null, queue: { running: [], pending: [] },
  aspects: DEFAULT_ASPECTS.slice(), submitting: false, fetching: null, missing: null, lastFamily: null, lastUse: 0, pollFails: 0 };
const urls = new Map(); // blob key -> object URL
let metaPreview = false; // the frontend sends previews with prompt ids: ignore the bare duplicate

async function blobUrl(key) {
  if (urls.has(key)) return urls.get(key);
  const b = await db.getBlob(key);
  if (!b) return null;
  const u = URL.createObjectURL(b);
  urls.set(key, u);
  return u;
}
function dropUrl(key) { const u = urls.get(key); if (u) { URL.revokeObjectURL(u); urls.delete(key); } }

const viewUrl = (o) => `/view?${new URLSearchParams({ filename: o.filename, subfolder: o.subfolder || "", type: o.type || "output" })}`;

function firstMedia(outputs) {
  for (const out of Object.values(outputs || {})) {
    for (const key of ["videos", "gifs", "images", "animated"]) {
      const list = out && Array.isArray(out[key]) ? out[key] : [];
      for (const f of list) if (f && typeof f === "object" && f.filename) return f;
    }
  }
  return null;
}

function saveJob(job) { db.putJob(job); scheduleRender(); }

let storeChain = Promise.resolve();
function storeOutput(job) {
  if (!job.output || job.blobKey || job._storing || job.expired) return;
  job._storing = true;
  storeChain = storeChain.then(() => keepOutput(job));
}
async function keepOutput(job) {
  try {
    const r = await fetch(viewUrl(job.output), { cache: "no-store" });
    if (!r.ok) { if (r.status === 404) { job.expired = true; saveJob(job); } return; }
    const blob = await r.blob();
    const key = `out:${job.id}`;
    await db.putBlob(key, blob);
    job.blobKey = key;
    job.bytes = blob.size;
    saveJob(job);
    if (settings.autoDownload && !job.autoDownloaded) { job.autoDownloaded = true; downloadJob(job); saveJob(job); }
  } catch (e) {
    console.warn("[studio] keep video", e);
  } finally { job._storing = false; }
}

function learn(job) {
  const m = job.meta;
  if (!job.samplingMs || !m) return;
  const key = `${FAMILY[m.mode]}|${m.res}|${m.speed}`;
  const per = (job.samplingMs / 1000) / Math.max(1, m.duration);
  const s = settings.stats[key] || { per: per, n: 0 };
  s.per = s.n ? (s.per * Math.min(s.n, 4) + per) / (Math.min(s.n, 4) + 1) : per;
  s.n += 1;
  settings.stats[key] = s;
  saveSettings();
}

function finish(job, status, extra = {}, quiet = false) {
  if (!ACTIVE.has(job.status) && job.status !== "lost") return;
  Object.assign(job, { status, endedAt: job.endedAt || Date.now() }, extra);
  if (job._live?.preview) { URL.revokeObjectURL(job._live.preview); job._live.preview = null; }
  if (status === "done") {
    state.lastFamily = FAMILY[job.meta?.mode] || state.lastFamily;
    if (job._live?.samplingStart && job._live?.samplingEnd) job.samplingMs = job._live.samplingEnd - job._live.samplingStart;
    learn(job);
    storeOutput(job);
    if (!quiet) toast(`视频已生成：${(job.meta?.prompt || "").slice(0, 24)}…`, "ok");
  } else if (status === "failed" && !quiet) {
    toast(`生成失败：${job.error || "未知错误"}`, "err", 8000);
  }
  if (state.running === job.id) state.running = null;
  saveJob(job);
}

function friendlyError(msg = "", type = "") {
  const m = `${type} ${msg}`;
  if (/out of memory|OutOfMemory|CUDA error: out of memory/i.test(m)) return "显存不足：试试降低清晰度、缩短时长，或减少参考素材";
  if (/outside the video's|does not fit in the video/i.test(m)) return "固定画面的时间点超出了视频时长";
  if (/at least 5 frames/i.test(m)) return "参考视频太短（至少 0.2 秒）";
  if (/Invalid (image|video|audio) file|not found/i.test(m)) return "素材文件在 GPU 上找不到了（可能 GPU 重启过），请重新生成一次";
  return (msg || type || "未知错误").trim().split("\n")[0].slice(0, 300);
}

async function finalizeFromHistory(job, entry, quiet = false) {
  const st = entry.status || {};
  if (st.status_str === "success" || st.completed) {
    const out = firstMedia(entry.outputs);
    const msgs = st.messages || [];
    const t0 = (msgs.find((x) => x[0] === "execution_start") || [])[1]?.timestamp;
    const t1 = (msgs.find((x) => x[0] === "execution_success") || [])[1]?.timestamp;
    finish(job, out ? "done" : "failed", out ? { output: out, startedAt: job.startedAt || t0, endedAt: t1 || Date.now() }
      : { error: "工作流完成了但没有输出视频" }, quiet);
  } else if (st.status_str === "error") {
    const msgs = st.messages || [];
    const err = (msgs.find((x) => x[0] === "execution_error") || [])[1];
    const intr = msgs.find((x) => x[0] === "execution_interrupted");
    if (intr && (job._userCancel || quiet)) finish(job, "cancelled", {}, quiet);
    else if (intr) finish(job, "lost", { error: "生成被中断（GPU 可能被自动释放了），可以点「复用」重新生成" });
    else finish(job, "failed", { error: friendlyError(err?.exception_message, err?.exception_type), errorDetail: err ? `${err.node_type}: ${err.exception_message}` : "" }, quiet);
  }
}

async function poll() {
  const active = [...jobs.values()].filter((j) => ACTIVE.has(j.status) && j.status !== "preparing");
  if (!active.length) return;
  keepAlive();
  try {
    const q = await json("/queue");
    state.queue = { running: q.queue_running || [], pending: (q.queue_pending || []).slice().sort((a, b) => a[0] - b[0]) };
    const inQueue = new Set([...state.queue.running, ...state.queue.pending].map((x) => x[1]));
    for (const job of active) {
      const run = state.queue.running.some((x) => x[1] === job.id);
      if (run && job.status === "queued") { job.status = "running"; job.startedAt = job.startedAt || Date.now(); state.running = job.id; saveJob(job); }
      if (inQueue.has(job.id)) { job._miss = 0; continue; }
      const h = await json(`/history/${encodeURIComponent(job.id)}`);
      if (h[job.id]) await finalizeFromHistory(job, h[job.id]);
      else if ((job._miss = (job._miss || 0) + 1) >= 2) finish(job, "lost", { error: "任务不在 GPU 上了（GPU 可能被释放或重启过）" });
    }
    state.pollFails = 0;
  } catch (e) {
    console.warn("[studio] poll", e);
    if (++state.pollFails === 2) toast("连不上 GPU 了：隧道断开，或 GPU 已被释放。重新开机并连上后刷新本页即可，记录不会丢。", "err", 12000);
  }
  scheduleRender();
}

async function syncHistory() {
  try {
    const [hist, q] = await Promise.all([json("/history?max_items=200"), json("/queue")]);
    const queued = [...(q.queue_running || []).map((x) => [x, "running"]), ...(q.queue_pending || []).map((x) => [x, "queued"])];
    for (const [item, st] of queued) {
      const meta = item[3]?.kit_studio;
      if (!meta || jobs.has(item[1])) continue;
      jobs.set(item[1], { id: item[1], number: item[0], status: st, meta, refs: meta.refs || [], createdAt: meta.createdAt || Date.now(), classes: classMap(item[2]) });
    }
    for (const [id, entry] of Object.entries(hist)) {
      const meta = entry.prompt?.[3]?.kit_studio;
      if (!meta) continue;
      let job = jobs.get(id);
      const imported = !job;
      if (!job) {
        job = { id, number: entry.prompt[0], status: "running", meta, refs: meta.refs || [], createdAt: meta.createdAt || Date.now(), classes: classMap(entry.prompt[2]) };
        jobs.set(id, job);
      }
      if (ACTIVE.has(job.status) || job.status === "lost") await finalizeFromHistory(job, entry, imported);
      if (job.status === "done" && !job.blobKey) storeOutput(job);
    }
    for (const job of jobs.values()) db.putJob(job);
  } catch (e) { console.warn("[studio] history sync", e); }
  scheduleRender();
}

function classMap(prompt) {
  const m = {};
  for (const [id, n] of Object.entries(prompt || {})) m[id] = n.class_type;
  return m;
}

function phaseFor(cls) {
  if (!cls) return "处理中";
  if (/Loader|LoadImage|LoadVideo|LoadAudio/.test(cls)) return "加载模型和素材";
  if (/MiniMaxH3|AddGuide/.test(cls)) return "理解提示词和参考素材";
  if (/Sampler/.test(cls)) return "生成画面";
  if (/VAEDecodeAudio/.test(cls)) return "合成声音";
  if (/VAEDecode/.test(cls)) return "解码画面";
  if (/CreateVideo|SaveVideo/.test(cls)) return "保存视频";
  return "处理中";
}

function onEvent(type, d) {
  const pid = d && typeof d === "object" ? d.prompt_id : null;
  if (type === "execution_start" && pid) {
    state.running = pid;
    const job = jobs.get(pid);
    if (job && ACTIVE.has(job.status)) { job.status = "running"; job.startedAt = Date.now(); job._live = job._live || {}; saveJob(job); }
    return;
  }
  const job = jobs.get(pid || state.running);
  if (!job) return;
  job._live = job._live || {};
  if (type === "executing") {
    const node = typeof d === "string" ? d : d?.display_node || d?.node;
    if (node == null) return;
    job._live.phase = phaseFor(job.classes?.[node]);
    if (job._live.samplingStart && !job._live.samplingEnd && !/Sampler/.test(job.classes?.[node] || "")) job._live.samplingEnd = Date.now();
    scheduleRender();
  } else if (type === "progress") {
    const cls = job.classes?.[d.node] || "";
    if (/Sampler/.test(cls) || !cls) {
      if (!job._live.samplingStart) job._live.samplingStart = Date.now() - 1;
      job._live.step = d.value; job._live.steps = d.max;
      job._live.phase = "生成画面";
    }
    scheduleRender();
  } else if (type === "executed") {
    const out = firstMedia({ x: d.output });
    if (out) job.output = out;
  } else if (type === "execution_success") {
    if (!job._live.samplingEnd && job._live.samplingStart) job._live.samplingEnd = Date.now();
    if (job.output) finish(job, "done");
    else json(`/history/${encodeURIComponent(job.id)}`).then((h) => h[job.id] && finalizeFromHistory(job, h[job.id])).catch(() => {});
  } else if (type === "execution_error") {
    finish(job, "failed", { error: friendlyError(d.exception_message, d.exception_type), errorDetail: `${d.node_type}: ${d.exception_message}` });
  } else if (type === "execution_interrupted") {
    if (job._userCancel) finish(job, "cancelled");
    else finish(job, "lost", { error: "生成被中断（GPU 可能被自动释放了），可以点「复用」重新生成" });
  }
}

function onPreview(blob, meta) {
  if (!form.preview) return;
  const job = jobs.get(meta?.promptId || meta?.prompt_id || state.running);
  if (!job || job.status !== "running") return;
  job._live = job._live || {};
  if (job._live.preview) URL.revokeObjectURL(job._live.preview);
  job._live.preview = URL.createObjectURL(blob);
  const img = document.querySelector(`[data-job="${job.id}"] .ks-live`);
  if (img) img.src = job._live.preview;
}

// ───────────────────────── generate ─────────────────────────
function validate() {
  const errs = [];
  const mode = resolveMode();
  if (mode.error) errs.push(mode.error);
  if (!form.prompt.trim()) errs.push("先写一段画面描述");
  const d = Number(form.duration);
  if (!(d >= 1 && d <= 20)) errs.push("时长要在 1–20 秒之间");
  if (typeof mode === "string" && !kit.byMode[mode]) errs.push(`当前 GPU 配置没有「${MODE_LABEL[mode]}」工作流`);
  if (mode === "keyframes") {
    const frames = P.framesFor(d);
    for (const a of form.anchors) {
      const t = Number(a.time);
      if (!(t >= 0)) { errs.push("每个固定画面都要填时间点"); break; }
      const at = P.pyRound(t * P.FPS);
      let need = 1;
      if (a.anchorKind === "clip" && a.seconds) {
        need = Math.round(a.seconds * P.FPS);
        need = need < 5 ? 1 : need - (((need % 17) - 5 + 17) % 17);
      }
      if (a.anchorKind === "audio" ? at >= frames : at + need > frames) { errs.push(`固定画面 @${t}s 超出了视频时长`); break; }
    }
  }
  return { mode, errs };
}

async function generate() {
  if (state.submitting) return;
  const { mode, errs } = validate();
  if (errs.length) { toast(errs[0], "err"); return; }
  state.submitting = true;
  state.missing = null;
  renderCreateFooter();
  const seed = form.seed === "" || form.seed == null ? randomSeed() : Math.max(0, Math.floor(Number(form.seed)));
  try {
    setFooterStatus("正在准备工作流…");
    const tpl = await template(mode);
    setFooterStatus("正在上传素材…");
    const up = async (it) => (it ? upload(it) : null);
    const isVid = (it) => it.kind === "video";
    const params = {
      mode, prompt: form.prompt, duration: Number(form.duration), aspect: form.aspect,
      megapixels: (RES.find((r) => r.key === form.res) || RES[0]).mp, seed, turbo: form.speed === "turbo",
      refImageSize: form.refImageSize,
    };
    if (mode === "i2v") { params.firstFrame = await up(form.firstFrame); params.lastFrame = await up(form.lastFrame); }
    if (mode === "r2v" || mode === "keyframes") {
      params.images = [];
      for (const it of form.images) params.images.push(await up(it));
      params.videos = [];
      for (const it of form.videos) params.videos.push({ name: await up(it), useAudio: !!it.useAudio });
      params.audios = [];
      for (const it of form.audios) params.audios.push({ name: await up(it), isVideo: isVid(it) });
    }
    if (mode === "keyframes") {
      params.anchors = [];
      for (const it of form.anchors) params.anchors.push({ kind: it.anchorKind, name: await up(it), isVideo: isVid(it), time: Number(it.time) });
    }
    const { prompt, warnings } = P.buildPrompt(tpl, params, { outputClasses: await outputClasses(tpl) });
    warnings.forEach((w) => console.warn("[studio]", w));
    const missing = await missingModels(prompt);
    if (missing.length) {
      state.missing = { mode, files: missing };
      toast("这个模式需要的模型还没下载到 GPU 上", "err");
      return;
    }
    const refs = await persistRefs(mode);
    const meta = {
      v: VERSION, mode, prompt: form.prompt, speed: form.speed, duration: Number(form.duration), res: form.res,
      aspect: form.aspect, seed, refImageSize: form.refImageSize, createdAt: Date.now(),
      refs: refs.map(({ blobKey, ...r }) => r),
    };
    setFooterStatus("正在提交到 GPU…");
    const r = await fetch("/prompt", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt, client_id: api.clientId, extra_data: { kit_studio: meta } }) });
    const body = await r.json().catch(() => ({}));
    if (!r.ok || !body.prompt_id) {
      if (JSON.stringify(body).match(/Invalid (image|video|audio) file/)) for (const it of allMedia()) it.server = null;
      throw new Error(promptError(body) || `提交失败（HTTP ${r.status}）`);
    }
    const job = { id: body.prompt_id, number: body.number, status: "queued", meta, refs, createdAt: meta.createdAt,
      classes: classMap(prompt), _live: {} };
    jobs.set(job.id, job);
    saveJob(job);
    keepAlive(true);
    if (form.seed === "" || form.seed == null) form.lastSeed = seed;
    state.tab = "records";
    state.filter = "all";
    render();
    setTimeout(poll, 1500);
  } catch (e) {
    console.error("[studio] generate", e);
    toast(e.message || String(e), "err", 9000);
  } finally {
    state.submitting = false;
    renderCreateFooter();
  }
}

function promptError(body) {
  const ne = body.node_errors || {};
  const parts = [];
  for (const v of Object.values(ne)) {
    for (const e of v.errors || []) parts.push(`${v.class_type}: ${e.details || e.message}`);
  }
  const head = body.error?.message || body.error || "";
  if (parts.some((p) => /not in list|value_not_in_list/i.test(p))) return `${head} 模型或素材文件缺失：${parts.join("；")}`;
  return [head, ...parts].filter(Boolean).join("；").slice(0, 400);
}

function allMedia() {
  return [form.firstFrame, form.lastFrame, ...form.images, ...form.videos, ...form.audios, ...form.anchors].filter(Boolean);
}

async function digest(blob) {
  try {
    const buf = await crypto.subtle.digest("SHA-256", await blob.arrayBuffer());
    return [...new Uint8Array(buf)].slice(0, 16).map((b) => b.toString(16).padStart(2, "0")).join("");
  } catch { return uid() + uid(); }
}

/** Keep the inputs of a run in IndexedDB, so "复用" works after the GPU (and its disk) is gone. */
async function persistRefs(mode) {
  const out = [];
  const t = tags();
  const push = async (it, role, extra = {}) => {
    if (!it) return;
    let blobKey = null;
    if (it.file.size <= 300 * 1024 * 1024) {
      blobKey = it.blobKey || `ref:${await digest(it.file)}`;
      it.blobKey = blobKey;
      if (!(await db.getBlob(blobKey))) await db.putBlob(blobKey, it.file);
    }
    out.push({ role, kind: it.kind, name: it.name, type: it.file.type, blobKey, ...extra });
  };
  if (mode === "i2v") { await push(form.firstFrame, "first"); await push(form.lastFrame, "last"); }
  if (mode === "r2v" || mode === "keyframes") {
    for (const [i, it] of form.images.entries()) await push(it, "image", { tag: t.images[i] });
    for (const [i, it] of form.videos.entries()) await push(it, "video", { tag: t.videos[i], audioTag: t.videoAudios[i], useAudio: !!it.useAudio });
    for (const [i, it] of form.audios.entries()) await push(it, "audio", { tag: t.audios[i] });
  }
  if (mode === "keyframes") for (const it of form.anchors) await push(it, "anchor", { anchorKind: it.anchorKind, time: Number(it.time) });
  return out;
}

async function cancelJob(job) {
  job._userCancel = true;
  try {
    if (job.status === "running") await fetch("/interrupt", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ prompt_id: job.id }) });
    else await fetch("/queue", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ delete: [job.id] }) });
    if (job.status !== "running") finish(job, "cancelled");
  } catch (e) { toast(`取消失败：${e.message}`, "err"); }
}

async function deleteJobs(list) {
  const doomed = new Set(list.map((j) => j.id));
  const keep = [...jobs.values()].filter((j) => !doomed.has(j.id));
  const stillUsed = new Set(keep.flatMap((j) => (j.refs || []).map((r) => r.blobKey)).filter(Boolean));
  for (const job of list) {
    if (ACTIVE.has(job.status)) await cancelJob(job);
    if (job.blobKey) { dropUrl(job.blobKey); await db.delBlob(job.blobKey).catch(() => {}); }
    for (const r of job.refs || []) if (r.blobKey && !stillUsed.has(r.blobKey)) { dropUrl(r.blobKey); await db.delBlob(r.blobKey).catch(() => {}); }
    await db.delJob(job.id).catch(() => {});
    jobs.delete(job.id);
    cards.get(job.id)?.remove();
    cards.delete(job.id);
  }
  fetch("/history", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ delete: list.map((j) => j.id) }) }).catch(() => {});
  render();
}

async function downloadJob(job) {
  const href = job.blobKey ? await blobUrl(job.blobKey) : job.output && !job.expired ? viewUrl(job.output) : null;
  if (!href) { toast("这个视频已经不在了", "err"); return; }
  const ext = (job.output?.filename.match(/\.[a-z0-9]+$/i) || [".mp4"])[0];
  const a = h("a", { href, download: `studio_${new Date(job.createdAt).toISOString().slice(0, 19).replace(/[T:]/g, "-")}${ext}` });
  document.body.append(a); a.click(); a.remove();
}

async function reuse(job, seedOnly = false) {
  const m = job.meta || {};
  if (seedOnly) {
    form.seed = String(m.seed ?? "");
    form.advOpen = true;
    saveDraft();
    state.tab = "create";
    render();
    toast(`已填入种子 ${m.seed}：同样的设置会得到相同的运动`, "ok");
    return;
  }
  Object.assign(form, { prompt: m.prompt || "", speed: m.speed || "standard", duration: m.duration || 5, res: m.res || "480",
    aspect: m.aspect || form.aspect, refImageSize: m.refImageSize || "match" });
  for (const it of allMedia()) dropItem(it);
  Object.assign(form, { firstFrame: null, lastFrame: null, images: [], videos: [], audios: [], anchors: [] });
  let lost = 0;
  for (const r of job.refs || []) {
    const blob = r.blobKey ? await db.getBlob(r.blobKey) : null;
    if (!blob) { lost++; continue; }
    const file = new File([blob], r.name, { type: r.type || blob.type });
    const it = mediaItem(file, r.kind);
    it.blobKey = r.blobKey;
    await probeDuration(it);
    if (r.role === "first") form.firstFrame = it;
    else if (r.role === "last") form.lastFrame = it;
    else if (r.role === "image") form.images.push(it);
    else if (r.role === "video") { it.useAudio = !!r.useAudio; form.videos.push(it); }
    else if (r.role === "audio") form.audios.push(it);
    else if (r.role === "anchor") { it.anchorKind = r.anchorKind; it.time = r.time; form.anchors.push(it); }
  }
  form.refMethod = m.mode === "i2v" ? "frames" : "refs";
  form.refOpen = (job.refs || []).length > 0;
  saveDraft();
  state.tab = "create";
  render();
  toast(lost ? `已载入参数（${lost} 个素材没有保存在本机，需要重新添加）` : "已载入这条记录的全部参数和素材", lost ? "warn" : "ok");
}

// ───────────────────────── rendering ─────────────────────────
let root, createPane, recordsPane, footer, renderQueued = false;
const cards = new Map();

function scheduleRender() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => { renderQueued = false; renderTabs(); renderHeaderStatus(); if (state.tab === "records") renderRecords(); else renderCreateFooter(); });
}

function render() {
  root.dataset.theme = settings.theme;
  renderTabs();
  renderHeaderStatus();
  createPane.hidden = state.tab !== "create";
  recordsPane.hidden = state.tab !== "records";
  if (state.tab === "create") renderCreate(); else renderRecords();
}

function toast(msg, kind = "info", ms = 4500) {
  const host = $("#ks-toasts") || document.body.appendChild(h("div", { id: "ks-toasts", class: "ks-toasts", role: "status", "aria-live": "polite" }));
  const t = h("div", { class: `ks-toast ks-${kind}` }, msg);
  host.append(t);
  setTimeout(() => { t.classList.add("ks-out"); setTimeout(() => t.remove(), 300); }, ms);
}

function tip(text) {
  return h("span", { class: "ks-tip", tabindex: "0", role: "note", "aria-label": text, "data-tip": text }, "?");
}

function buildShell() {
  root = h("div", { id: "kit-studio", class: "ks-root", "data-theme": settings.theme });
  const top = h("header", { class: "ks-top" },
    h("div", { class: "ks-brand" }, h("span", { class: "ks-logo" }, icon("play", 14)), h("span", null, "Colab 视频工作室")),
    h("div", { class: "ks-top-right" },
      h("div", { class: "ks-status", id: "ks-status" }),
      h("button", { class: "ks-iconbtn", title: "使用说明", "aria-label": "使用说明", onclick: showHelp }, icon("help", 18)),
      h("button", { class: "ks-iconbtn", title: "设置", "aria-label": "设置", onclick: showSettings }, icon("gear", 18)),
      h("button", { class: "ks-iconbtn", id: "ks-theme", title: "切换明暗", "aria-label": "切换明暗主题", onclick: () => {
        settings.theme = settings.theme === "dark" ? "light" : "dark"; saveSettings(); root.dataset.theme = settings.theme; paintTheme();
      } })));
  const main = h("main", { class: "ks-main" },
    h("div", { class: "ks-head" },
      h("h1", null, "视频生成"),
      h("button", { class: "ks-btn ks-ghost", onclick: () => setHidden(true), title: "打开 ComfyUI 节点图（高级）" }, icon("graph"), "打开节点图")),
    h("div", { class: "ks-tabs", role: "tablist", id: "ks-tabs" }),
    createPane = h("section", { class: "ks-card", id: "ks-create", "aria-label": "视频创作参数" }),
    recordsPane = h("section", { class: "ks-card", id: "ks-records", "aria-label": "生成记录", hidden: true }));
  root.append(top, main);
  document.body.append(root);
  const fab = h("button", { id: "kit-studio-fab", class: "ks-fab", onclick: () => setHidden(false), title: "回到视频工作室" }, icon("play", 14), "视频工作室");
  document.body.append(fab);
  paintTheme();
  // ComfyUI's global shortcuts (Ctrl+Enter queues the graph behind us!), paste and drop handlers must not see
  // what happens inside the studio
  root.addEventListener("keydown", (e) => {
    if (e.key === "Escape") $(".ks-dialog-wrap", root)?.remove();
    e.stopPropagation();
  });
  for (const ev of ["keyup", "keypress", "paste", "copy", "cut"]) root.addEventListener(ev, (e) => e.stopPropagation());
  root.addEventListener("dragover", (e) => { e.preventDefault(); e.stopPropagation(); });
  root.addEventListener("drop", onDrop);
  for (const ev of ["pointerdown", "keydown"]) root.addEventListener(ev, () => { state.lastUse = Date.now(); keepAlive(); }, { passive: true });
}

async function onDrop(e) {
  e.preventDefault();
  e.stopPropagation();
  const zone = e.target.closest?.("[data-drop]")?.dataset.drop;
  const files = [...(e.dataTransfer?.files || [])];
  if (!zone || !files.length) { if (files.length) toast("把文件拖到「参考素材」里的格子上", "info"); return; }
  if (zone === "firstFrame" || zone === "lastFrame") {
    const f = files.find((x) => kindOf(x) === "image");
    if (!f) { toast("首尾帧只能放图片", "err"); return; }
    await setFrame(zone, f);
  } else await addFiles(files.filter((f) => zone === "anchors" || kindOf(f) === { images: "image", videos: "video" }[zone] || (zone === "audios" && kindOf(f) !== "image")), zone);
}

function paintTheme() {
  const b = $("#ks-theme", root);
  if (b) clear(b).append(icon(settings.theme === "dark" ? "sun" : "moon", 18));
}

function setHidden(v) {
  settings.hidden = v;
  saveSettings();
  root.hidden = v;
  document.body.classList.toggle("kit-studio-open", !v);
  $("#kit-studio-fab").hidden = !v;
  if (!v) render();
}

function renderTabs() {
  const el = $("#ks-tabs", root);
  if (!el) return;
  const active = [...jobs.values()].filter((j) => ACTIVE.has(j.status)).length;
  clear(el).append(
    h("button", { role: "tab", class: `ks-tab${state.tab === "create" ? " on" : ""}`, "aria-selected": String(state.tab === "create"),
      onclick: () => { state.tab = "create"; render(); } }, icon("spark"), "创作"),
    h("button", { role: "tab", class: `ks-tab${state.tab === "records" ? " on" : ""}`, "aria-selected": String(state.tab === "records"),
      onclick: () => { state.tab = "records"; render(); } }, icon("history"), "生成记录",
      active ? h("span", { class: "ks-dot" }, String(active)) : null));
}

function renderHeaderStatus() {
  const el = $("#ks-status", root);
  if (!el) return;
  clear(el);
  if (gate.mode === "same" && gate.status) {
    const s = gate.status;
    const left = s.remaining_s != null ? `剩余 ${Math.max(0, Math.floor(s.remaining_s / 60))} 分钟` : "运行中";
    el.append(h("span", { class: `ks-pill${s.warn ? " ks-warnpill" : ""}`, title: "GPU 会在空闲或到时后自动释放" },
      h("span", { class: "ks-led" }), `GPU ${left}`));
    if (s.cu && s.cu.today != null) el.append(h("span", { class: "ks-pill ks-muted", title: "今天已用的 Colab 计算单元" }, `今日 ${Number(s.cu.today).toFixed(1)} CU`));
    if (s.warn && s.can_extend && s.you?.owner !== false) {
      el.append(h("button", { class: "ks-btn ks-small", onclick: async () => {
        try { await gatePost("/_gate/extend"); toast("已延长 1 小时", "ok"); refreshGate(); } catch (e) { toast(e.message, "err"); }
      } }, "+1 小时"));
    }
    if (s.can_stop !== false) {
      el.append(h("button", { class: "ks-iconbtn", title: "释放 GPU（停止计费）", "aria-label": "释放 GPU", onclick: async () => {
        if (!confirm("现在释放 GPU？正在生成的视频会中断，GPU 上的文件会被清空（已完成的视频保存在本浏览器里）。")) return;
        try { await gatePost("/_gate/stop"); location.href = "/"; } catch (e) { toast(e.message, "err"); }
      } }, icon("power", 18)));
    }
  } else if (gate.mode === "remote") {
    el.append(h("span", { class: "ks-pill ks-muted", title: `通过 SSH 隧道连接 GPU。生成期间会每 3 分钟提醒网关（${settings.gateBase}）你还在用，防止自动关机。` },
      h("span", { class: "ks-led" }), "隧道连接"));
  }
}

function field(label, control, opts = {}) {
  return h("div", { class: `ks-field${opts.class ? " " + opts.class : ""}` },
    h("div", { class: "ks-label" }, h("label", opts.for ? { for: opts.for } : null, label), opts.tip ? tip(opts.tip) : null,
      opts.unit ? h("span", { class: "ks-unit" }, opts.unit) : null, opts.right ? h("span", { class: "ks-right" }, opts.right) : null),
    control, opts.hint ? h("div", { class: "ks-hint" }, opts.hint) : null);
}

function select(id, options, value, onchange) {
  const s = h("select", { id, class: "ks-input ks-select", onchange: (e) => onchange(e.target.value) },
    options.map(([v, label]) => h("option", { value: v, selected: v === value }, label)));
  return s;
}

function renderCreate() {
  clear(createPane);
  const mode = resolveMode();
  const textarea = h("textarea", { id: "ks-prompt", class: "ks-input ks-textarea", rows: "6", placeholder: "描述画面、动作、镜头和声音",
    oninput: (e) => { form.prompt = e.target.value; $("#ks-count", createPane).textContent = `${form.prompt.length} 字`; saveDraft(); renderCreateFooter(); },
    onkeydown: (e) => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); generate(); } } });
  textarea.value = form.prompt;
  const chips = h("div", { class: "ks-chips", "aria-label": "提示词灵感" });
  const isRef = mode === "r2v" || mode === "keyframes";
  if (isRef) {
    chips.append(h("button", { class: "ks-chip ks-chip-accent", onclick: insertSkeleton, title: "参考素材在结构化提示词里效果最好" }, icon("spark", 14), "插入结构化模板"));
  }
  INSPIRATIONS.forEach((x, i) => chips.append(h("button", { class: "ks-chip", onclick: () => {
    if (form.prompt.trim() && !confirm("用灵感示例替换当前描述？")) return;
    form.prompt = x.text; textarea.value = x.text; $("#ks-count", createPane).textContent = `${x.text.length} 字`; saveDraft(); renderCreateFooter();
  } }, i === 0 ? icon("spark", 14) : null, x.label)));

  createPane.append(
    h("div", { class: "ks-card-head" }, h("span", { class: "ks-bar" }), h("h2", null, "新建视频"),
      h("span", { class: "ks-modechip", title: "根据你放的参考素材自动选择" }, MODE_LABEL[typeof mode === "string" ? mode : "t2v"])),
    h("div", { class: "ks-card-body" },
      field("画面描述", textarea, { for: "ks-prompt", right: h("span", { id: "ks-count" }, `${form.prompt.length} 字`),
        tip: "写清楚主体、动作、镜头运动（类型、幅度、速度）、光线和声音。按 Ctrl+Enter 直接生成。用了参考素材时，在描述里用 <Picture 1>、<Video 1>、<Audio 1> 指代它们。" }),
      chips,
      h("div", { class: "ks-sep" }),
      h("h3", { class: "ks-sub" }, "生成设置"),
      renderSettingsFields(),
      h("div", { class: "ks-sep" }),
      renderRefSection(mode),
      renderAdvanced()),
    footer = h("div", { class: "ks-footer" }));
  renderCreateFooter();
}

function renderSettingsFields() {
  const wrap = h("div", { class: "ks-grid" });
  wrap.append(field("模型", select("ks-speed", [["standard", "MiniMax H3 · 标准"], ["turbo", "MiniMax H3 · 闪电"]], form.speed, (v) => {
    form.speed = v; saveDraft(); renderCreate();
  }), { for: "ks-speed", class: "ks-span2",
    hint: form.speed === "turbo" ? "Lightning 加速 LoRA，步数少很多、出片快几倍，画面细节和动作稳定性会差一些" : "官方完整步数，画质优先" }));

  const dur = h("input", { id: "ks-dur", class: "ks-input", type: "number", min: "1", max: "20", step: "1", value: String(form.duration),
    oninput: (e) => { form.duration = e.target.value; saveDraft(); paintDur(); renderCreateFooter(); } });
  const seg = h("div", { class: "ks-seg", role: "group", "aria-label": "常用时长" });
  const paintDur = () => {
    clear(seg).append(...DURATIONS.map((d) => h("button", { class: `ks-segbtn${Number(form.duration) === d ? " on" : ""}`, onclick: () => {
      form.duration = d; dur.value = String(d); saveDraft(); paintDur(); renderCreateFooter();
    } }, `${d}s`)));
    const f = P.framesFor(Number(form.duration) || 0);
    const hintEl = $("#ks-durhint", wrap);
    if (hintEl) hintEl.textContent = Number(form.duration) > 15 ? `超过 15 秒属于未验证范围 · 实际 ${f} 帧` : `24 fps · 实际 ${f} 帧（约 ${(f / 24).toFixed(1)} 秒）`;
  };
  wrap.append(h("div", { class: "ks-field" },
    h("div", { class: "ks-label" }, h("label", { for: "ks-dur" }, "时长"), h("span", { class: "ks-unit" }, "秒")),
    dur, seg, h("div", { class: "ks-hint", id: "ks-durhint" })));

  const resSel = select("ks-res", RES.map((r) => [r.key, r.label]), form.res, (v) => { form.res = v; saveDraft(); renderCreate(); });
  const r = resolutionFor();
  wrap.append(field("清晰度", resSel, { for: "ks-res", hint: r ? `${r.width}×${r.height} · ${(RES.find((x) => x.key === form.res) || RES[0]).hint}` : "" }));
  const aspSel = select("ks-aspect", state.aspects.map((a) => [a, aspectLabel(a)]), form.aspect, (v) => { form.aspect = v; saveDraft(); renderCreate(); });
  wrap.append(field("画幅", aspSel, { for: "ks-aspect", class: "ks-span2",
    hint: resolveMode() === "i2v" ? "建议与首帧图片比例一致（放首帧时会自动选择最接近的比例）" : null }));
  queueMicrotask(paintDur);
  return wrap;
}

function resolutionFor() {
  return P.resolutionFor(form.aspect, (RES.find((x) => x.key === form.res) || RES[0]).mp);
}

function collapse(title, iconName, open, onToggle, body, right) {
  const id = `ks-c-${title}`;
  return h("div", { class: `ks-collapse${open ? " open" : ""}` },
    h("button", { class: "ks-collapse-head", "aria-expanded": String(open), "aria-controls": id, onclick: onToggle },
      icon(iconName), h("span", { class: "ks-collapse-title" }, title), right ? h("span", { class: "ks-collapse-right" }, right) : null,
      h("span", { class: "ks-chev" }, icon("chevron"))),
    open ? h("div", { class: "ks-collapse-body", id }, body) : null);
}

function filePicker(accept, multiple, onFiles) {
  const inp = h("input", { type: "file", accept, multiple: multiple || null, hidden: true, onchange: (e) => { onFiles([...e.target.files]); inp.remove(); } });
  document.body.append(inp);
  inp.click();
}

function kindOf(file) {
  if (/^image\//.test(file.type)) return "image";
  if (/^video\//.test(file.type)) return "video";
  if (/^audio\//.test(file.type)) return "audio";
  if (/\.(png|jpe?g|webp|gif|bmp)$/i.test(file.name)) return "image";
  if (/\.(mp4|mov|webm|mkv|m4v|avi)$/i.test(file.name)) return "video";
  if (/\.(mp3|wav|flac|m4a|ogg|opus|aac)$/i.test(file.name)) return "audio";
  return null;
}

function insertTag(tag) {
  const ta = $("#ks-prompt", createPane);
  if (!ta) return;
  const s = ta.selectionStart ?? ta.value.length, e = ta.selectionEnd ?? s;
  ta.value = ta.value.slice(0, s) + tag + ta.value.slice(e);
  ta.focus();
  ta.selectionStart = ta.selectionEnd = s + tag.length;
  form.prompt = ta.value;
  saveDraft();
}

function tagBadge(tag) {
  return tag ? h("button", { class: "ks-tag", title: `点击把 ${tag} 插入描述`, onclick: (e) => { e.stopPropagation(); insertTag(tag); } }, tag) : null;
}

function mediaPreview(it) {
  if (it.kind === "image") return h("img", { src: it.url, alt: it.name, loading: "lazy" });
  if (it.kind === "video") return h("video", { src: it.url, muted: true, preload: "metadata", playsinline: true });
  return h("div", { class: "ks-audio-ico" }, "♪");
}

function tile(it, opts) {
  return h("div", { class: "ks-tile ks-filled", title: it.name },
    mediaPreview(it),
    h("button", { class: "ks-tile-x", "aria-label": `移除 ${it.name}`, onclick: (e) => { e.stopPropagation(); opts.onRemove(); } }, icon("x", 14)),
    opts.badge ? h("div", { class: "ks-tile-badges" }, opts.badge) : null,
    opts.caption ? h("div", { class: "ks-tile-cap" }, opts.caption) : null);
}

function emptyTile(label, onPick, wide) {
  return h("button", { class: `ks-tile ks-empty${wide ? " ks-wide" : ""}`, onclick: onPick }, h("span", { class: "ks-plus" }, "+"), label ? h("span", null, label) : null);
}

function row(it, children, onRemove) {
  return h("div", { class: "ks-row" },
    h("div", { class: "ks-row-media" }, mediaPreview(it)),
    h("div", { class: "ks-row-main" }, h("div", { class: "ks-row-name" }, it.name,
      it.seconds ? h("span", { class: "ks-muted" }, ` · ${it.seconds.toFixed(1)} 秒`) : null), children),
    h("button", { class: "ks-iconbtn", "aria-label": `移除 ${it.name}`, onclick: onRemove }, icon("x", 16)));
}

async function addFiles(files, target) {
  for (const f of files) {
    const kind = kindOf(f);
    if (!kind) { toast(`不支持的文件：${f.name}`, "err"); continue; }
    const list = form[target];
    if (list.length >= LIMITS[target]) { toast(`最多 ${LIMITS[target]} 个`, "warn"); break; }
    const it = mediaItem(f, kind);
    await probeDuration(it);
    if (target === "videos") {
      it.useAudio = false; // wire a soundtrack only when the prompt is going to use its <Audio j>
      if (it.seconds && (it.seconds < 2 || it.seconds > 15)) toast("参考视频建议 2–15 秒（超出视频时长的部分会被截掉）", "warn");
    }
    if (target === "anchors") {
      it.anchorKind = kind === "image" ? "image" : kind === "video" ? "clip" : "audio";
      const used = form.anchors.map((a) => Number(a.time));
      it.time = Math.min(Number(form.duration) || 5, used.length ? Math.max(...used) + 1.5 : 0);
    }
    list.push(it);
  }
  saveDraft();
  renderCreate();
}

async function setFrame(slot, f) {
  dropItem(form[slot]);
  const it = mediaItem(f, "image");
  await probeImage(it);
  form[slot] = it;
  if (slot === "firstFrame") {
    const a = nearestAspect(it.width, it.height);
    if (a && a !== form.aspect) { form.aspect = a; toast(`已按首帧比例选择画幅 ${aspectLabel(a)}`, "info"); }
  }
  saveDraft();
  renderCreate();
}

function renderRefSection(mode) {
  const body = h("div", null);
  body.append(field("生成方式", select("ks-method", [["refs", "参考图片 / 视频 / 声音"], ["frames", "首帧和尾帧"]], form.refMethod, (v) => {
    form.refMethod = v; saveDraft(); renderCreate();
  }), { for: "ks-method" }));
  if (form.refMethod === "frames") {
    const pick = (slot) => filePicker("image/*", false, ([f]) => f && setFrame(slot, f));
    // MiniMaxH3ImageToVideo hands the first frame, then the last frame, to the text encoder as pictures
    const frameTag = (key) => (key === "firstFrame" ? "<Picture 1>" : form.firstFrame ? "<Picture 2>" : null);
    const slot = (key, label) => h("div", { class: "ks-frame", "data-drop": key },
      form[key] ? tile(form[key], { badge: tagBadge(frameTag(key)), onRemove: () => { dropItem(form[key]); form[key] = null; renderCreate(); } })
        : emptyTile("", () => pick(key), true),
      h("div", { class: "ks-frame-label" }, label));
    body.append(field("首尾帧", h("div", { class: "ks-frames" }, slot("firstFrame", "首帧"), slot("lastFrame", "尾帧")),
      { tip: "视频从首帧开始；放了尾帧会尽量停在尾帧的画面。描述里可以用 <Picture 1> 指首帧、<Picture 2> 指尾帧。", right: h("span", { class: "ks-muted" }, "首帧必填 · 尾帧可留空") }));
  } else {
    const t = tags();
    const imgs = h("div", { class: "ks-tiles", "data-drop": "images" },
      form.images.map((it, i) => tile(it, { badge: tagBadge(t.images[i]), onRemove: () => { dropItem(it); form.images.splice(i, 1); renderCreate(); } })),
      form.images.length < LIMITS.images ? emptyTile("", () => filePicker("image/*", true, (fs) => addFiles(fs, "images"))) : null);
    body.append(field("参考图", imgs, { right: h("span", { class: "ks-muted" }, `${form.images.length} / ${LIMITS.images} · 人物、场景长什么样`),
      tip: "人物、物品、场景的样子。按顺序是 <Picture 1>、<Picture 2>…，点角标可以插入描述。" }));

    const vids = h("div", { class: "ks-rows", "data-drop": "videos" },
      form.videos.map((it, i) => row(it, h("div", { class: "ks-row-tags" }, t.videoAudios[i] ? tagBadge(t.videoAudios[i]) : null, tagBadge(t.videos[i]),
        h("label", { class: "ks-check" }, h("input", { type: "checkbox", checked: it.useAudio, onchange: (e) => { it.useAudio = e.target.checked; renderCreate(); } }), "同时参考原声")),
        () => { dropItem(it); form.videos.splice(i, 1); renderCreate(); })),
      form.videos.length < LIMITS.videos ? h("button", { class: "ks-add", onclick: () => filePicker("video/*", true, (fs) => addFiles(fs, "videos")) }, "+ 添加参考视频") : null);
    body.append(field("参考视频", vids, { right: h("span", { class: "ks-muted" }, `${form.videos.length} / ${LIMITS.videos} · 学动作和镜头运动`),
      tip: "2–15 秒。勾选「同时参考原声」时，原声的标签 <Audio j> 排在它的 <Video k> 前面。镜头运动最好同时用文字写清楚（类型、幅度、速度）。" }));

    const auds = h("div", { class: "ks-rows", "data-drop": "audios" },
      form.audios.map((it, i) => row(it, h("div", { class: "ks-row-tags" }, tagBadge(t.audios[i])), () => { dropItem(it); form.audios.splice(i, 1); renderCreate(); })),
      form.audios.length < LIMITS.audios ? h("button", { class: "ks-add", onclick: () => filePicker("audio/*,video/*", true, (fs) => addFiles(fs, "audios")) }, "+ 添加参考音频") : null);
    body.append(field("参考声音", auds, { right: h("span", { class: "ks-muted" }, `${form.audios.length} / ${LIMITS.audios} · 学说话的音色`),
      tip: "说话的音色或背景音乐。上传视频文件时只取它的声音。" }));

    const dur = Number(form.duration) || 5;
    const anchors = h("div", { class: "ks-rows", "data-drop": "anchors" },
      form.anchors.map((it, i) => row(it, h("div", { class: "ks-row-tags" },
        h("span", { class: "ks-kind" }, { image: "画面", clip: "片段", audio: "音频（实验）" }[it.anchorKind]),
        h("label", { class: "ks-time" }, "在第", h("input", { type: "number", class: "ks-input ks-mini", min: "0", max: String(dur), step: "0.1", value: String(it.time),
          oninput: (e) => { it.time = e.target.value; } }), "秒")),
      () => { dropItem(it); form.anchors.splice(i, 1); renderCreate(); })),
      form.anchors.length < LIMITS.anchors ? h("button", { class: "ks-add", onclick: () => filePicker("image/*,video/*,audio/*", true, (fs) => addFiles(fs, "anchors")) }, "+ 添加锚点（图 / 片段 / 音频）") : null);
    body.append(field("对口型 / 固定画面", anchors, { right: h("span", { class: "ks-muted" }, `${form.anchors.length} / ${LIMITS.anchors} · 指定某一刻的画面或声音`),
      tip: "把图片钉在第几秒（0 秒就是首帧），或者让一段视频片段 / 音频从第几秒开始。图片锚点已实测可精确落位；片段和音频锚点（对口型）还没有实测。" }));
  }
  const count = form.refMethod === "frames" ? [form.firstFrame, form.lastFrame].filter(Boolean).length
    : form.images.length + form.videos.length + form.audios.length + form.anchors.length;
  return collapse("参考素材", "image", form.refOpen, () => { form.refOpen = !form.refOpen; saveDraft(); renderCreate(); }, body,
    count ? `${count} 个素材 · ${MODE_LABEL[typeof mode === "string" ? mode : "t2v"]}` : "可选");
}

function renderAdvanced() {
  const seed = h("input", { id: "ks-seed", class: "ks-input", type: "number", min: "0", step: "1", placeholder: "留空每次都不一样", value: form.seed ?? "",
    oninput: (e) => { form.seed = e.target.value; saveDraft(); } });
  const body = h("div", null,
    field("复用运动（种子）", h("div", { class: "ks-inline" }, seed,
      h("button", { class: "ks-iconbtn ks-boxed", title: "随机一个种子", "aria-label": "随机种子", onclick: () => { form.seed = String(randomSeed()); seed.value = form.seed; saveDraft(); } }, icon("dice", 18))),
    { for: "ks-seed", tip: "同样的描述、设置和种子会生成同样的运动。在生成记录里点「复用种子」可以填回来。",
      hint: form.lastSeed != null ? `上一次随机用的种子：${form.lastSeed}` : null }),
    h("label", { class: "ks-switch" }, h("input", { type: "checkbox", checked: form.preview, onchange: (e) => { form.preview = e.target.checked; saveDraft(); } }),
      h("span", { class: "ks-switch-ui" }), "生成中预览", tip("生成过程中在记录卡片上显示低清预览帧")));
  if (resolveMode() === "r2v" || resolveMode() === "keyframes") {
    body.append(field("参考图精度", select("ks-refsize", [["match", "标准（按输出尺寸缩放，较快）"], ["max", "高保真（短边 2048，身份更像，更慢）"]], form.refImageSize, (v) => {
      form.refImageSize = v; saveDraft();
    }), { for: "ks-refsize" }));
  }
  return collapse("高级设置", "sliders", form.advOpen, () => { form.advOpen = !form.advOpen; saveDraft(); renderCreate(); }, body);
}

function setFooterStatus(text) {
  const el = $("#ks-gen-label", footer || document);
  if (el) el.textContent = text;
}

function estimate(mode) {
  const key = `${FAMILY[mode]}|${form.res}|${form.speed}`;
  const s = settings.stats[key];
  const secs = s ? s.per * Math.max(1, Number(form.duration) || 5) : null;
  return secs;
}

function renderCreateFooter() {
  if (!footer || state.tab !== "create") return;
  clear(footer);
  const { mode, errs } = validate();
  if (state.missing) footer.append(renderMissing());
  const btn = h("button", { class: "ks-primary", disabled: state.submitting || !!state.fetching || null, onclick: generate },
    h("span", { id: "ks-gen-label" }, state.submitting ? "正在提交…" : "生成视频"));
  footer.append(btn);
  const bits = [];
  if (typeof mode === "string") {
    const secs = estimate(mode);
    bits.push(secs ? `预计约 ${fmtDur(secs)}` : "首次生成后会显示预计时长");
    if (state.lastFamily && state.lastFamily !== FAMILY[mode]) bits.push("切换模式后首次生成要重新加载模型，会多几分钟");
    const cu = gate.status?.cu?.per_hour;
    if (secs && cu) bits.push(`约 ${((secs / 3600) * cu).toFixed(2)} CU`);
  }
  if (mode === "t2v" && /<(Picture|Video|Audio) \d+>/.test(form.prompt)) bits.unshift("描述里用了 <Picture …> 这类标签，但还没有放参考素材");
  if (errs.length && form.prompt.trim()) bits.unshift(errs[0]);
  footer.append(h("div", { class: "ks-foot-note" }, bits.join(" · ")));
}

function renderMissing() {
  const m = state.missing;
  const w = kit.byMode[m.mode];
  const gb = kit.info?.on_demand_gb?.[w?.id];
  const box = h("div", { class: "ks-banner" },
    h("div", null, h("strong", null, `「${MODE_LABEL[m.mode]}」需要的模型还没下载`),
      h("div", { class: "ks-hint" }, `${gb ? `约 ${gb} GB，` : ""}只需下载一次（本次开机内有效）。缺少：${m.files.join("、")}`)));
  if (state.fetching) {
    box.append(h("div", { class: "ks-hint" }, `下载中… 已等待 ${fmtDur((Date.now() - state.fetching.since) / 1000)}，下载完会自动继续检查`));
  } else {
    box.append(h("button", { class: "ks-btn", onclick: () => startFetch(m.mode) }, icon("download"), "开始下载"));
  }
  return box;
}

async function startFetch(mode) {
  const w = kit.byMode[mode];
  if (!w) return;
  try {
    await gatePost("/_gate/fetch", { workflows: [w.id] });
    state.fetching = { mode, since: Date.now() };
    toast(gate.mode === "same" ? "已开始下载模型" : `已请求网关（${settings.gateBase}）下载模型；如果几分钟后仍没开始，请在网关页面确认`, "ok", 7000);
    keepAlive(true);
    watchFetch();
  } catch (e) { toast(`无法开始下载：${e.message}`, "err"); }
  renderCreateFooter();
}

async function watchFetch() {
  if (!state.fetching) return;
  const f = state.fetching;
  try {
    keepAlive();
    if (gate.mode === "same") await refreshGate();
    const tpl = await template(f.mode);
    const missing = await missingModels(tpl);
    if (!missing.length) {
      state.fetching = null;
      state.missing = null;
      toast("模型已就绪，可以生成了", "ok");
      renderCreateFooter();
      return;
    }
    if (gate.status?.models?.fetch_error) { state.fetching = null; toast(`下载失败：${gate.status.models.fetch_error}`, "err", 9000); renderCreateFooter(); return; }
  } catch (e) { console.warn("[studio] fetch watch", e); }
  if (Date.now() - f.since > 60 * 60 * 1000) { state.fetching = null; toast("等待下载超过 1 小时，已停止检查", "err"); }
  renderCreateFooter();
  setTimeout(watchFetch, 15000);
}

function insertSkeleton() {
  const t = tags();
  const lines = ["subject_definitions:"];
  if (form.images.length) {
    form.images.forEach((_, i) => lines.push(i === 0 ? `<Subject 1> is the person in ${t.images[0]}, [appearance: face, hair, clothing].`
      : `${t.images[i]} shows [what this picture contributes: a second character, a prop, the location…].`));
  } else lines.push("<Subject 1> is [who or what the video is about].");
  form.videos.forEach((_, k) => lines.push(`${t.videos[k]} is a reference video showing [the motion or camera move to follow].${t.videoAudios[k] ? ` ${t.videoAudios[k]} is its soundtrack.` : ""}`));
  form.audios.forEach((_, j) => lines.push(`${t.audios[j]} is [the voice to imitate / the music to reuse].`));
  const kf = form.anchors.length > 0;
  lines.push("", "summary:", `[${kf ? "keyframe completion + reference generation" : "reference generation"}] The target video shows <Subject 1> [main action] in [setting].`,
    "", "retention_analysis:", `<Subject 1>: fully_preserved - keep the face, hairstyle and outfit${form.images.length ? ` from ${t.images[0]}` : ""}.`,
    "", "detailed_description:");
  const pinned = form.anchors.map((a) => ({ ...a, time: Number(a.time) || 0 })).sort((a, b) => a.time - b.time);
  const opens = pinned.length && pinned[0].time === 0 && pinned[0].anchorKind !== "audio";
  lines.push(`[Shot 1] ${opens ? "The shot begins from the pinned first frame. " : ""}[scene, action, lighting; camera move with its type, amplitude and speed].`);
  pinned.slice(opens ? 1 : 0).forEach((a, i) => {
    const ts = `00:${String(Math.floor(a.time)).padStart(2, "0")}.${String(Math.round((a.time % 1) * 1000)).padStart(3, "0")}`;
    lines.push(`[Shot ${i + 2}] At ${ts}, [what happens at this moment: it matches the pinned ${a.anchorKind === "audio" ? "sound" : "frame"}].`);
  });
  lines.push("", "overall_soundscape:", "[ambient sound and effects]. <d>[English] \"the line the character says\"</d>", "", "non_diegetic_music:", "[background music, or None].");
  const text = lines.join("\n");
  if (form.prompt.trim() && !confirm("用结构化模板替换当前描述？（方括号里的内容需要改成你自己的）")) return;
  form.prompt = text;
  const ta = $("#ks-prompt", createPane);
  if (ta) { ta.value = text; ta.focus(); }
  $("#ks-count", createPane).textContent = `${text.length} 字`;
  saveDraft();
  renderCreateFooter();
}

// records
function renderRecords() {
  if (!recordsPane) return;
  if (!recordsPane.firstChild) {
    recordsPane.append(
      h("div", { class: "ks-card-head" }, h("span", { class: "ks-bar" }), h("h2", null, "生成记录"), h("span", { class: "ks-count", id: "ks-rec-count" }),
        h("span", { class: "ks-grow" }),
        h("button", { class: "ks-iconbtn ks-boxed", title: "刷新", "aria-label": "刷新视频记录", onclick: () => { syncHistory(); poll(); } }, icon("refresh", 18)),
        h("button", { class: "ks-iconbtn ks-boxed", title: "清空已结束的记录", "aria-label": "清空已结束的视频", onclick: () => {
          const done = [...jobs.values()].filter((j) => !ACTIVE.has(j.status));
          if (!done.length) return;
          if (confirm(`删除 ${done.length} 条已结束的记录？保存在本浏览器里的视频也会一起删除。`)) deleteJobs(done);
        } }, icon("trash", 18))),
      h("div", { class: "ks-toolbar" },
        h("div", { class: "ks-filters", role: "group", "aria-label": "视频状态筛选", id: "ks-filters" }),
        h("label", { class: "ks-search" }, icon("search"), h("input", { type: "search", placeholder: "搜索提示词", "aria-label": "搜索视频记录", value: state.search,
          oninput: (e) => { state.search = e.target.value; renderRecords(); } }))),
      h("div", { class: "ks-grid-cards", id: "ks-cards" }),
      h("div", { class: "ks-empty-state", id: "ks-empty" }));
  }
  const filters = $("#ks-filters", recordsPane);
  clear(filters).append(...[["all", "全部"], ["active", "进行中"], ["done", "已完成"], ["failed", "未完成"]].map(([k, l]) =>
    h("button", { class: `ks-filter${state.filter === k ? " on" : ""}`, onclick: () => { state.filter = k; renderRecords(); } }, l)));
  const list = [...jobs.values()].sort((a, b) => b.createdAt - a.createdAt);
  $("#ks-rec-count", recordsPane).textContent = String(list.length);
  const q = state.search.trim().toLowerCase();
  const shown = list.filter((j) => {
    if (q && !(j.meta?.prompt || "").toLowerCase().includes(q)) return false;
    if (state.filter === "active") return ACTIVE.has(j.status);
    if (state.filter === "done") return j.status === "done";
    if (state.filter === "failed") return ["failed", "cancelled", "lost"].includes(j.status);
    return true;
  });
  const host = $("#ks-cards", recordsPane);
  const want = shown.map((j) => card(j));
  [...host.children].forEach((c) => { if (!want.includes(c)) c.remove(); });
  want.forEach((c, i) => { if (host.children[i] !== c) host.insertBefore(c, host.children[i] || null); });
  const empty = $("#ks-empty", recordsPane);
  empty.hidden = shown.length > 0;
  clear(empty).append(list.length ? "没有符合条件的记录" : h("div", null, h("div", { class: "ks-empty-title" }, "还没有生成过视频"),
    h("div", { class: "ks-hint" }, "生成的视频会自动保存在这个浏览器里，GPU 释放后也能回看和下载。")));
}

const STATUS = {
  preparing: ["准备中", "run"], queued: ["排队中", "run"], running: ["生成中", "run"], done: ["完成", "ok"],
  failed: ["失败", "err"], cancelled: ["已取消", "mute"], lost: ["已中断", "err"],
};

function card(job) {
  let el = cards.get(job.id);
  if (!el) {
    el = h("article", { class: "ks-job", "data-job": job.id },
      h("div", { class: "ks-job-media" }), h("div", { class: "ks-job-body" }));
    cards.set(job.id, el);
  }
  const sig = `${job.status}|${job.blobKey || ""}|${job.expired ? 1 : 0}|${job.output?.filename || ""}`;
  if (el.dataset.sig !== sig) { el.dataset.sig = sig; paintMedia(el, job); }
  if (ACTIVE.has(job.status)) paintProgress(el, job);
  const bsig = `${job.status}|${job.error || ""}|${job.blobKey ? 1 : 0}|${job.expired ? 1 : 0}|${job.endedAt || 0}|${job.meta?.prompt?.length || 0}`;
  if (el.dataset.bsig !== bsig) { el.dataset.bsig = bsig; paintBody(el, job); }
  return el;
}

function paintMedia(el, job) {
  const box = clear($(".ks-job-media", el));
  const ratio = /^(\d+):(\d+)/.exec(job.meta?.aspect || "16:9");
  box.style.aspectRatio = ratio ? `${ratio[1]} / ${ratio[2]}` : "16 / 9";
  if (job.status === "done" && (job.blobKey || (job.output && !job.expired))) {
    const v = h("video", { controls: true, preload: "metadata", playsinline: true });
    box.append(v);
    if (job.blobKey) blobUrl(job.blobKey).then((u) => { v.src = u || (job.output ? viewUrl(job.output) : ""); });
    else v.src = viewUrl(job.output);
  } else if (job.status === "done") {
    box.append(h("div", { class: "ks-media-note" }, "视频文件已随 GPU 释放而清除"));
  } else if (ACTIVE.has(job.status)) {
    box.append(h("img", { class: "ks-live", alt: "", src: job._live?.preview || "" }), h("div", { class: "ks-progress-wrap" }));
  } else {
    box.append(h("div", { class: "ks-media-note" }, STATUS[job.status]?.[0] || job.status));
  }
}

function paintProgress(el, job) {
  const wrap = $(".ks-progress-wrap", el);
  if (!wrap) return;
  const L = job._live || {};
  let text = STATUS[job.status][0], pct = null, sub = "";
  if (job.status === "queued") {
    const pos = state.queue.pending.findIndex((x) => x[1] === job.id);
    const ahead = (pos >= 0 ? pos : 0) + state.queue.running.length;
    text = ahead ? `排队中 · 前面还有 ${ahead} 个` : "排队中";
  } else if (job.status === "running") {
    text = L.phase || "开始生成";
    if (L.steps) {
      pct = Math.min(100, (L.step / L.steps) * 100);
      text = `${L.phase || "生成画面"} ${L.step}/${L.steps}`;
      if (L.samplingStart && L.step >= 2) {
        const per = (Date.now() - L.samplingStart) / L.step;
        sub = `剩余约 ${fmtDur(((L.steps - L.step) * per * 1.12) / 1000)}`;
      }
    }
    if (job.startedAt) sub = [sub, `已用 ${fmtDur((Date.now() - job.startedAt) / 1000)}`].filter(Boolean).join(" · ");
  }
  clear(wrap).append(...[
    h("div", { class: "ks-progress-text" }, h("span", { class: "ks-spin" }), text),
    h("div", { class: `ks-progress${pct == null ? " ks-indet" : ""}` }, h("div", { class: "ks-progress-bar", style: pct == null ? null : { width: `${pct}%` } })),
    sub ? h("div", { class: "ks-progress-sub" }, sub) : null].filter(Boolean));
}

function paintBody(el, job) {
  const body = clear($(".ks-job-body", el));
  const m = job.meta || {};
  const [label, cls] = STATUS[job.status] || [job.status, "mute"];
  const size = P.resolutionFor(m.aspect, (RES.find((r) => r.key === m.res) || RES[0]).mp);
  body.append(...[
    h("p", { class: "ks-job-prompt", title: m.prompt }, m.prompt || "（无描述）"),
    job.status === "failed" || job.status === "lost" ? h("p", { class: "ks-job-err", title: job.errorDetail || "" }, job.error || "") : null,
    h("div", { class: "ks-job-meta" },
      h("span", { class: `ks-badge ks-b-${cls}` }, label),
      h("span", null, [MODE_LABEL[m.mode], size ? `${size.width}×${size.height}` : null, m.duration ? `${m.duration} 秒` : null,
        m.speed === "turbo" ? "闪电" : "标准"].filter(Boolean).join(" · ")),
      job.endedAt && job.startedAt && job.status === "done" ? h("span", { class: "ks-muted" }, `用时 ${fmtDur((job.endedAt - job.startedAt) / 1000)}`) : null,
      h("span", { class: "ks-muted" }, fmtTime(job.createdAt))),
    h("div", { class: "ks-job-actions" },
      h("button", { class: "ks-act", title: "把这条记录的描述、设置和素材填回创作页", onclick: () => reuse(job) }, icon("copy", 14), "复用"),
      m.seed != null ? h("button", { class: "ks-act", title: `种子 ${m.seed}`, onclick: () => reuse(job, true) }, "复用种子") : null,
      job.status === "done" && (job.blobKey || (job.output && !job.expired)) ? h("button", { class: "ks-act ks-act-accent", onclick: () => downloadJob(job) }, icon("download", 14), "下载") : null,
      ACTIVE.has(job.status) ? h("button", { class: "ks-act ks-act-danger", onclick: () => cancelJob(job) }, "取消")
        : h("button", { class: "ks-act ks-act-danger", onclick: () => { if (confirm("删除这条记录和保存在本浏览器里的视频？")) deleteJobs([job]); } }, "删除"))].filter(Boolean));
}

// dialogs
function dialog(title, ...content) {
  $(".ks-dialog-wrap", root)?.remove();
  const wrap = h("div", { class: "ks-dialog-wrap", onclick: (e) => { if (e.target === wrap) wrap.remove(); } },
    h("div", { class: "ks-dialog", role: "dialog", "aria-modal": "true", "aria-label": title },
      h("div", { class: "ks-dialog-head" }, h("h2", null, title), h("button", { class: "ks-iconbtn", "aria-label": "关闭", onclick: () => wrap.remove() }, icon("x", 18))),
      h("div", { class: "ks-dialog-body" }, ...content)));
  root.append(wrap);
  return wrap;
}

function showHelp() {
  dialog("使用说明",
    h("ol", { class: "ks-help" },
      h("li", null, h("strong", null, "只写描述 = 文生视频。"), "在「参考素材」里放首帧就是图生视频，放参考图 / 视频 / 声音就是参考生成，加「固定画面」锚点会把画面钉在指定秒数。工作室会自动选对应的官方工作流。"),
      h("li", null, h("strong", null, "参考素材配结构化描述效果最好。"), "点「插入结构化模板」，把方括号里的内容改成你的；用 <Picture 1>、<Video 1>、<Audio 1> 指代素材（点素材角标即可插入）。台词写成 <d>[English] \"…\"</d>。"),
      h("li", null, h("strong", null, "第一次生成会慢。"), "开机后第一次、以及在「文生 / 首尾帧」和「参考」之间切换后，GPU 要先加载几十 GB 的模型。参考模式的模型是按需下载的，第一次用会提示你下载。"),
      h("li", null, h("strong", null, "视频保存在这个浏览器里。"), "GPU 释放后它上面的文件会清空，但完成的视频和你用过的素材已经存进本浏览器（IndexedDB），随时能回看、下载、复用。换浏览器或清除网站数据会丢失，重要的请下载。"),
      h("li", null, h("strong", null, "通过 SSH 隧道使用时"), `，生成期间工作室会定时提醒本机网关（${settings.gateBase}）你还在用，避免空闲自动关机；网关地址可在「设置」里改。`),
      h("li", null, h("strong", null, "想看节点？"), "点右上角「打开节点图」进入 ComfyUI；左下角的按钮可以回到工作室。")));
}

async function showSettings() {
  const est = navigator.storage?.estimate ? await navigator.storage.estimate().catch(() => null) : null;
  const persisted = navigator.storage?.persisted ? await navigator.storage.persisted().catch(() => false) : false;
  const gateInput = h("input", { class: "ks-input", value: settings.gateBase, placeholder: "http://localhost:8080" });
  dialog("设置",
    field("网关地址（SSH 隧道模式用）", gateInput, { hint: gate.mode === "same" ? "当前通过网关访问，不需要填写" : "工作室用它防止生成时被空闲关机，以及触发模型下载" }),
    h("label", { class: "ks-switch" }, h("input", { type: "checkbox", checked: settings.autoDownload, onchange: (e) => { settings.autoDownload = e.target.checked; saveSettings(); } }),
      h("span", { class: "ks-switch-ui" }), "生成完成后自动下载到电脑"),
    h("div", { class: "ks-field" }, h("div", { class: "ks-label" }, "本浏览器存储"),
      h("div", { class: "ks-hint" }, est ? `已用 ${fmtBytes(est.usage || 0)} / 可用约 ${fmtBytes(est.quota || 0)}` : "无法读取"),
      h("div", { class: "ks-hint" }, persisted ? "已设为持久保存（浏览器不会自动清理）" : "未设为持久保存：磁盘紧张时浏览器可能清理"),
      persisted ? null : h("button", { class: "ks-btn ks-small", onclick: async () => {
        const ok = await navigator.storage?.persist?.().catch(() => false);
        toast(ok ? "已设为持久保存" : "浏览器没有同意持久保存", ok ? "ok" : "warn");
      } }, "请求持久保存")),
    h("div", { class: "ks-dialog-foot" }, h("button", { class: "ks-btn", onclick: () => {
      settings.gateBase = gateInput.value.trim() || "http://localhost:8080"; saveSettings(); $(".ks-dialog-wrap", root)?.remove(); renderHeaderStatus(); toast("已保存", "ok");
    } }, "保存")));
}

async function refreshGate() {
  if (gate.mode !== "same") return;
  try { gate.status = await json("/_gate/status"); } catch { /* transient */ }
  renderHeaderStatus();
}

// ───────────────────────── boot ─────────────────────────
async function boot() {
  let info;
  try { info = await json("/kit/info"); } catch { return; }
  const wfs = (info.workflows || []).filter((w) => P.MODES.includes(w.studio));
  if (!wfs.length) return;
  kit.info = info;
  for (const w of wfs) if (!kit.byMode[w.studio]) kit.byMode[w.studio] = w;
  const link = h("link", { rel: "stylesheet", href: new URL("./studio.css", import.meta.url).href });
  document.head.append(link);
  buildShell();
  document.body.classList.toggle("kit-studio-open", !settings.hidden);
  root.hidden = settings.hidden;
  $("#kit-studio-fab").hidden = !settings.hidden;
  render();

  try {
    const def = await nodeDef("ResolutionSelector");
    const opts = comboOptions(def, "aspect_ratio");
    if (opts?.length) {
      state.aspects = opts.slice().sort((a, b) => DEFAULT_ASPECTS.indexOf(a) - DEFAULT_ASPECTS.indexOf(b));
      if (!state.aspects.includes(form.aspect)) form.aspect = state.aspects[0];
    }
  } catch { /* keep defaults */ }

  for (const j of await db.allJobs()) {
    for (const k of Object.keys(j)) if (k.startsWith("_")) delete j[k]; // records saved by an older page
    j._live = {};
    jobs.set(j.id, j);
  }
  await detectGate();
  render();
  await syncHistory();

  for (const t of ["execution_start", "executing", "progress", "executed", "execution_success", "execution_error", "execution_interrupted"]) {
    api.addEventListener(t, (e) => { try { onEvent(t, e.detail); } catch (err) { console.warn("[studio]", t, err); } });
  }
  api.addEventListener("b_preview_with_metadata", (e) => { const d = e.detail || {}; metaPreview = true; if (d.blob) onPreview(d.blob, d); });
  api.addEventListener("b_preview", (e) => { if (e.detail instanceof Blob && !metaPreview) onPreview(e.detail, null); });
  api.addEventListener("status", () => scheduleRender());
  api.addEventListener("reconnected", () => { syncHistory(); poll(); });

  setInterval(poll, 10000);
  presence();
  let lastPresence = Date.now();
  everyUnthrottled(15000, () => {
    if (Date.now() - lastPresence >= 29000) { lastPresence = Date.now(); presence(); }
    const busy = [...jobs.values()].some((j) => ACTIVE.has(j.status)) || state.fetching;
    if (busy || Date.now() - (state.lastUse || 0) < ACTIVE_WINDOW_MS) keepAlive();
  });
  setInterval(() => { if ([...jobs.values()].some((j) => j.status === "running")) scheduleRender(); }, 1000);
  setInterval(refreshGate, 30000);
  window.kitStudio = { jobs, form, state, settings, template, build: P.buildPrompt, version: VERSION };
}

boot().catch((e) => console.error("[studio] boot", e));
