// comfy-colab-kit Studio — pure queue and project logic (no DOM, no fetch), unit-tested by tests/studio/queue.test.mjs.
//
// The GPU runs one prompt at a time, so ComfyUI's queue is the Studio's queue: every project's jobs wait in it in
// submission order. This module turns a /queue payload plus what the page knows about each job into rows with a
// position and a time estimate, learned from this browser's own finished runs.

/** The DiT a mode runs on. Switching family between two jobs reloads tens of GB of weights. */
export const FAMILY = { t2v: "fl2va", i2v: "fl2va", r2v: "ref2va", keyframes: "ref2va" };

export const DEFAULT_PROJECT = { id: "default", name: "默认项目" };

/** Seconds used until this browser has measured its own runs. `preCold` is a model load on the full-precision
 * G4 profile (about 4 minutes there); the learned values replace all three after one run each. */
export const FALLBACK = { preWarm: 20, preCold: 240, tail: 20 };

/** The project a job belongs to. Records made before projects existed belong to the default project. */
export function projectOf(meta) {
  const p = meta && meta.project;
  return p && typeof p.id === "string" && p.id ? { id: p.id, name: p.name || p.id } : DEFAULT_PROJECT;
}

/** /queue → ordered entries: the running prompt first, then pending ones by queue number. */
export function queueEntries(q) {
  const norm = (x, running) => ({
    number: x[0], id: x[1], running, meta: (x[3] && x[3].kit_studio) || null, clientId: (x[3] && x[3].client_id) || null,
  });
  const pending = (q.queue_pending || []).slice().sort((a, b) => a[0] - b[0]);
  return [...(q.queue_running || []).map((x) => norm(x, true)), ...pending.map((x) => norm(x, false))];
}

const statKey = (meta) => `${FAMILY[meta.mode]}|${meta.res}|${meta.speed}`;

/** Exponential moving average that settles after about five samples. */
export function learnStat(stats, key, value) {
  if (!(value >= 0) || !Number.isFinite(value)) return stats;
  const s = stats[key] || { per: value, n: 0 };
  s.per = s.n ? (s.per * Math.min(s.n, 4) + value) / (Math.min(s.n, 4) + 1) : value;
  s.n += 1;
  stats[key] = s;
  return stats;
}

/** Learn from a finished run this page watched live: sampling speed per second of video, the time before sampling
 * (model load and prompt encoding, split by whether the models had to be loaded), and the time after it. */
export function learnRun(stats, meta, run) {
  if (!meta || !FAMILY[meta.mode]) return stats;
  const fam = FAMILY[meta.mode];
  const { startedAt, samplingStart, samplingEnd, endedAt, cold } = run;
  if (samplingStart != null && samplingEnd != null && samplingEnd > samplingStart) {
    learnStat(stats, statKey(meta), (samplingEnd - samplingStart) / 1000 / Math.max(1, Number(meta.duration) || 1));
  }
  if (startedAt != null && samplingStart != null && samplingStart >= startedAt && cold != null) {
    learnStat(stats, `pre|${fam}|${cold ? "cold" : "warm"}`, (samplingStart - startedAt) / 1000);
  }
  if (samplingEnd != null && endedAt != null && endedAt >= samplingEnd) learnStat(stats, `tail|${fam}`, (endedAt - samplingEnd) / 1000);
  return stats;
}

/** Seconds a whole job takes, or null when this browser has not finished a run with the same settings yet. */
export function estimateJob(stats, meta, cold) {
  if (!meta || !FAMILY[meta.mode]) return null;
  const fam = FAMILY[meta.mode];
  const s = stats[statKey(meta)];
  if (!s) return null;
  const pre = cold ? stats[`pre|${fam}|cold`]?.per ?? FALLBACK.preCold : stats[`pre|${fam}|warm`]?.per ?? FALLBACK.preWarm;
  const tail = stats[`tail|${fam}`]?.per ?? FALLBACK.tail;
  return pre + s.per * Math.max(1, Number(meta.duration) || 1) + tail;
}

