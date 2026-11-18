# Studio: a one-page video maker

The Studio is a single page for making videos without touching the node graph. You write a description, pick
the length, resolution and aspect ratio, and optionally add reference material. Then press **生成视频**. The
records tab plays, downloads, reuses and deletes past results. ComfyUI is still there: **打开节点图** reveals
it, and the button in the bottom-left corner brings the Studio back.

The Studio is part of the kit's ComfyUI node on the VM (`packages/colab/studio/`, installed by `setup.py` into
`custom_nodes/kit_heartbeat/web/studio/`). ComfyUI serves it, so it works the same in both setups:

- **Through the gate:** open the gate URL; once the GPU is ready you land on the Studio.
- **Through an SSH tunnel to `:8188`:** open the tunnel URL, for example `http://127.0.0.1:18188`.

It appears only when the active profile marks workflows with a `studio` mode
([PROFILES.md](PROFILES.md#studio-modes)). Today that is `minimax-h3-video` and the profiles copied from it.

## What the form maps to

| Studio control | What it changes |
| :--- | :--- |
| 画面描述 | The prompt input of the H3 node (or the `PrimitiveStringMultiline` wired into it) |
| 模型: 标准 / 闪电 | The template's Lightning switch (the `PrimitiveBoolean` that drives its `ComfySwitchNode`s) |
| 时长 | The `PrimitiveFloat` (seconds) behind the template's frame-count expression; 24 fps, snapped to 17k+5 frames |
| 清晰度: 480P / 720P / 768P | `ResolutionSelector.megapixels`: 0.4 / 0.88 / 1.0 (864×480, 1280×736, 1376×768 at 16:9) |
| 画幅 | `ResolutionSelector.aspect_ratio`, options read from `/object_info` |
| 复用运动（种子） | Every `RandomNoise.noise_seed`; left empty, a random seed is used and recorded |
| 参考图精度 | `ref_image_size` (`match` or `max`) on the reference node |

The **生成方式** in the reference section picks the workflow:

| Material | Mode | Workflow (`studio:` key) |
| :--- | :--- | :--- |
| None | Text to video | `t2v` |
| 首帧 (+ optional 尾帧) | First/last frame | `i2v` |
| 参考图 / 参考视频 / 参考声音 | References | `r2v` |
| Any 对口型 / 固定画面 anchor | References plus pinned anchors | `keyframes` |

Reference tags follow the order `MiniMaxH3ReferenceToVideo` presents them: images are `<Picture i>`. A
reference video whose soundtrack is used gets its `<Audio j>` right before its `<Video k>`, and standalone audio
comes last. Each tile shows its tag, and clicking the tag inserts it into the description. **插入结构化模板**
writes the six-section prompt layout (`subject_definitions`, `summary`, `retention_analysis`,
`detailed_description`, `overall_soundscape`, `non_diegetic_music`), which reference material needs to work
well.

Anchors pin a picture, a video clip or an audio track at a second (`MiniMaxH3AddGuide`). Picture anchors land on
their frame. Clip and audio anchors are offered but not yet verified, and the form labels them that way.

## How a run is built

The Studio never stores or writes a graph. For each mode it:

1. Loads the installed workflow (`/kit/workflows/<id>.json`, already remapped for the profile's model aliases)
   into the frontend. It takes the frontend's own `graphToPrompt()` result, then closes the temporary tab. This
   happens once per mode per page load.
2. Patches that API prompt (`patch.js`). It sets the values above, replaces the template's sample media with
   uploads (stock `LoadImage`, `LoadVideo` + `GetVideoComponents`, `LoadAudio` nodes), and rebuilds the anchor
   chain by cloning the template's own anchor unit. It then drops nodes no output depends on.
3. Checks every model filename against `/object_info`. If the mode's models are not on the GPU yet (the `ref2va`
   models are fetched on demand), it offers to download them with `POST /_gate/fetch` and shows the size from
   `/kit/info`.
4. Uploads the files with `POST /upload/image` and queues the prompt with `POST /prompt`. The form values travel
   in `extra_data.kit_studio`, so `/history` can rebuild a record on another browser.

Progress comes from ComfyUI's websocket events: queue position, phase, sampling steps with a remaining-time
estimate, and live preview frames when **生成中预览** is on. A 10-second `/queue` + `/history` poll covers missed
events.

## Where results live

The Colab disk is wiped when the GPU is released, so the Studio copies each finished video into the browser's
IndexedDB (database `kit-studio`). It does the same for the reference files of every run, up to 300 MB each.
Records, playback, download and **复用** keep working after the GPU is gone.

- Storage is per browser and per origin. `127.0.0.1:18188` and `localhost:18188` are different origins.
- Clearing site data deletes the records. Download what matters. **设置** shows usage and can request
  persistent storage, and can download every finished video automatically.
- Deleting a record removes its video and any reference file no other record uses. It also deletes the entry
  from ComfyUI's history.

## Keeping the GPU awake

Behind the gate, the Studio's requests go through the proxy: ComfyUI's websocket counts as an open page and every
request counts as activity. Through an SSH tunnel the gate sees nothing, so the Studio tells it two things at the
gate address in **设置** (default `http://localhost:8080`). Both are no-cors requests, because the gate is another
origin:

- **The page is open:** `GET /_gate/presence?cid=…` every 30 s while the page is open. It counts like the gate's own
  tab for the `page_closed` rule but is not activity, so an open page you stopped using still idles out
  ([AUTO_STOP.md](AUTO_STOP.md)).
- **Someone is working:** `GET /queue` every 30 s while a job is queued or running, a model download is pending, or
  you used the page in the last 10 minutes. It resets the idle timer without waking anything. The gate's own queue
  probe cannot see ComfyUI through a tunnel, so a long render would otherwise look idle.

Both pings are timed by a dedicated Web Worker. Chrome throttles a background tab's own timers to about once a minute
after 5 minutes, which is too slow for the gate's 60-second `page_closed` window. Without the worker, a render
waiting in a background tab got its GPU released mid-run.

The model download button works the same way: it sends a no-cors `POST /_gate/fetch`, then watches `/object_info`
until the files appear.

## Limits

- One model family per profile today: the Studio patches the stock MiniMax-H3 nodes. Other profiles keep App
  mode and the graph.
- The first run after a wake loads the models, which takes several minutes on the full-precision G4 profile.
  So does the first run after switching between text/first-frame and reference modes, because the two use
  different DiTs. The time estimate is learned from your own completed runs.
- ComfyUI keeps its queue and history in memory: a VM restart loses jobs that had not finished, and the Studio
  marks them 已中断.
