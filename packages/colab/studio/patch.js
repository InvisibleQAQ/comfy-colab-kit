// comfy-colab-kit Studio: pure prompt patching (no DOM, no ComfyUI imports; unit-tested under node).
//
// The Studio never authors a graph. It takes the API-format prompt that the pinned ComfyUI frontend's own
// graphToPrompt() produced from an installed, unmodified workflow (the "template"), then:
//   * sets plain values (prompt, duration, size, seed, Lightning switch) where the template keeps them, following
//     a link to the Primitive* node that holds the value when the template wires one in;
//   * swaps the template's sample media for the user's uploads, adding stock loader nodes
//     (LoadImage / LoadVideo + GetVideoComponents / LoadAudio) for every reference the user adds;
//   * rebuilds the keyframe-anchor chain by cloning the template's own anchor unit;
//   * prunes nodes that no output depends on.
// Class names below are the stock ComfyUI nodes the MiniMax-H3 templates are built from.

export const MODES = ["t2v", "i2v", "r2v", "keyframes"];
const CORE_CLASSES = ["MiniMaxH3ReferenceToVideo", "MiniMaxH3ImageToVideo"];
const GUIDE_CLASS = "MiniMaxH3AddGuide";
const REF_GROUPS = ["ref_images.", "ref_videos.", "ref_video_audios.", "ref_audios."];
const OUTPUT_CLASSES = new Set(["SaveVideo", "SaveImage", "SaveAnimatedWEBP", "SaveAnimatedPNG", "SaveAudio",
  "PreviewImage", "PreviewAudio", "SaveWEBM", "VHS_VideoCombine"]);
export const FPS = 24;

export const isLink = (v) => Array.isArray(v) && v.length === 2 && typeof v[0] === "string" && Number.isInteger(v[1]);
const clone = (o) => (typeof structuredClone === "function" ? structuredClone(o) : JSON.parse(JSON.stringify(o)));

export class PatchError extends Error {}

/** Python's round(): half to even, so sizes match ResolutionSelector exactly. */
export function pyRound(x) {
  const r = Math.round(x);
  return Math.abs(x % 1) === 0.5 && r % 2 !== 0 ? r - 1 : r;
}

/** Width/height that ComfyUI's ResolutionSelector computes for an aspect label such as "16:9 (Widescreen)". */
export function resolutionFor(aspect, megapixels, multiple = 32) {
  const m = /^(\d+):(\d+)/.exec(aspect || "");
  if (!m) return null;
  const [w, h] = [Number(m[1]), Number(m[2])];
  const scale = Math.sqrt((megapixels * 1024 * 1024) / (w * h));
  return { width: pyRound((w * scale) / multiple) * multiple, height: pyRound((h * scale) / multiple) * multiple };
}

/** Frame count the H3 templates derive from seconds (24 fps, snapped up to the model's 17k+5 grid). */
export function framesFor(seconds) {
  const n = Math.max(5, pyRound(seconds * FPS));
  return n + ((5 - (n % 17)) % 17 + 17) % 17;
}

export function idsByClass(p, cls) {
  return Object.keys(p).filter((id) => p[id].class_type === cls);
}

export function coreId(p) {
  const ids = Object.keys(p).filter((id) => CORE_CLASSES.includes(p[id].class_type));
  if (ids.length !== 1) throw new PatchError(`expected exactly one MiniMax-H3 core node, found ${ids.length}`);
  return ids[0];
}

/** Where a scalar input really lives: the node itself, or the Primitive* node a link points at. */
function valueSlot(p, id, key) {
  const node = p[id];
  if (!node || !(key in node.inputs)) throw new PatchError(`node ${id} has no input "${key}"`);
  const v = node.inputs[key];
  if (!isLink(v)) return { node, key };
  const src = p[v[0]];
  if (src && /^Primitive/.test(src.class_type) && "value" in src.inputs) return { node: src, key: "value" };
  throw new PatchError(`input "${key}" of node ${id} is wired to ${src ? src.class_type : "a missing node"}`);
}

export function setScalar(p, id, key, value) {
  const s = valueSlot(p, id, key);
  s.node.inputs[s.key] = value;
}

export function getScalar(p, id, key) {
  const s = valueSlot(p, id, key);
  return s.node.inputs[s.key];
}

/** The keyframe-anchor chain between the core node and the guider, ordered from the core outwards. */
export function guideChain(p, core) {
  const guiders = Object.keys(p).filter((id) => "conditioning" in p[id].inputs && isLink(p[id].inputs.conditioning));
  for (const g of guiders) {
    const chain = [];
    let link = p[g].inputs.conditioning;
    const seen = new Set();
    while (isLink(link) && p[link[0]] && p[link[0]].class_type === GUIDE_CLASS && !seen.has(link[0])) {
      seen.add(link[0]);
      chain.unshift(link[0]);
      link = p[link[0]].inputs.positive;
    }
    if (isLink(link) && link[0] === core) return { guider: g, chain };
  }
  return { guider: null, chain: [] };
}

