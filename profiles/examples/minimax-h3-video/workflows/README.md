# `minimax-h3-video` workflows

Unmodified upstream workflow files, redistributed under their original licenses (MIT templates).
Do not edit them by hand — App-mode metadata is applied by `packages/colab/setup.py` at install time.

| File | Workflow id | Upstream | License | sha256 |
|---|---|---|---|---|
| `official_minimax_h3_t2v.json` | `h3-t2v` | [link](https://raw.githubusercontent.com/Comfy-Org/workflow_templates/main/templates/video_minimax_h3_t2v.json) | MIT template; weights MiniMax H3 community license | `8149b64db943…` |
| `official_minimax_h3_i2v.json` | `h3-i2v` | [link](https://raw.githubusercontent.com/Comfy-Org/workflow_templates/main/templates/video_minimax_h3_i2v.json) | MIT template; weights MiniMax H3 community license | `8abdc39eff08…` |

To add a workflow: put the upstream file here unchanged, add an entry to `../profile.yaml` with `file`,
`source`, `license`, `upstream_url`, `upstream_sha256`, `models` and `app`, then run
`python3 scripts/validate-profile.py profiles/examples/minimax-h3-video/`.
