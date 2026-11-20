// Unit tests for packages/colab/studio/queue.js (run by tests/test_studio.py through `node --test`).
// Queue items have the shape ComfyUI's GET /queue returns, captured from a local ComfyUI:
// [number, prompt_id, prompt, extra_data { kit_studio?, client_id, create_time }, output node ids].
import test from "node:test";
import assert from "node:assert/strict";
import * as Q from "../../packages/colab/studio/queue.js";

const item = (number, id, kit) => [number, id, {}, { ...(kit ? { kit_studio: kit } : {}), client_id: "c1", create_time: 1795189858041 }, ["92"]];
const meta = (mode, project, extra = {}) => ({ v: 1, mode, prompt: "p", duration: 5, res: "480", speed: "standard",
  ...(project ? { project: { id: project, name: project.toUpperCase() } } : {}), ...extra });
// 480p standard: 20 s of sampling per second of video for both families, learned loads and tails
const stats = {
  "fl2va|480|standard": { per: 20, n: 3 }, "ref2va|480|standard": { per: 20, n: 3 },
  "pre|fl2va|warm": { per: 10, n: 2 }, "pre|fl2va|cold": { per: 200, n: 1 },
  "pre|ref2va|warm": { per: 10, n: 2 }, "pre|ref2va|cold": { per: 200, n: 1 },
  "tail|fl2va": { per: 10, n: 2 }, "tail|ref2va": { per: 10, n: 2 },
};

test("queueEntries puts the running prompt first and sorts pending by number", () => {
  const e = Q.queueEntries({ queue_running: [item(4, "run", meta("t2v", "a"))], queue_pending: [item(7, "c"), item(5, "b", meta("r2v", "b"))] });
  assert.deepEqual(e.map((x) => [x.id, x.running, x.number]), [["run", true, 4], ["b", false, 5], ["c", false, 7]]);
  assert.equal(e[0].meta.project.id, "a");
  assert.equal(e[2].meta, null);
  assert.equal(e[1].clientId, "c1");
  assert.deepEqual(Q.queueEntries({}), []);
});

test("projectOf falls back to the default project for older records", () => {
  assert.deepEqual(Q.projectOf(meta("t2v", "gta")), { id: "gta", name: "GTA" });
  assert.deepEqual(Q.projectOf(meta("t2v")), Q.DEFAULT_PROJECT);
  assert.deepEqual(Q.projectOf(null), Q.DEFAULT_PROJECT);
  assert.deepEqual(Q.projectOf({ project: { id: "x" } }), { id: "x", name: "x" });
});

test("estimateJob adds the model load only for a cold start and needs learned sampling speed", () => {
  assert.equal(Q.estimateJob(stats, meta("t2v"), false), 10 + 100 + 10);
  assert.equal(Q.estimateJob(stats, meta("t2v"), true), 200 + 100 + 10);
  assert.equal(Q.estimateJob(stats, meta("t2v", null, { res: "720" }), false), null);
  assert.equal(Q.estimateJob({ "fl2va|480|standard": { per: 20, n: 1 } }, meta("t2v"), true), Q.FALLBACK.preCold + 100 + Q.FALLBACK.tail);
  assert.equal(Q.estimateJob(stats, { mode: "music" }, false), null);
});

test("two projects interleaved: positions, start times and model reloads", () => {
  const q = { queue_running: [item(1, "a1", meta("t2v", "a"))],
    queue_pending: [item(2, "b1", meta("r2v", "b")), item(3, "a2", meta("i2v", "a")), item(4, "a3", meta("t2v", "a"))] };
  const now = 1_000_000;
  const live = { a1: { startedAt: now - 60_000, cold: false } };
  const plan = Q.planQueue(Q.queueEntries(q), { stats, live, gpuFamily: "fl2va", now });
  const r = Object.fromEntries(plan.rows.map((x) => [x.id, x]));
  assert.deepEqual(plan.rows.map((x) => x.ahead), [0, 1, 2, 3]);
  assert.equal(r.a1.remaining, 120 - 60);
  assert.equal(r.b1.cold, true, "fl2va → ref2va reloads");
  assert.equal(r.b1.startIn, 60);
  assert.equal(r.b1.estimate, 310);
  assert.equal(r.a2.cold, true, "ref2va → fl2va reloads again");
  assert.equal(r.a2.startIn, 370);
  assert.equal(r.a3.cold, false, "i2v and t2v share the fl2va DiT");
  assert.equal(r.a3.startIn, 680);
  assert.equal(plan.total.endIn, 800);
  assert.equal(plan.total.switches, 2);
  assert.deepEqual(r.b1.project, { id: "b", name: "B" });
  assert.equal(plan.total.lastFamily, "fl2va");
  const unsure = Q.planQueue(Q.queueEntries(q), { stats, live: { a1: { cold: null } }, gpuFamily: "fl2va", now });
  assert.equal(unsure.rows[0].cold, null, "a start the page did not see stays unknown");
});