/**
 * Plan the queue.
 * @param entries   queueEntries() output
 * @param opts.stats       learned stats (settings.stats)
 * @param opts.live        id → { startedAt, step, steps, stepFrom, stepFromAt, samplingStart, samplingEnd, cold }
 *                         for jobs this page watches (stepFrom/At: the first sampler step it saw, and when)
 * @param opts.gpuFamily   family of the last Studio job that ran, null when unknown (treated as not loaded)
 * @param opts.now         ms timestamp
 * @returns { rows, total: { count, studio, endIn, switches, lastFamily } }
 *   switches: entries that start by loading their models; lastFamily: what is on the GPU once the queue drains
 *   row: { id, number, running, studio, meta, project, family, position, ahead, cold, estimate, remaining,
 *          startIn, endIn }  (times in seconds; null when unknown)
 */
export function planQueue(entries, { stats = {}, live = {}, gpuFamily = null, now = Date.now() } = {}) {
  const rows = [];
  let prev = gpuFamily; // family on the GPU before the next entry starts; undefined = unknown (a graph job ran)
  let clock = 0; // seconds until the GPU is free for the next entry; null once an estimate is missing
  let switches = 0;
  entries.forEach((e, i) => {
    const studio = !!(e.meta && FAMILY[e.meta.mode]);
    const family = studio ? FAMILY[e.meta.mode] : null;
    const L = live[e.id] || {};
    let cold = null;
    if (studio) {
      if (e.running && "cold" in L) cold = L.cold ?? null; // decided when it started
      else if (prev === undefined) cold = null;
      else cold = prev !== family;
    }
    if (cold) switches += 1;
    const estimate = studio ? estimateJob(stats, e.meta, cold == null ? false : cold) : null;
    let remaining = null;
    if (e.running) {
      remaining = runningRemaining(estimate, L, stats, family, now);
    }
    const startIn = e.running ? 0 : clock;
    const dur = e.running ? remaining : estimate;
    const endIn = startIn == null || dur == null ? null : startIn + dur;
    rows.push({
      id: e.id, number: e.number, running: e.running, studio, meta: e.meta, clientId: e.clientId,
      project: studio ? projectOf(e.meta) : null, family, position: i, ahead: i, cold, estimate, remaining, startIn, endIn,
    });
    clock = endIn;
    prev = studio ? family : undefined;
  });
  const studioRows = rows.filter((r) => r.studio).length;
  return { rows, total: { count: rows.length, studio: studioRows, endIn: rows.length ? clock : 0, switches, lastFamily: prev } };
}

/** Remaining seconds of the running job: from the sampler's own step rate once this page has seen two steps,
 * otherwise the whole-job estimate minus the time already spent. */
function runningRemaining(estimate, L, stats, family, now) {
  const tail = (family && stats[`tail|${family}`]?.per) ?? FALLBACK.tail;
  if (L.samplingEnd) return Math.max(0, tail - (now - L.samplingEnd) / 1000);
  const from = L.stepFromAt != null ? L.stepFrom || 0 : 0, at = L.stepFromAt ?? L.samplingStart;
  if (L.steps && at != null && L.step - from >= 2) {
    const per = (now - at) / (L.step - from) / 1000;
    return Math.max(0, (L.steps - L.step) * per * 1.12) + tail;
  }
  if (estimate == null) return null;
  const spent = L.startedAt ? (now - L.startedAt) / 1000 : 0;
  return Math.max(tail, estimate - spent);
}

/** Where a new job in `mode` would land: entries ahead, seconds until it starts, and whether it starts with a model
 * load (null when unknown). */
export function previewSubmit(plan, mode) {
  const last = plan.total.lastFamily;
  return { ahead: plan.total.count, startIn: plan.total.endIn, cold: last === undefined ? null : last !== FAMILY[mode] };
}

const LIVE = new Set(["preparing", "queued", "running"]);

/** Merge a job record into the one already saved. Several tabs can hold copies of the same job (each tab imports
 * the jobs it sees in the queue), so a write must never turn a finished record back into a queued or running one,
 * and must keep the keys of files another tab already saved (the output video, the reference files). */
export function mergeJob(saved, incoming) {
  if (!saved) return incoming;
  if (!LIVE.has(saved.status) && LIVE.has(incoming.status)) return saved;
  const refs = (incoming.refs || []).map((r, i) => {
    const old = (saved.refs || [])[i];
    return r.blobKey || !old || !old.blobKey || old.name !== r.name ? r : { ...r, blobKey: old.blobKey };
  });
  const out = { ...incoming, refs };
  if (!out.blobKey && saved.blobKey) Object.assign(out, { blobKey: saved.blobKey, bytes: saved.bytes });
  return out;
}
