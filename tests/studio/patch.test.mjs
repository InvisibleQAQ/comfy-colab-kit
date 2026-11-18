// Unit tests for packages/colab/studio/patch.js (run by tests/test_studio.py through `node --test`).
// The fixtures are small synthetic API prompts shaped like what the frontend's graphToPrompt() emits for the
// MiniMax-H3 templates (subgraph ids such as "140:131", Primitive* value holders, switches, an anchor chain).
import test from "node:test";
import assert from "node:assert/strict";
import * as P from "../../packages/colab/studio/patch.js";

const meta = (title) => ({ _meta: { title } });
const t2v = () => ({
  92: { class_type: "SaveVideo", inputs: { filename_prefix: "video/x", video: ["140:130", 0] }, ...meta("Save") },
  115: { class_type: "ResolutionSelector", inputs: { aspect_ratio: "16:9 (Widescreen)", megapixels: 0.4, multiple: 32 } },
  "140:127": { class_type: "UNETLoader", inputs: { unet_name: "dit.safetensors", weight_dtype: "default" } },
  "140:129": { class_type: "RandomNoise", inputs: { noise_seed: 1 } },
  "140:125": { class_type: "SamplerCustomAdvanced", inputs: { guider: ["140:126", 0], noise: ["140:129", 0], latent_image: ["140:131", 1] } },
  "140:126": { class_type: "BasicGuider", inputs: { model: ["140:135", 0], conditioning: ["140:131", 0] } },
  "140:130": { class_type: "CreateVideo", inputs: { images: ["140:125", 0], fps: 24 } },
  "140:131": { class_type: "MiniMaxH3ImageToVideo", inputs: { prompt: "sample", width: ["115", 0], height: ["115", 1], length: ["140:132", 1] } },
  "140:132": { class_type: "ComfyMathExpression", inputs: { expression: "a*24", "values.a": ["140:133", 0] } },
  "140:133": { class_type: "PrimitiveFloat", inputs: { value: 5 } },
  "140:134": { class_type: "LoraLoaderModelOnly", inputs: { lora_name: "fast.safetensors", model: ["140:127", 0] } },
  "140:135": { class_type: "ComfySwitchNode", inputs: { switch: ["140:139", 0], on_false: ["140:127", 0], on_true: ["140:134", 0] } },
  "140:139": { class_type: "PrimitiveBoolean", inputs: { value: false } },
});
const i2v = () => {
  const p = t2v();
  p["114"] = { class_type: "LoadImage", inputs: { image: "sample.png" } };
  p["119"] = { class_type: "ImageScaleToTotalPixels", inputs: { megapixels: 0.9 } }; // dangling template leftover
  p["140:131"].inputs.first_frame = ["114", 0];
  return p;
};
const r2v = () => ({
  92: { class_type: "SaveVideo", inputs: { video: ["130", 0] } },
  115: { class_type: "ResolutionSelector", inputs: { aspect_ratio: "16:9 (Widescreen)", megapixels: 0.4, multiple: 32 } },
  119: { class_type: "VAELoader", inputs: { vae_name: "vae.safetensors" } },
  120: { class_type: "VAELoader", inputs: { vae_name: "audio.safetensors" } },
  126: { class_type: "BasicGuider", inputs: { model: ["141", 0], conditioning: ["136", 0] } },
  129: { class_type: "RandomNoise", inputs: { noise_seed: 2 } },
  130: { class_type: "CreateVideo", inputs: { images: ["125", 0] } },
  125: { class_type: "SamplerCustomAdvanced", inputs: { guider: ["126", 0], noise: ["129", 0], latent_image: ["136", 1] } },
  131: { class_type: "ComfyMathExpression", inputs: { expression: "a*24", "values.a": ["132", 0] } },
  132: { class_type: "PrimitiveFloat", inputs: { value: 5 } },
  136: { class_type: "MiniMaxH3ReferenceToVideo", inputs: { prompt: ["138", 0], width: ["115", 0], height: ["115", 1], length: ["131", 1],
    ref_image_size: "match", vae: ["119", 0], audio_vae: ["120", 0], "ref_images.ref_image_0": ["137", 0], "ref_images.ref_image_1": ["139", 0] } },
  137: { class_type: "LoadImage", inputs: { image: "a.png" } },
  138: { class_type: "PrimitiveStringMultiline", inputs: { value: "sample" } },
  139: { class_type: "LoadImage", inputs: { image: "b.png" } },
  141: { class_type: "ComfySwitchNode", inputs: { switch: ["146", 0] } },
  146: { class_type: "PrimitiveBoolean", inputs: { value: false } },
});
const keyframes = () => {
  const p = r2v();
  delete p[139];
  delete p[136].inputs["ref_images.ref_image_1"];
  Object.assign(p, {
    147: { class_type: "MiniMaxH3AddGuide", inputs: { positive: ["136", 0], latent: ["136", 1], vae: ["119", 0], audio_vae: ["120", 0], image: ["157", 0], frame_idx: ["153", 1] } },
    153: { class_type: "ComfyMathExpression", inputs: { expression: "round (a * 24)", "values.a": ["154", 0] } },
    154: { class_type: "PrimitiveFloat", inputs: { value: 1.5 } },
    157: { class_type: "LoadImage", inputs: { image: "k1.png" } },
    162: { class_type: "MiniMaxH3AddGuide", inputs: { positive: ["147", 0], latent: ["136", 1], vae: ["119", 0], image: ["159", 0], frame_idx: 72 } },
    159: { class_type: "LoadImage", inputs: { image: "k2.png" } },
  });
  p[126].inputs.conditioning = ["162", 0];
  return p;
};
const base = { prompt: "a cat yawns", duration: 8, aspect: "9:16 (Portrait Widescreen)", megapixels: 0.88, seed: 42, turbo: true };