test("running job uses the sampler's step rate once two steps are in", () => {
  const now = 1_000_000;
  const e = Q.queueEntries({ queue_running: [item(1, "a1", meta("t2v", "a"))] });
  const live = { a1: { startedAt: now - 100_000, samplingStart: now - 40_000, step: 4, steps: 20, cold: false } };
  const plan = Q.planQueue(e, { stats, live, gpuFamily: "fl2va", now });
  // 10 s per step, 16 steps left, the usual 12 % margin, then the learned 10 s tail
  assert.ok(Math.abs(plan.rows[0].remaining - (16 * 10 * 1.12 + 10)) < 1e-9);
  // a page that joined at step 10 counts from there: 5 steps in 25 s
  const late = Q.planQueue(e, { stats, live: { a1: { step: 15, steps: 20, stepFrom: 10, stepFromAt: now - 25_000 } }, now });
  assert.ok(Math.abs(late.rows[0].remaining - (5 * 5 * 1.12 + 10)) < 1e-9);
  const done = Q.planQueue(e, { stats, live: { a1: { ...live.a1, samplingEnd: now - 4_000 } }, now });
  assert.equal(done.rows[0].remaining, 6);
});

test("a graph job or an unmeasured setting leaves later times unknown but keeps positions", () => {
  const q = { queue_running: [item(1, "g")], queue_pending: [item(2, "a1", meta("t2v", "a")), item(3, "a2", meta("t2v", "a", { res: "768" }))] };
  const plan = Q.planQueue(Q.queueEntries(q), { stats, gpuFamily: "fl2va" });
  assert.deepEqual(plan.rows.map((x) => [x.studio, x.ahead, x.startIn]), [[false, 0, 0], [true, 1, null], [true, 2, null]]);
  assert.equal(plan.rows[1].cold, null, "a graph job may have evicted the models");
  assert.equal(plan.rows[2].cold, false);
  assert.equal(plan.rows[0].project, null);
  assert.equal(plan.total.endIn, null);
  assert.equal(plan.total.studio, 2);
});

test("unknown GPU contents count as not loaded; an empty queue starts now", () => {
  const plan = Q.planQueue(Q.queueEntries({ queue_pending: [item(1, "a1", meta("keyframes", "a"))] }), { stats, gpuFamily: null });
  assert.equal(plan.rows[0].cold, true);
  assert.equal(plan.rows[0].startIn, 0);
  const empty = Q.planQueue([], { stats, gpuFamily: "ref2va" });
  assert.deepEqual(Q.previewSubmit(empty, "r2v"), { ahead: 0, startIn: 0, cold: false });
  assert.deepEqual(Q.previewSubmit(empty, "t2v"), { ahead: 0, startIn: 0, cold: true });
  assert.equal(Q.previewSubmit(Q.planQueue(Q.queueEntries({ queue_running: [item(1, "g")] }), { stats }), "t2v").cold, null);
});

test("learnRun learns sampling speed, warm or cold start and tail from one watched run", () => {
  const s = {};
  Q.learnRun(s, meta("r2v", "a", { duration: 10 }), { startedAt: 0, samplingStart: 250_000, samplingEnd: 450_000, endedAt: 465_000, cold: true });
  assert.equal(s["ref2va|480|standard"].per, 20);
  assert.equal(s["pre|ref2va|cold"].per, 250);
  assert.equal(s["tail|ref2va"].per, 15);
  assert.equal(s["pre|ref2va|warm"], undefined);
  Q.learnRun(s, meta("r2v", "a", { duration: 10 }), { startedAt: 0, samplingStart: 5_000, samplingEnd: 105_000, endedAt: 120_000, cold: null });
  assert.equal(s["ref2va|480|standard"].per, 15, "the moving average moves toward 10 s/s");
  assert.equal(s["pre|ref2va|warm"], undefined, "an unknown start teaches nothing about loads");
  Q.learnRun(s, { mode: "music" }, { startedAt: 0, samplingStart: 1, samplingEnd: 2, endedAt: 3 });
  assert.equal(Object.keys(s).length, 3);
});

test("mergeJob keeps finished states and saved file keys from other tabs", () => {
  const submitted = { id: "j", status: "queued", refs: [{ role: "image", name: "a.png", blobKey: "ref:1" }] };
  const imported = { id: "j", status: "queued", refs: [{ role: "image", name: "a.png" }] };
  assert.equal(Q.mergeJob(undefined, imported), imported);
  assert.equal(Q.mergeJob(submitted, imported).refs[0].blobKey, "ref:1", "an imported copy has no blob keys");
  const done = { ...submitted, status: "done", blobKey: "out:j", bytes: 9 };
  assert.equal(Q.mergeJob(done, { ...imported, status: "running" }), done, "a stale copy cannot undo a finish");
  const lateDone = Q.mergeJob(done, { ...imported, status: "done", output: { filename: "x.mp4" } });
  assert.deepEqual([lateDone.blobKey, lateDone.bytes, lateDone.refs[0].blobKey], ["out:j", 9, "ref:1"]);
  const renamed = Q.mergeJob(submitted, { ...imported, refs: [{ role: "image", name: "b.png" }] });
  assert.equal(renamed.refs[0].blobKey, undefined, "keys only carry over to the same file");
  assert.equal(Q.mergeJob({ ...submitted, status: "lost" }, { ...imported, status: "done" }).status, "done");
});
