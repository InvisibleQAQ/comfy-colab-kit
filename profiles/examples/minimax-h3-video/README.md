# Profile: `minimax-h3-video`

MiniMax-H3 (MiniMaxAI, 33B omni-modal video model with native audio) on a Colab **A100, standard 40 GB shape**
(measured 2026-11-17: A100-SXM4-40GB, 39.5 GiB usable VRAM, 89.6 GB system RAM, PyTorch 2.14.1+cu130,
~6.7 compute units per hour). The default workflow is **`h3-t2v` (text to video)**; **`h3-i2v` (image to video)**
shares the same files.

- **Accelerator**: the gate allocates `COLAB_ACCELERATOR` from `.env` for every profile, so set
  `COLAB_ACCELERATOR=A100` (and `COLAB_HIGH_MEM=false` for the 40 GB shape) before waking this profile. The
  `accelerator: A100` field documents the intended GPU.
- **DiT**: `minimax_h3_fl2va_pruned_int8_convrot.safetensors` (20.97 GB). "Pruned" drops the 13B parameters of
  the timestep-modulation (AdaLN) branch, which MiniMax notes can be precomputed for inference; Comfy-Org stores
  it as a 1025-step × 8 table (`adaln_t_table`). Attention and FFN weights are untouched; INT8 ConvRot is the
  format Comfy-Org recommends on PyTorch cu130.
- **Text encoder**: `qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors` (15.69 GB), as in the official templates. With
  the DiT it stays resident on the 40 GB card (~34 GiB). The INT8 encoder (27.14 GB) would be offloaded to system
  RAM on every run, next to the RAM model store, so it is not used here.
- **VAEs**: video VAE INT8 ConvRot (2.81 GB) and audio VAE fp32 (0.61 GB).
- **Lightning LoRA**: lightx2v `minimax_h3_fl2v_turbo_8step_v1.0` (1.96 GB). Off by default (20 steps); the
  form toggle switches to 8 steps. The file is always downloaded because the loader references it either way.
- **Workflows are never self-authored**: both are unmodified official Comfy-Org templates (MIT), vendored under
  [`workflows/`](workflows/). **Models are never vendored**: every file is downloaded from Hugging Face and
  checked against its SHA-256.

Source of truth: Comfy-Org MiniMax-H3 release and `workflow_templates` (2026-11), mirrored in
[`profile.yaml`](profile.yaml).

## Workflows

| id — App menu title | Source | License | Shipped as | Default set |
|---|---|---|---|---|
| `h3-t2v` — Video · MiniMax-H3 Text to Video (official) | [Comfy-Org/MiniMax-H3](https://huggingface.co/Comfy-Org/MiniMax-H3) | MIT template; weights MiniMax H3 community license | vendored `workflows/official_minimax_h3_t2v.json` | ✅ default |
| `h3-i2v` — Video · MiniMax-H3 Image to Video (official) | [Comfy-Org/MiniMax-H3](https://huggingface.co/Comfy-Org/MiniMax-H3) | MIT template; weights MiniMax H3 community license | vendored `workflows/official_minimax_h3_i2v.json` | ✅ |

App-mode form: prompt, aspect ratio, megapixels (template default 0.4 MP), duration in seconds (template default
5 s), Lightning toggle and seed; `h3-i2v` adds the first-frame image. Output: `SaveVideo` (video with audio).

### Considered and excluded

| Candidate | Reason |
|---|---|
| `video_minimax_h3_r2v.json` (reference to video) | Needs a second 20.97 GB DiT (`ref2va`) plus its own LoRA; not added until the on-demand path is verified on A100 |
| DiT bf16 (66.28 GB) / pruned bf16 (40.23 GB) | Do not fit a 40 GB A100 next to the text encoder and activations |

## Models

| id | Destination (`models/…`) | Repo | License | GB | Flags |
|---|---|---|---|---|---|
| `dit-fl2va-int8` | `diffusion_models/minimax_h3_fl2va_pruned_int8_convrot.safetensors` | [Comfy-Org/MiniMax-H3](https://huggingface.co/Comfy-Org/MiniMax-H3) | minimax-h3-community-license-agreement | 20.97 | core |
| `te-nvfp4` | `text_encoders/qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors` | [Comfy-Org/MiniMax-H3](https://huggingface.co/Comfy-Org/MiniMax-H3) | minimax-h3-community-license-agreement | 15.69 | core |
| `video-vae-int8` | `vae/minimax_h3_video_vae_int8_convrot.safetensors` | [Comfy-Org/MiniMax-H3](https://huggingface.co/Comfy-Org/MiniMax-H3) | minimax-h3-community-license-agreement | 2.81 | core |
| `audio-vae` | `vae/minimax_h3_audio_vae_fp32.safetensors` | [Comfy-Org/MiniMax-H3](https://huggingface.co/Comfy-Org/MiniMax-H3) | minimax-h3-community-license-agreement | 0.61 | core |
| `lightning-8step` | `loras/minimax_h3_fl2v_turbo_8step_v1.0_comfyui_bf16.safetensors` | [lightx2v/Minimax-h3-Turbo](https://huggingface.co/lightx2v/Minimax-h3-Turbo) | minimax-h3-community-license-agreement | 1.96 | core |

A wake downloads **42.04 GB**. With `MODEL_STORE=ram` this fits the A100's RAM store with room left for ComfyUI.