test("resolution and frame math match ComfyUI", () => {
  assert.deepEqual(P.resolutionFor("16:9 (Widescreen)", 0.4), { width: 864, height: 480 });
  assert.deepEqual(P.resolutionFor("16:9 (Widescreen)", 1.0), { width: 1376, height: 768 });
  assert.deepEqual(P.resolutionFor("16:9 (Widescreen)", 0.88), { width: 1280, height: 736 });
  assert.deepEqual(P.resolutionFor("1:1 (Square)", 0.5625), { width: 768, height: 768 });
  assert.equal(P.framesFor(5), 124);
  assert.equal(P.framesFor(15), 362);
  assert.equal(P.framesFor(0.1), 5);
  assert.equal(P.pyRound(2.5), 2);
  assert.equal(P.pyRound(3.5), 4);
});

test("t2v sets values where the template keeps them and leaves the template untouched", () => {
  const tpl = t2v();
  const before = JSON.stringify(tpl);
  const { prompt } = P.buildPrompt(tpl, { ...base, mode: "t2v" });
  assert.equal(JSON.stringify(tpl), before);
  assert.equal(prompt["140:131"].inputs.prompt, "a cat yawns");
  assert.equal(prompt["140:133"].inputs.value, 8);
  assert.equal(prompt["115"].inputs.aspect_ratio, "9:16 (Portrait Widescreen)");
  assert.equal(prompt["115"].inputs.megapixels, 0.88);
  assert.equal(prompt["140:129"].inputs.noise_seed, 42);
  assert.equal(prompt["140:139"].inputs.value, true);
});

test("i2v swaps the sample first frame, adds a last frame and prunes leftovers", () => {
  const { prompt } = P.buildPrompt(i2v(), { ...base, mode: "i2v", firstFrame: "mine.png", lastFrame: "end.png" });
  const core = prompt["140:131"].inputs;
  assert.equal(prompt[core.first_frame[0]].inputs.image, "mine.png");
  assert.equal(prompt[core.last_frame[0]].inputs.image, "end.png");
  assert.ok(!prompt["114"], "template sample loader is pruned");
  assert.ok(!prompt["119"], "dangling template node is pruned");
  assert.throws(() => P.buildPrompt(i2v(), { ...base, mode: "i2v" }), /first frame/);
});

