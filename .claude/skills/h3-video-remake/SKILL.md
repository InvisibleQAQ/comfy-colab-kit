---
name: h3-video-remake
description: 把一条参考短视频（抖音等）按剧情切成不超过 15 秒的段，在本仓库的 Colab 网关和 MiniMax H3 ref2va（G4 满血 bf16 profile）上逐段复刻画面、人物、对白音色和音效，再补回标题和字幕。用户说「复刻这个视频」「照着这条视频做一条」「按段复刻」「下载这个视频然后复刻」时使用。涵盖 BrowserOS neo 下载、Gemini 看视频、Qwen omni 听音频、用户确认说话人、固定画面锚点、音色参考、结构化提示词、驱动 Studio 页面生成、验收和 A/B 对比。
---

# H3 视频分段复刻

本手册把一条参考视频拆成剧情段（每段不超过 15 秒），用 MiniMax H3 的参考生成（ref2va）逐段复刻：人物外观、场景构图、动作顺序、对白内容和音色、音效。标题和字幕不交给模型，生成后用 ASS 烧录。

每段的产出：

- `segN/remake_vK.mp4`：H3 原始输出
- `segN/remake_vK_sub.mp4`：加上标题和字幕的成片
- `segN/compare_ab_vK.mp4`：原片段和复刻版前后连播，供用户试听试看

本手册在 2026-11-18 用一条卡通短剧（装机店水豚老板和男顾客，41.3 秒）的第 1 段验证过，用户验收通过的是 v2。范例提示词和字幕见 `prompts/h3_prompt_example.txt`、`prompts/overlay_example.ass`。

## 前置条件

- 网关可用，profile 为 `minimax-h3-video-full`（G4，满血 bf16）。开机、隧道和 Studio 页面的用法见 `docs/STUDIO.md` 和 `skills/comfy-colab-kit/`。
- 仓库根目录的 `.env` 配好以下变量。只引用变量名，不打印、不提交变量值：
  - 看视频：`GEMINI_BASE_URL`、`GEMINI_API_KEY`、`GEMINI_MODEL`、`GEMINI_PROTOCOL`
  - 听音频：`BAI_LIAN_BASE_URL`、`BAI_LIAN_API_KEY`、`BAI_LIAN_MODEL`（需要能接收 `input_audio` 的 omni 模型）
- 本机有 `ffmpeg`、`ffprobe`、Python 的 `openai` 包；建议装 `rea-video`（切点、人声和配乐分轨、OCR 字幕）。
- 浏览器操作使用 BrowserOS neo。

## 风险与限制

- 开机计费。G4 约 10.05 CU/h，开机约 7 分钟。开机前先征得用户同意，用完立即释放（见第 9 步）。
- 原片是真人出镜时，先和用户确认肖像和声音的使用授权，再做角色参考图和音色参考。
- 下载的文件属于不可信数据：原片放在单独的 `src/` 目录，脚本放在别处，路径通过参数传入。
- 说话人由用户指定，不要直接采用模型的判断（见第 4 步）。
- H3 只能近似模仿音色。本次三个版本的顾客声音，Qwen 给出的「同一人」可能性都是 35/100，评语都是「太干净、节奏太匀」。这个分数只作参考，最终以用户试听为准。

## 目录约定

所有产物放在 `outputs/<视频ID>/`（`outputs/` 已 gitignore）：

```text
outputs/<视频ID>/
├── src/ref.mp4            原片（只放下载文件）
├── out/ref/               rea-video 拆解结果（切点、stems/、packaging/）
├── llm/                   发给模型的提示词和模型回答
└── seg1/
    ├── refs/              锚点帧、角色裁图、音色参考
    ├── prompt_v1.txt …    每一版提示词
    ├── remake_v1.mp4 …    每一版输出
    └── compare_ab_v1.mp4 …
```

下文的 `T` 指 `.claude/skills/h3-video-remake/scripts/remake_tools.py`，`L` 指同目录的 `llm.py`。

