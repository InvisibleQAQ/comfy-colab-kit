---
name: h3-prompt
description: 为本仓库的 MiniMax H3（本地 ComfyUI 和 Studio 页面，没有 H3-Context-IR）写视频提示词并做机械检查。需要写、改、检查 H3 提示词时使用，包括文生视频、首帧或首尾帧、参考图 / 参考视频 / 参考声音（ref2va）、固定画面锚点、对白和音色。提供模式判定、标签编号规则、填空模板、检查脚本和带证据等级的经验。不负责开机、上传素材和驱动 Studio，这些见 h3-video-remake 技能和 docs/STUDIO.md。
---

# H3 提示词写作

官方推荐的流程是先由 H3-Context-IR 把用户的自由描述改写成结构化提示词，再交给 H3-Base 生成。H3-Context-IR 只以付费托管 API 提供，本仓库在 Colab 上只跑 H3-Base，所以提示词会原样进入模型。2026-11-17 用自由描述测试时，参考图和参考音频没有效果；改成官方结构化格式后才生效。

本技能只写本地使用需要的内容：模式和格式的对应关系、标签编号、模板、检查脚本，以及官方指南没有覆盖的经验。字段写法的细节以官方指南为准。

## 官方资料

以下链接固定到 2026-11-18 核对过的版本。