/** Facts about a template that the UI needs before the user presses Generate. */
export function describe(template) {
  const core = coreId(template);
  const node = template[core];
  const { chain } = guideChain(template, core);
  return {
    core,
    coreClass: node.class_type,
    hasRefs: node.class_type === "MiniMaxH3ReferenceToVideo",
    hasFirstFrame: "first_frame" in node.inputs,
    guides: chain.length,
    turbo: idsByClass(template, "ComfySwitchNode").some((id) => isLink(template[id].inputs.switch)),
    refImageSize: "ref_image_size" in node.inputs,
  };
}

/** Prompt tags in the order MiniMaxH3ReferenceToVideo presents references (see the node's docstring). */
export function referenceTags(refs) {
  const tags = { images: [], videos: [], videoAudios: [], audios: [] };
  let a = 0;
  (refs.images || []).forEach((_, i) => tags.images.push(`<Picture ${i + 1}>`));
  (refs.videos || []).forEach((v, k) => {
    tags.videoAudios.push(v.useAudio ? `<Audio ${++a}>` : null);
    tags.videos.push(`<Video ${k + 1}>`);
  });
  (refs.audios || []).forEach(() => tags.audios.push(`<Audio ${++a}>`));
  return tags;
}

/** Literal model filenames the prompt loads, as [{node, cls, key, value}] (for the missing-model check). */
export function modelFiles(p) {
  const out = [];
  for (const [id, n] of Object.entries(p)) {
    for (const [k, v] of Object.entries(n.inputs)) {
      if (typeof v === "string" && /\.(safetensors|ckpt|pt|pth|bin|gguf)$/i.test(v)) out.push({ node: id, cls: n.class_type, key: k, value: v });
    }
  }
  return out;
}

/** Drop every node that no output node depends on (template leftovers, replaced sample loaders). */
export function prune(p, outputClasses = OUTPUT_CLASSES) {
  const keep = new Set();
  const stack = Object.keys(p).filter((id) => outputClasses.has(p[id].class_type));
  if (!stack.length) throw new PatchError("template has no output node");
  while (stack.length) {
    const id = stack.pop();
    if (keep.has(id) || !p[id]) continue;
    keep.add(id);
    for (const v of Object.values(p[id].inputs)) if (isLink(v)) stack.push(v[0]);
  }
  for (const id of Object.keys(p)) if (!keep.has(id)) delete p[id];
  return p;
}

/**
 * Build the prompt for one run.
 *   template: API prompt from graphToPrompt() of the installed workflow for `params.mode`
 *   params: {mode, prompt, duration, aspect, megapixels, seed, turbo, refImageSize,
 *            firstFrame, lastFrame,                       // server filenames (i2v)
 *            images: [name], videos: [{name, useAudio}], audios: [{name, isVideo}],   // r2v / keyframes
 *            anchors: [{kind: "image"|"clip"|"audio", name, isVideo, time}]}         // keyframes
 * Returns {prompt, warnings}.
 */