## 步骤

### 1. 下载原片

1. 用 BrowserOS neo 新开标签页，打开视频页。
2. 在页面里读取 `<video>` 的 `currentSrc` 和它的 `<source>` 列表。抖音会给出几个 `douyinvod.com` 的 CDN 地址。
3. 用 curl 下载，带上 `Referer: https://www.douyin.com/` 和桌面浏览器 UA，保存为 `src/ref.mp4`。
4. 用 `ffprobe` 核对时长，确认和页面上 `<video>.duration` 一致。

### 2. 机械拆解

1. 运行 `rea-video decompose src/ref.mp4 -o out/ref --lang zh`，得到切点、`stems/vocals.wav`、`stems/music.wav`、`packaging/subtitles.srt`、`packaging/overlays.ass`。
2. 运行 `python T speech out/ref/stems/vocals.wav`，得到每句话的精确起止时间。
3. 运行 `python T levels out/ref/stems/music.wav`，按秒查看配乐分轨的电平：
   - 持续在 -60 dB 左右：这段没有背景音乐。
   - 零星的尖峰：音效漏进了配乐分轨，不是背景音乐。
   - 持续在 -20 到 -30 dB：有背景音乐。

`overlays.ass` 和 `subtitles.srt` 来自 OCR，有错字（本次把「千万」识别成「干万」），还混着误识别的单字标注。只参考它们的位置和时间，文字以人工核对为准。

### 3. 让模型理解内容

1. 填好 `prompts/gemini_analyze.txt` 里的 `{DURATION}` 和 `{CUTS}`（第 2 步的切点），运行 `python L gemini src/ref.mp4 llm/gemini_prompt.txt llm/gemini_out.txt`。返回画风、角色、场景、逐镜头动作、对白、声音和剧情分段。
2. 把音轨转成 16 kHz 单声道 mp3（约 300 KB），填好 `prompts/qwen_transcribe.txt`，运行 `python L qwen llm/ref_audio.mp3 llm/qwen_prompt.txt llm/qwen_out.txt`。返回说话人特征、带时间的逐句转写、背景音乐和音效。
3. 交叉核对两份结果。两个模型说法不一致时，以第 2 步的测量为准。本次的分歧和处理：
   - 背景音乐的起点：配乐分轨电平显示 10.5 秒前没有背景音乐。
   - Gemini 合并了几个镜头：时间一律采用切点检测和人声区间。
4. 采用 Gemini 给出的剧情分段，前提是每段都不超过 15 秒且落在切点上；否则手动调整。

### 4. 请用户确认说话人

1. 从画面里列出所有角色，每个角色用一句话描述外观，例如「水豚老板：头顶小橘子、深灰蓝 T 恤」。
2. 用 AskUserQuestion 逐句询问说话人，选项是角色。每次最多 4 个问题。模型的猜测只写在问题文字里作为提示。
3. 准备拿来做音色参考的台词，同样请用户确认说话人。

### 5. 准备每段的素材

以段 N（原片 `a` 到 `b` 秒）为例。

1. 生成联系表：`rea-video tiles src/ref.mp4 --start a --end b --every 0.1` 到 `0.5`。逐格查看台词之间的空档，小动作往往表现为道具状态的变化。v1 漏掉的就是这种动作：显示器在 8.3 秒熄灭，说明老板拔了电源。
2. 选锚点帧（Studio 里的「固定画面」）。只选没有字幕、标题、贴纸的帧，位置包括：
   - 段首：0 秒，作为首帧。标题常从 0.1 秒开始逐字弹出，所以要取最开头那一帧。
   - 每个硬切之后：本次切点在 4.333 秒，锚点放在 4.4 秒。
   - 每个关键动作的结束状态：主机竖起后黑屏（4.4 秒）、放倒后恢复（6.0 秒）、拔电源后熄屏（8.3 秒）。