test("r2v wires images, videos with soundtracks and standalone audio in autogrow slots", () => {
  const { prompt } = P.buildPrompt(r2v(), { ...base, mode: "r2v", images: ["x.png"],
    videos: [{ name: "v.mp4", useAudio: true }, { name: "w.mp4", useAudio: false }], audios: [{ name: "s.wav" }, { name: "t.mp4", isVideo: true }] });
  const c = prompt["136"].inputs;
  assert.equal(prompt["138"].inputs.value, "a cat yawns", "prompt goes into the wired PrimitiveStringMultiline");
  assert.equal(prompt[c["ref_images.ref_image_0"][0]].inputs.image, "x.png");
  assert.ok(!("ref_images.ref_image_1" in c), "unused template slot is dropped");
  assert.ok(!prompt["137"] && !prompt["139"], "template sample images are pruned");
  const gv0 = prompt[c["ref_videos.ref_video_0"][0]];
  assert.equal(gv0.class_type, "GetVideoComponents");
  assert.equal(prompt[gv0.inputs.video[0]].inputs.file, "v.mp4");
  assert.deepEqual(c["ref_video_audios.ref_video_audio_0"], [c["ref_videos.ref_video_0"][0], 1]);
  assert.ok(!("ref_video_audios.ref_video_audio_1" in c));
  assert.equal(prompt[c["ref_audios.ref_audio_0"][0]].class_type, "LoadAudio");
  assert.equal(c["ref_audios.ref_audio_1"][1], 1, "audio taken from a video file uses GetVideoComponents' audio output");
  assert.equal(c.ref_image_size, "match");
  assert.equal(prompt["146"].inputs.value, true, "Lightning switch follows params.turbo");
});

test("reference tags follow the node's presentation order", () => {
  const t = P.referenceTags({ images: [1, 2], videos: [{ useAudio: false }, { useAudio: true }], audios: [1] });
  assert.deepEqual(t.images, ["<Picture 1>", "<Picture 2>"]);
  assert.deepEqual(t.videos, ["<Video 1>", "<Video 2>"]);
  assert.deepEqual(t.videoAudios, [null, "<Audio 1>"]);
  assert.deepEqual(t.audios, ["<Audio 2>"]);
});

test("keyframes rebuilds the anchor chain from the template's own unit", () => {
  const { prompt } = P.buildPrompt(keyframes(), { ...base, mode: "keyframes", images: ["subj.png"],
    anchors: [{ kind: "image", name: "a0.png", time: 0 }, { kind: "audio", name: "song.wav", time: 2 }, { kind: "clip", name: "c.mp4", time: 3.5 }] });
  const guides = Object.keys(prompt).filter((id) => prompt[id].class_type === "MiniMaxH3AddGuide");
  assert.equal(guides.length, 3);
  const { guider, chain } = P.guideChain(prompt, "136");
  assert.equal(guider, "126");
  assert.equal(chain.length, 3);
  const [g0, g1, g2] = chain.map((id) => prompt[id].inputs);
  assert.deepEqual(g0.positive, ["136", 0]);
  assert.equal(prompt[g0.image[0]].inputs.image, "a0.png");
  assert.equal(prompt[g1.audio[0]].inputs.audio, "song.wav");
  assert.equal(prompt[prompt[g2.image[0]].inputs.video[0]].inputs.file, "c.mp4");
  const math = prompt[g1.frame_idx[0]];
  assert.equal(math.inputs.expression, "round (a * 24)");
  assert.equal(prompt[math.inputs["values.a"][0]].inputs.value, 2);
  assert.equal(g1.frame_idx[1], 1);
  assert.deepEqual(g0.vae, ["119", 0]);
  assert.ok(!prompt["157"] && !prompt["159"] && !prompt["154"], "template anchors are pruned");
  assert.throws(() => P.buildPrompt(keyframes(), { ...base, mode: "keyframes", anchors: [] }), /anchor/);
});

test("r2v on the keyframes template drops the template anchors", () => {
  const { prompt } = P.buildPrompt(keyframes(), { ...base, mode: "r2v", images: ["subj.png"] });
  assert.deepEqual(prompt["126"].inputs.conditioning, ["136", 0]);
  assert.ok(!Object.values(prompt).some((n) => n.class_type === "MiniMaxH3AddGuide"));
});

test("wrong template or wiring fails loudly", () => {
  assert.throws(() => P.buildPrompt(t2v(), { ...base, mode: "r2v" }), /reference-to-video/);
  assert.throws(() => P.buildPrompt(r2v(), { ...base, mode: "t2v" }), /image-to-video/);
  const bad = t2v();
  bad["140:131"].inputs.length = ["140:129", 0];
  assert.throws(() => P.buildPrompt(bad, { ...base, mode: "t2v" }), /length is wired to RandomNoise/);
  assert.throws(() => P.buildPrompt(t2v(), { ...base, mode: "t2v", prompt: "  " }), /empty prompt/);
});

test("modelFiles lists literal model names for the missing-model check", () => {
  const files = P.modelFiles(t2v()).map((f) => `${f.cls}.${f.key}=${f.value}`).sort();
  assert.deepEqual(files, ["LoraLoaderModelOnly.lora_name=fast.safetensors", "UNETLoader.unet_name=dit.safetensors"]);
});