| 资料 | 内容 |
| :--- | :--- |
| [基础模式指南](https://huggingface.co/MiniMaxAI/MiniMax-H3/blob/0919fb684102ef115126612f3fbb84d1027e7317/docs/VIDEO_PROMPT_WRITING_GUIDE_base_en.md) | T2VA / I2VA / FL2VA / L2VA 的首行、三个字段、镜头、运镜、台词 |
| [参考模式指南](https://huggingface.co/MiniMaxAI/MiniMax-H3/blob/0919fb684102ef115126612f3fbb84d1027e7317/docs/VIDEO_PROMPT_WRITING_GUIDE_ref_en.md) | ref2va 的六节结构、标签、保留标记、完整范例 |
| [官方示例请求](https://huggingface.co/MiniMaxAI/MiniMax-H3/tree/0919fb684102ef115126612f3fbb84d1027e7317/scripts/readme) | `reproducible-768p-*.sh` 里是可直接喂给 H3-Base 的完整提示词 |
| [官方 skills](https://github.com/MiniMax-AI/MiniMax-H3/tree/199b7d0e1fd95e7b3eafa8c15eca692534142427/skills) | `h3-prompt-writing` 只是包装上面两份指南；其余 8 个风格技能依赖 MiniMax Hub 的 Context-IR，写的是自由描述，不能照搬到本地 |
| [官方答疑 #71](https://huggingface.co/MiniMaxAI/MiniMax-H3/discussions/71) | Subject 互相引用、`partially_preserved` 的含义、重复描述的作用 |

写提示词前，先把两份指南下载到已被 gitignore 的目录里读一遍：

```bash
mkdir -p outputs/h3-prompt-research/hf
B=https://huggingface.co/MiniMaxAI/MiniMax-H3/resolve/0919fb684102ef115126612f3fbb84d1027e7317/docs
curl -fsSL "$B/VIDEO_PROMPT_WRITING_GUIDE_base_en.md" -o outputs/h3-prompt-research/hf/base_en.md
curl -fsSL "$B/VIDEO_PROMPT_WRITING_GUIDE_ref_en.md" -o outputs/h3-prompt-research/hf/ref_en.md
```

这两份文档受 MiniMax H3 社区许可证约束（适用地区有限，再分发要附 NOTICE），不要复制进仓库。官方 skill 可以用 `npx skills add https://github.com/MiniMax-AI/MiniMax-H3 --skill h3-prompt-writing` 安装到 `.claude/skills/h3-prompt-writing/`，是否安装由用户决定。

## 硬性规则

1. 提示词正文用英文。只有 `<d>…</d>` 里的台词和画面里真实出现的文字（放在英文双引号里）保留原文。
2. 先判定模式（第 1 步），再用对应模板。模式错了，格式就全错。
3. 标签编号严格按节点的输入顺序（第 2 步）。锚点（固定画面）不占 `<Picture N>` 编号。
4. 台词只写在主描述里（ref2va 是 `detailed_description`，其他模式是 `integrated_multimodal_description`），内容和用户确认的转写逐字一致。
5. 镜头切换写成 `[Shot N] At MM:SS.mmm, the shot cuts to …`，不写 `[5s-8s]` 这类范围。
6. 不写「不要出现 X」这类禁止句。本地流程没有反向提示词，写出 X 反而可能把 X 招进画面。直接写画面里有什么。
7. 只写本段时间内发生的事，不写整条视频的梗概。
8. 运行检查脚本，0 个 ERROR 才能提交生成。WARN 要么改掉，要么在交付说明里写明保留的理由。
9. 生成要开 G4 计费，提交前先征得用户同意。

## 第 1 步：判定模式

| Studio 模式 / ComfyUI 输入 | 模型 | 提示词格式 | 模板 | 检查参数 |
| :--- | :--- | :--- | :--- | :--- |
| 文生视频（`t2v`） | fl2va | 三个字段，没有首行 | `templates/t2va.txt` | `--mode t2va` |
| 首帧（`i2v`，只有首帧） | fl2va | I2VA 首行 + 空行 + 三个字段 | `templates/i2va.txt` | `--mode i2va` |
| 首帧 + 尾帧（`i2v`） | fl2va | FL2VA 首行 + 空行 + 三个字段 | `templates/fl2va.txt` | `--mode fl2va` |
| 只有尾帧（只能在 ComfyUI 里接 `last_frame`） | fl2va | L2VA 首行 + 空行 + 三个字段 | `templates/l2va.txt` | `--mode l2va` |
| 参考（`r2v`） | ref2va | 六节 | `templates/ref2va.txt` | `--mode ref2va` |
| 参考 + 固定画面（`keyframes`） | ref2va | 六节，加锚点写法 | `templates/ref2va.txt` | `--mode ref2va --anchors …` |

- Studio 不会自动加首行。`i2v` 模式的首行必须写进提示词，并且一字不差。
- FL2VA 首行里的 `Picture 1`、`Picture 2` 官方写法不带尖括号，L2VA 和 I2VA 带尖括号，照模板抄。
- 不要用 Studio 的「插入结构化模板」按钮生成骨架，原因见「已知问题」。

## 第 2 步：列出素材清单

动笔前，先在工作笔记里写一张表：标签、文件、作用。编号规则来自 ComfyUI 的 `MiniMaxH3ReferenceToVideo` 节点源码：

- `<Picture i>`：参考图按上传顺序编号，从 1 开始。
- `<Video k>`：参考视频按上传顺序编号，和图片、音频分开计数。
- `<Audio j>`：先数参考视频的原声（只有接了原声的视频才算，每条原声排在它的视频之前），再数独立参考音频，按上传顺序。
- 锚点经 `MiniMaxH3AddGuide` 只进潜空间，文本编码器看不到，不占编号。正文里写 `the pinned first frame`、`the pinned keyframe at 00:04.400`。官方多帧模板把锚点也写成 `<Picture N>`，但它只把第一张图接进了参考图，其余几个标签指向的是没有接上的图。如果确实想让文本引用锚点图，要把这张图同时作为参考图上传，它会占一个 `<Picture N>`。这种做法本仓库没有测过。
- 说话人编号 `(S1)`、`(S2)` 按台词在本段里首次出现的顺序分配，和 `<Subject N>` 的编号无关。
- 只给本段有台词的说话人上传音色参考。本段不说话的角色只放人物参考图，不给 `<Audio>`；多给的音频没有对应台词，检查脚本会报 `[speakers]` 错误。
- 人物参考图只有脸部特写时，先从干净的原片帧里裁一张半身图（见 h3-video-remake 第 5 步）。实在裁不到，就在 Subject 定义里把身体和服装写全，并告诉用户身体和服装可能保持不住。

数量和时长限制：

| 项 | 限制 | 来源 |
| :--- | :--- | :--- |
| 参考图 | 最多 9 张 | 节点 |
| 参考视频 | 最多 3 段，必须是 24 fps（节点按 24 fps 读取，不看元数据） | 节点、Comfy 文档 |
| 独立参考音频 | 最多 3 段 | 节点 |
| 每段参考音频 | 2–15 秒 | MiniMax 平台文档 |
| 参考音频合计 | 不超过 15 秒（本地节点不拦，超出属于训练分布外） | MiniMax 平台文档 |
| 视频时长 | 4–15 秒 | MiniMax 平台文档、节点提示 |

## 第 3 步：按模板写

### ref2va 的六节

**`subject_definitions`**

- 每个需要单独跟踪的对象占一行：人物、场景、需要单独跟踪的道具、每段参考音频。
- 只用来定义人物或场景的图，写在对应的 `<Subject N>` 里（`<Subject 1> is … in <Picture 1>`），不单独起一行。只有当图本身就是某个镜头的首帧或构图锚点时，才单独写 `<Picture N> is the first frame of [Shot 1] …`。
- 人物参考图用全身或半身图。社区实测：只给脸部图时，原视频里的身体和服装会保留下来。
- 每段参考音频写一行：`<Audio j> is the voice-timbre reference for <Subject n> (Sx): <嗓音描述>`。嗓音描述写音高、年龄感、质感、语速、气息、情绪，15–30 个英文词。复刻时可以直接用声音对比提示词输出的 `how_to_describe_original_in_english`。

**`summary`**

- 开头方括号里写任务类型，多个类型用 ` + ` 连接，不重复：

| 任务类型 | 什么时候用 |
| :--- | :--- |
| `keyframe completion` | 有锚点，或某张图是首帧、关键帧、尾帧 |
| `reference generation` | 图、视频、音频只用来指导人物、场景、风格、动作或运镜 |
| `video editing` | 直接修改一段源视频；这时正文以 `The target video is an edited version of <Video 1>.` 开头 |
| `video continuation` | 从源视频的结尾接着往下生成 |
| `audio reuse` | 原样复用音频信号（全部或部分） |
| `audio reference` | 只参考音色、风格、节奏，不复用信号 |

- 用一段话按播放顺序讲清谁做了什么，点出全部锚点时间。
- 不引入 `subject_definitions` 里没有的标签。

**`retention_analysis`**

- `subject_definitions` 里每一行对应这里一行。
- 画面类标签（Subject / Picture / Video）用 `fully_preserved`、`partially_preserved`、`attribute_transfer`、`weak_reference`。
- 音频标签用 `fully_copy`、`partially_copy`、`reference`、`weak_reference`。音色参考用 `reference`。
- `(appears in …)` 只列这个对象出现的镜头。只在部分镜头出现，仍然用 `fully_preserved`。
- 某个镜头里只露出一部分，不算 `partially_preserved`。官方答复：`partially_preserved` 指定义过的特征被改动或只用了一部分。
- 这一节不写 `(Sx)`。

**`detailed_description`**

- 先写一两句画风：媒介、线条、上色、色调、光线、镜头习惯。
- 然后逐个镜头写。`[Shot 1]` 不带时间，之后的镜头以 `At MM:SS.mmm,` 开头，时间递增且在时长以内。社区对比显示，这种写法比范围写法的切点更准（n=2）。
- 每个镜头写清：景别和角度、每个人物的位置、动作和状态变化、运镜、声音、台词出现的位置。
- 台词之间的小动作逐条写，一个动作一句，并写出它发出的声音。社区报告：模型做完一个小动作约 1.2 秒后就会静止，每段安排 2–4 个动作比较合适。
- 道具每次出现都写清状态（例如「屏幕已黑」「杯子放回桌上」），否则可能多出一个。
- 每句台词都写成 `<Subject n> (Sx) <语气>, <d>[Chinese] 原文。</d>`。说话人编号每次都要写，语气写在 `<d>` 外面。
- 台词末尾用 `.` `?` `!` 或 `。` `？` `！`，不用省略号、波浪号和表情符号。
- 有字音的语气词（`吼？`、`哎！`、`嗯？`）按台词写进 `<d>`，同样要有说话人编号。没有字音的呼吸、笑声、叹气写成动作的声音（`he lets out a short laugh`），不进 `<d>`。这条依据官方指南对台词和非语言人声的划分，本仓库没有单独测过。
- 多人对白容易张冠李戴。把台词绑在可见的动作上（「他放下主机后说」），不要只靠时间点。
- 画外音写成 `says in an off-screen voiceover:`，`</d>` 之后紧接着写 `while <Subject n>'s lips remain completely closed`。不要用画面里人物的称呼（如 `the man`）指代旁白。这一项社区反馈时灵时不灵，用之前告诉用户。
- 不让一句台词跨过切点或片尾。`<scenetrans>` 和 `<cutoff>` 本仓库没有测过，而且 tokenizer 里的特殊符号是 `<|cutoff|>`，和指南里的写法不一致。
- 运镜用指南里的词：`push in`、`pull out`、`pan left/right`、`truck left/right`、`tilt up/down`、`pedestal up/down`、`arc shot`、`tracking shot`、`static shot`、`shake slightly/strongly`。需要时加 `with small/large amplitude`、`at slow/fast speed`。运镜只靠文字控制，参考视频传递运镜没有验证过。
- 时长向上取整会多出零点几秒。最后一个动作之后，写人物保持的状态一直到结束，例如 `… and the two hold that stare until the video ends.`
- 生成类提示词这一节一般 350–500 个英文词，台词多时可以更长。
- 原片这段有字幕、标题或贴纸，并且准备后期再加时，最后一句写 `No subtitles or on-screen text appear.`。原片这段没有画面文字就不写。这句在 seg1 里有效（输出没有字幕），但它是否定句，和规则 6 有冲突，没做过对比测试。
- 规则 6 也适用于画风句和运镜。写 `a static eye-level camera`，不写 `a camera that never moves`。

**`overall_soundscape`**

- 一到四句：环境声和动作发出的声音。不写台词，不写配乐。
- 只有整段完全无声时才写 `N/A`。

**`non_diegetic_music`**

- 没有背景音乐时写 `N/A`。
- 复刻时原片这段有背景音乐，先问用户选哪种做法，用户没回答之前不要自己定：
  - 让 H3 生成配乐：按视频分析里的配乐描述写乐器、速度、音量变化。
  - 后期叠加原片配乐：这里写 `N/A`，成片时再混音。

  两种做法本仓库都没测过。
- 有背景音乐时写乐器、速度、音量怎样变化，不写抽象的情绪词。
- 复用参考音频里的配乐时，写明它和 `<Audio j>` 的关系（`<Audio 1> is reused as the score`），并把任务类型加上 `audio reuse`。这种做法本仓库没有测过。

### 按素材调整 ref2va 模板

`templates/ref2va.txt` 按「2 张人物图 + 1 个场景 + 2 段音色 + 锚点」的复刻场景写成。素材不同时，按下表增删，每一处都要改，检查脚本会抓漏改的标签和 `pinned` 字样。

| 情况 | 要改的地方 |
| :--- | :--- |
| 没有锚点（Studio `r2v` 模式） | 删掉所有含 `pinned` 的句子：`summary` 里的 `The video starts from the pinned first frame…`、`[Shot 1]` 里的 `begins from the pinned first frame`、`At … the frame matches the pinned keyframe`。任务类型去掉 `keyframe completion`。`[Shot 1]` 直接写景别和人物位置。 |
| 场景既没有参考图也没有锚点 | 不定义场景 Subject。删掉 `<Subject 3>` 的定义行和保留行；`summary` 里的 `in <Subject 3>` 改成 `in a <场景名>`；正文里的 `of <Subject 3>` 改成场景的文字描述，在场景第一次完整出现的镜头里写清家具、道具和光线。Subject 只用于从参考素材里取来的内容。 |
| 场景有单独的参考图 | `<Subject 3> is the location in <Picture 3>: …`，这张图占一个 `<Picture N>`。 |
| 没有参考音频 | 删掉 `<Audio>` 的定义行和保留行，删掉 `summary` 的 `The voices follow…`，任务类型去掉 `audio reference`。台词前用文字描述嗓音：`<Subject 1> (S1), in a calm, low male voice, says, <d>[Chinese] …</d>`。 |
| 人物或说话人多于两个 | 按同样格式增加 `<Subject N>`、`<Audio j>` 和保留行，编号连续。 |
| 一段音频给一个说话人 | 每个说话人一段音频。说话人和音频必须一一对应才能分清，Comfy 文档也这样建议。 |
| 参考视频是要修改的源视频 | `<Video 1> is the source video for the target video edit.` 单独一行并写保留行；任务类型用 `video editing`；`summary` 以 `The target video is an edited version of <Video 1>.` 开头。 |
| 人物来自参考视频 | 写在 Subject 里：`<Subject 1> is the woman in <Video 1>, …`，不单独写 `<Video 1>` 行。 |
| 参考视频只提供动作或运镜 | `<Video 1> provides the walking motion for <Subject 1>.`，任务类型用 `reference generation`。运镜传递没有验证过，运镜仍要用文字写清。 |
| 用到参考视频的原声 | 只有提示词真的用到原声时才接。它占的 `<Audio j>` 排在独立音频之前，定义写 `<Audio 1> is the synchronized audio track of <Video 1>, providing …`。 |
| 要复用一段配乐 | `non_diegetic_music` 写 `<Audio j> is reused as the score.`，保留行用 `fully_copy` 或 `partially_copy`，任务类型加 `audio reuse`。本仓库没有测过。 |

### 基础模式（T2VA / I2VA / FL2VA / L2VA）

- 主体字段 `integrated_multimodal_description` 以 `[Shot 1] <画风>, <景别>` 开头，镜头、运镜、台词、画内声音都写在这一个字段里。
- I2VA：先写首帧里的人物、构图、场景，再写动作开始、发展和结果。
- FL2VA：重点写首帧到尾帧之间的变化路径，一般只用一个镜头，最后落到 Picture 2 的构图。
- L2VA：先推一个能自然走到尾帧的起始状态，最后落到 `<Picture 1>`。
- 首帧会被拉伸到画布尺寸（不裁剪），首帧图的宽高比要和输出一致。

## 第 4 步：运行检查

1. 把用户确认过的台词写进 `lines.txt`，一行一句，内容就是 `<d>[Chinese] ` 之后、`</d>` 之前的原文。
2. 运行检查。复刻一段 10 秒、2 张参考图、2 段音色、4 个锚点的例子：

   ```bash
   python .claude/skills/h3-prompt/scripts/h3_prompt_lint.py segN/prompt_vK.txt \
     --mode ref2va --images 2 --duration 10 --anchors 0,4.4,6,8.3 \
     --lines segN/lines.txt --audio-files segN/refs/voice_a.wav segN/refs/voice_b.wav
   ```

   参数按第 2 步的清单填：`--images` 是参考图数量，`--videos` 是参考视频数量，`--video-audios` 是接了原声的参考视频数量，`--audio-files`（或 `--audios`）是独立参考音频。其他模式只需要 `--mode` 和 `--duration`。
3. 读结果：
   - `ERROR`：必须改。脚本会说明哪一行、哪条规则。
   - `WARN`：逐条判断。确实要保留的，在交付说明里写理由。
   - `NOTE`：只是提示。其中 `[audio-map]` 会列出每个 `<Audio j>` 对应的文件和说话人，必须逐行核对。
   - 退出码 0 表示没有 ERROR。

检查脚本只管格式、编号、时间和台词，判断不了描述写得好不好。两段音频上传顺序弄反时，数量没变，脚本不会报错，只能靠 `[audio-map]` 人工发现。

## 第 5 步：人工核对

检查通过后，再逐项看一遍：

- 动作顺序是否和原片或用户需求一致，台词之间的小动作有没有漏掉。
- 每个锚点时刻的文字描述，是否和锚点图里的状态一致（姿势、道具、屏幕亮或黑）。
- 嗓音描述是否和参考音频一致，男女、老少、语速有没有写反；`[audio-map]` 里每个 `<Audio j>` 的文件和说话人是否对得上。
- 有没有写进本段以外的事件或道具。
- 是否仍有否定句。

## 经验和证据等级

| 经验 | 证据 | 来源 |
| :--- | :--- | :--- |
| 本地必须用结构化格式，参考才生效 | 本仓库实测 | 2026-11-17 自由描述无效，11-18 结构化有效 |
| `<d>[Chinese] …</d>` 能正确生成中文台词 | 本仓库实测，1 段 5 句全对 | 2026-11-18 seg1 |
| 锚点写成 `pinned first frame` / `the frame matches the pinned keyframe` 时生成正常 | 本仓库实测，n=1；锚点靠 AddGuide 落帧，这种措辞本身的作用没有单独测过 | 2026-11-18 seg1（多帧模板测试用的是官方 `<Picture N>` 措辞） |
| ref2va 的 4 步 Lightning 把一句台词提前了 2 秒，定稿用标准 20 步 | 本仓库实测，n=1 | 2026-11-18 seg1 |
| 音色参考用没有配乐的原片片段，比分轨分离出的人声更像 | 本仓库实测，主观判断 | 2026-11-18 seg1 |
| `At MM:SS.mmm` 比范围写法切点更准 | 社区报告，n=2，也有反例 | [MiniMax-H3 #125](https://huggingface.co/MiniMaxAI/MiniMax-H3/discussions/125) |
| 一个小动作约 1.2 秒后人物静止；每段 2–4 个动作 | 社区报告 | [MiniMax-H3 #124](https://huggingface.co/MiniMaxAI/MiniMax-H3/discussions/124) |
| 否定句会把被否定的东西招进画面 | 社区报告 + Comfy 文档 | #124、[Comfy 提示词指南](https://docs.comfy.org/tutorials/video/minimax/minimax-h3-prompt-guide) |
| 只给脸部图会保留原视频的身体和服装 | 社区报告 | #125 |
| 道具不逐段写明状态会多出一个 | 社区报告 | #124 |
| 省略号降低台词清晰度；多说话人可能错配 | Comfy 文档 | Comfy 提示词指南 |
| 画外音仍可能驱动口型 | 社区报告，未解决 | [Comfy-Org/MiniMax-H3 #44](https://huggingface.co/Comfy-Org/MiniMax-H3/discussions/44) |
| 参考视频传递运镜 | 未验证（本仓库 1 次测试没有传递） | 2026-11-18 |
| 用户提供的语音轨驱动口型 | 未测试 | — |
| 配乐段（`non_diegetic_music` 不是 `N/A`）怎么写最好 | 未测试 | — |

## 已知问题

- Studio 的「插入结构化模板」按钮生成的骨架和官方格式不一致：把台词放进了 `overall_soundscape`，背景音乐写 `None`，每个锚点都新开一个 `[Shot]`（锚点不一定是切点），缺少开头的画风句，`retention_analysis` 缺少 `(appears in …)`。修好之前不要用这个按钮。
- `../h3-video-remake/prompts/h3_prompt_example.txt` 是用户验收过的 seg1 v2 提示词，保持原样作为运行记录。它和本技能有三处不一致，检查脚本会报 3 个 WARN：`non_diegetic_music` 写的是 `None.`（应为 `N/A`）；最后一句台词前没有写 `(S2)`；`Without a word` 是否定句。

## 试跑记录

2026-11-18，一个只读过本技能的代理（Sonnet）为复刻视频的 seg2（无锚点、有背景音乐、只有一句语气词）写了提示词，检查两轮后 0 个 ERROR，提示词还没上 GPU 生成。试跑暴露的问题已补进上文：不说话的角色不给音频、语气词怎么写、时长取整多出的时间、去掉场景 Subject 时怎么改、只有脸部图怎么办、原片有配乐时先问用户、画风句里的否定词。试跑结果在 `outputs/douyin-7689117858923629851/seg2/dryrun/`（不进 git）。

## 文件

| 文件 | 用途 |
| :--- | :--- |
| `templates/ref2va.txt` | 参考 / 参考 + 固定画面 |
| `templates/t2va.txt`、`i2va.txt`、`fl2va.txt`、`l2va.txt` | 基础模式 |
| `scripts/h3_prompt_lint.py` | 检查脚本，测试见 `tests/test_h3_prompt_lint.py` |
| `../h3-video-remake/prompts/h3_prompt_example.txt` | 已验收的复刻提示词（含上面三处不一致） |