export function buildPrompt(template, params, opts = {}) {
  if (!MODES.includes(params.mode)) throw new PatchError(`unknown mode ${params.mode}`);
  const p = clone(template);
  const warnings = [];
  const core = coreId(p);
  const c = p[core];
  let seq = 0;
  const add = (class_type, inputs) => {
    let id;
    do id = `kit${++seq}`; while (p[id]);
    p[id] = { class_type, inputs, _meta: { title: `Studio · ${class_type}` } };
    return id;
  };
  const loadImage = (name) => [add("LoadImage", { image: name }), 0];
  const videoParts = (name) => add("GetVideoComponents", { video: [add("LoadVideo", { file: name }), 0] });
  const loadAudio = (a) => (a.isVideo ? [videoParts(a.name), 1] : [add("LoadAudio", { audio: a.name }), 0]);

  // text
  if (typeof params.prompt !== "string" || !params.prompt.trim()) throw new PatchError("empty prompt");
  setScalar(p, core, "prompt", params.prompt);

  // duration: the templates turn seconds into frames with a ComfyMathExpression fed by a PrimitiveFloat
  const seconds = Number(params.duration);
  if (!(seconds > 0)) throw new PatchError("duration must be positive");
  const len = c.inputs.length;
  if (isLink(len) && p[len[0]] && p[len[0]].class_type === "ComfyMathExpression") setScalar(p, len[0], "values.a", seconds);
  else if (isLink(len)) throw new PatchError(`length is wired to ${p[len[0]] ? p[len[0]].class_type : "a missing node"}`);
  else c.inputs.length = framesFor(seconds);

  // size: ResolutionSelector when the template uses one, else literal width/height
  const w = c.inputs.width;
  if (isLink(w) && p[w[0]] && p[w[0]].class_type === "ResolutionSelector") {
    const rs = p[w[0]].inputs;
    if (params.aspect) rs.aspect_ratio = params.aspect;
    if (params.megapixels) rs.megapixels = Number(params.megapixels);
  } else if (!isLink(w)) {
    const r = resolutionFor(params.aspect, Number(params.megapixels));
    if (r) Object.assign(c.inputs, r);
  } else throw new PatchError("width is wired to an unknown node");

  // seed
  const noise = idsByClass(p, "RandomNoise");
  if (!noise.length) warnings.push("no RandomNoise node: seed not applied");
  for (const id of noise) setScalar(p, id, "noise_seed", Number(params.seed));

  // Lightning LoRA: the templates route model + steps through ComfySwitchNodes driven by one PrimitiveBoolean
  const switches = idsByClass(p, "ComfySwitchNode").filter((id) => "switch" in p[id].inputs);
  if (switches.length) for (const id of switches) setScalar(p, id, "switch", !!params.turbo);
  else if (params.turbo) warnings.push("template has no Lightning switch");

  if ("ref_image_size" in c.inputs && params.refImageSize) c.inputs.ref_image_size = params.refImageSize;

  // media: forget the template's sample wiring, then wire the user's
  for (const k of Object.keys(c.inputs)) {
    if (REF_GROUPS.some((g) => k.startsWith(g)) || k === "first_frame" || k === "last_frame") delete c.inputs[k];
  }
  const mode = params.mode;
  if (mode === "i2v") {
    if (c.class_type !== "MiniMaxH3ImageToVideo") throw new PatchError("i2v needs an image-to-video template");
    if (!params.firstFrame) throw new PatchError("first frame is required");
    c.inputs.first_frame = loadImage(params.firstFrame);
    if (params.lastFrame) c.inputs.last_frame = loadImage(params.lastFrame);
  } else if (mode === "t2v") {
    if (c.class_type !== "MiniMaxH3ImageToVideo") throw new PatchError("t2v needs an image-to-video template");
  } else {
    if (c.class_type !== "MiniMaxH3ReferenceToVideo") throw new PatchError(`${mode} needs a reference-to-video template`);
    const max = opts.maxRefs || { images: 9, videos: 3, audios: 3 };
    const images = params.images || [], videos = params.videos || [], audios = params.audios || [];
    if (images.length > max.images || videos.length > max.videos || audios.length > max.audios) {
      throw new PatchError("too many references");
    }
    images.forEach((name, i) => { c.inputs[`ref_images.ref_image_${i}`] = loadImage(name); });
    videos.forEach((v, i) => {
      const gv = videoParts(v.name);
      c.inputs[`ref_videos.ref_video_${i}`] = [gv, 0];
      if (v.useAudio) c.inputs[`ref_video_audios.ref_video_audio_${i}`] = [gv, 1];
    });
    audios.forEach((a, i) => { c.inputs[`ref_audios.ref_audio_${i}`] = loadAudio(a); });
  }

  // keyframe anchors: clone the template's anchor unit (AddGuide + its seconds->frame expression) per anchor
  const { guider, chain } = guideChain(p, core);
  const anchors = mode === "keyframes" ? params.anchors || [] : [];
  if (mode === "keyframes" && !anchors.length) throw new PatchError("keyframes mode needs at least one anchor");
  if (anchors.length && !chain.length) throw new PatchError("template has no keyframe anchor to copy");
  if (guider && (chain.length || anchors.length)) {
    const unit = chain.length ? p[chain[0]] : null;
    let prev = [core, 0];
    for (const a of anchors) {
      const t = Number(a.time);
      if (!(t >= 0)) throw new PatchError("anchor time must be >= 0");
      const inputs = {};
      for (const k of ["latent", "vae", "audio_vae"]) if (unit.inputs[k] !== undefined) inputs[k] = unit.inputs[k];
      inputs.positive = prev;
      inputs.frame_idx = anchorFrame(p, unit, t, add);
      if (a.kind === "audio") inputs.audio = loadAudio(a);
      else if (a.kind === "clip") inputs.image = [videoParts(a.name), 0];
      else inputs.image = loadImage(a.name);
      prev = [add(GUIDE_CLASS, inputs), 0];
    }
    p[guider].inputs.conditioning = prev;
  }

  if (opts.filenamePrefix) for (const id of idsByClass(p, "SaveVideo")) p[id].inputs.filename_prefix = opts.filenamePrefix;
  prune(p, opts.outputClasses || OUTPUT_CLASSES);
  return { prompt: p, warnings };
}

/** frame_idx for an anchor at `seconds`, reusing the template unit's own expression when it has one. */
function anchorFrame(p, unit, seconds, add) {
  const f = unit.inputs.frame_idx;
  if (isLink(f) && p[f[0]] && p[f[0]].class_type === "ComfyMathExpression") {
    const math = clone(p[f[0]]);
    const a = math.inputs["values.a"];
    if (isLink(a) && p[a[0]] && /^Primitive/.test(p[a[0]].class_type)) {
      const prim = clone(p[a[0]]);
      prim.inputs.value = seconds;
      math.inputs["values.a"] = [add(prim.class_type, prim.inputs), a[1]];
    } else math.inputs["values.a"] = seconds;
    return [add(math.class_type, math.inputs), f[1]];
  }
  return pyRound(seconds * FPS);
}