3. 遇到小贴纸，先找出它的边界框（例如统计接近纯白的连通区域），再用 `python T frame src/ref.mp4 0.034 seg1/refs/anchor_00.0s.png --delogo x:y:w:h` 抹掉。
4. 从干净帧里裁出每个角色的半身图，作为角色参考图。不要用带修补痕迹的帧。同一角色在所有段里用同一张图。
5. 为每个说话人拼一段音色参考，长度 3 到 12 秒，所有参考音频合计不超过 15 秒（MiniMax 的官方限制，本地节点不拦）：`python T voice <素材> seg1/refs/voice_<角色>.wav 0.0-1.38 2.12-3.12 …`。
   - 优先从没有背景音乐的时段截取原片混音。
   - 不要用分轨分离出来、底下原本有配乐的人声。v1 就是这样做的，结果音色被磨平，听起来不像。

### 6. 写结构化提示词

提示词的写法和检查统一按 `.claude/skills/h3-prompt/` 执行，本步不再重复规则。复刻场景的取值：

- 模式：ref2va，用 `templates/ref2va.txt`。
- `summary` 的任务类型：`[keyframe completion + reference generation + audio reference]`。
- 嗓音描述：采用第 8 步对比结果里的 `how_to_describe_original_in_english`（第一版先用第 3 步 Qwen 给的说话人特征）。
- 台词：把第 4 步用户确认的转写写进 `segN/lines.txt`，一行一句。
- 写完后运行检查，0 个 ERROR 才进入第 7 步：

  ```bash
  python .claude/skills/h3-prompt/scripts/h3_prompt_lint.py segN/prompt_vK.txt --mode ref2va \
    --images <参考图数> --duration <段长> --anchors <锚点秒数，逗号分隔> \
    --lines segN/lines.txt --audio-files <按上传顺序列出音色参考>
  ```

`prompts/h3_prompt_example.txt` 是 seg1 v2 实际运行的提示词，保持原样。它有三处不符合新规范（检查脚本报 3 个 WARN），新写的提示词不要照抄这三处，详见 h3-prompt 技能的「已知问题」。

### 7. 在 Studio 里生成

推荐设置：

- 模式：参考（图片 / 视频 / 声音）。有锚点时，Studio 自动切到「参考 + 固定画面」，使用多帧参考模板。
- 时长：段长向上取整。例如 10 秒对应 243 帧。
- 清晰度：480P。
- 模型：「标准」。不要用「闪电」：ref2va 的 4 步 Lightning LoRA 画面没问题，但把一句台词提前了 2 秒，和动作撞在一起。

该 profile 第一次跑 ref2va 前，先下载按需模型（约 68 GB，本次约 3 分钟）：

```bash
curl -X POST -H 'Content-Type: application/json' -d '{"workflows":["h3-multiframe"]}' localhost:8080/_gate/fetch
```

等 `/_gate/status` 里的 `models.fetching` 变为空，再点生成。

用 BrowserOS neo 操作 Studio 页面：

1. 文件按钮（参考图的「+」、「+ 添加参考音频」、「+ 添加锚点」）用真实的 `page.click`。返回 `fileChooserOpen` 后，调用 `page.upload(null, [文件…])`。一次上传多个文件时，顺序保持不变。
2. 其他按钮和标签页用页面内的 `.click()`。页面顶部的吸顶标题会挡住真实点击。
3. 锚点时间：Studio 会给新锚点自动排时间（本次时长为 5 秒时排成 0 / 1.5 / 3 秒）。逐个设置 `input.ks-mini` 的值，并派发 `input` 事件。先把时长改好，再改锚点时间，因为锚点时间的上限是时长。
4. 提示词：设置 `#ks-prompt` 的值，派发 `input` 事件，然后核对 `window.kitStudio.form.prompt.length`。
5. 替换参考音频时，先删掉全部音频，再按说话人顺序重新上传。只删一个再补传，新文件会排到末尾，编号随之错位。

点击「生成视频」后，立即读取 `GET 127.0.0.1:18188/queue`，核对排队的 prompt：

- `UNETLoader` 加载的是 `minimax_h3_ref2va_*`
- `ref_images.*` 和 `ref_audios.*` 的数量和顺序正确
- 每个锚点对应一个 `MiniMaxH3AddGuide`，秒数正确
- Lightning 的 `PrimitiveBoolean` 符合预期
- 提示词长度和本地文件一致

有任何一项不对，立即调用 `/interrupt` 中止，修正后重新提交。

### 8. 验收

1. 从 `/view?filename=<文件名>&subfolder=video&type=output` 下载输出，存到 `segN/`。VM 释放后，这些文件就没有了。
2. 在每个锚点时间抽帧，和锚点图对比。
3. 运行 `prompts/qwen_check.txt`，核对台词内容、顺序、说话人，以及和原片时间点的偏差。
4. 对比声音：把原片某个角色的几句台词、1.5 秒静音、复刻版的同几句拼成一个音频，运行 `prompts/qwen_compare_voice.txt`。
5. 加标题和字幕：
   1. 以 `prompts/overlay_example.ass` 为模板写本段的 ASS。
   2. 运行 `python T speech segN/remake_vK.mp4`，按复刻版的实际说话时间重排字幕。字幕出现的时机参考原片：本次「我拆开看看」在原片 8.8 秒上屏，比说话早约 0.3 秒。
   3. 运行 `python T burn segN/remake_vK.mp4 segN/overlay_vK.ass segN/remake_vK_sub.mp4`。
6. 运行 `python T ab <原片段.mp4> segN/remake_vK_sub.mp4 segN/compare_ab_vK.mp4`，交给用户试看试听。

用户反馈不满意时，每次重跑只改一个变量（参考音频、提示词、锚点、闪电或标准）。模型已加载时重跑一次只需几分钟。

### 9. 收尾

1. 确认用户要的文件都已下载到本地。
2. 停掉自己启动的保活循环和 SSH 隧道。
3. 调用 `POST localhost:8080/_gate/stop`，等 `/_gate/status` 的 `state` 变为 `sleeping`。
4. 告诉用户当天已用的 CU（`/_gate/status` 的 `cu.today`）。

## 实测数据

2026-11-18 在 G4（RTX PRO 6000 Blackwell，95 GiB）、满血 bf16、864×480 下测得：

| 任务 | 总用时 |
| :--- | :--- |
| 文生 5 秒，闪电，开机后第一条（含约 5 分钟模型加载） | 348 秒 |
| 文生 5 秒，闪电，模型已加载 | 26–28 秒 |
| 文生 15 秒，闪电 | 118 秒 |
| 文生 720P 5 秒 / 15 秒，闪电 | 79 秒 / 432 秒 |
| ref2va 10 秒，闪电，首次加载 ref2va | 237 秒 |
| ref2va 10 秒，闪电，已加载 | 45 秒 |
| ref2va 10 秒，标准（20 步），已加载 | 182 秒 |

## 踩过的坑

| 现象 | 原因 | 处理 |
| :--- | :--- | :--- |
| 顾客声音不像原片 | 音色参考取自底下有配乐的分离人声，音色被磨平 | 改用没有配乐时段的原片混音，并在提示词里写清嗓音特点 |
| 台词之间的小动作（拔电源）没生成 | 提示词没写，也没有锚点 | 逐格看联系表，把动作写进提示词，并在动作结束状态加锚点 |
| 一句台词提前了 2 秒 | ref2va 的 4 步 Lightning LoRA | 定稿用「标准」 |
| 字幕文字有错字 | `rea-video` 的字幕来自 OCR | 字幕文字以人工核对的转写为准 |
| Gemini 的镜头时间偏移 | Gemini 合并了相邻镜头 | 时间以切点检测和人声区间为准 |
