"""ffmpeg helpers for remaking a reference video segment by segment (needs ffmpeg/ffprobe on PATH).

  speech  <media> [--db -35] [--min 0.15]          speech intervals (silencedetect) as "start-end" seconds
  levels  <wav>                                     loudness per second in dBFS (tell BGM from SFX spikes in a stem)
  frame   <video> <t> <out.png> [--delogo x:y:w:h]  one frame; --delogo blurs a small sticker away
  voice   <media> <out.wav> <a-b> [<a-b> ...]       join time windows into one voice-timbre reference (0.3 s gaps)
  burn    <video> <subs.ass> <out.mp4>              burn an ASS overlay (title / subtitles) into a video
  ab      <orig.mp4> <remake.mp4> <out.mp4> [--labels 原片,复刻] [--font PATH]
                                                    play the original then the remake, each with its own sound
"""
import argparse
import math
import os
import pathlib
import re
import subprocess
import sys
import wave
from array import array

GAP_S = 0.3


def run(args: list[str], cwd: str | None = None) -> subprocess.CompletedProcess:
    r = subprocess.run(args, cwd=cwd, capture_output=True, text=True, encoding="utf-8", errors="replace")
    if r.returncode:
        sys.exit(f"command failed ({r.returncode}): {' '.join(args)}\n{r.stderr[-2000:]}")
    return r


def duration(path: str) -> float:
    r = run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", path])
    return float(r.stdout.strip())


def cmd_speech(a) -> None:
    r = subprocess.run(["ffmpeg", "-hide_banner", "-i", a.media, "-vn", "-af", f"silencedetect=noise={a.db}dB:d={a.min}",
                        "-f", "null", "-"], capture_output=True, text=True, encoding="utf-8", errors="replace")
    starts = [float(x) for x in re.findall(r"silence_start: ([0-9.]+)", r.stderr)]
    ends = [float(x) for x in re.findall(r"silence_end: ([0-9.]+)", r.stderr)]
    total = duration(a.media)
    t, spans = 0.0, []
    for s, e in zip(starts, ends + [total] * (len(starts) - len(ends))):
        if s - t > 0.05:
            spans.append((t, s))
        t = e
    if total - t > 0.05:
        spans.append((t, total))
    for s, e in spans:
        print(f"{s:6.2f}-{e:6.2f}  ({e - s:.2f}s)")


def cmd_levels(a) -> None:
    tmp = pathlib.Path(a.wav).with_suffix(".levels.tmp.wav")
    run(["ffmpeg", "-v", "error", "-y", "-i", a.wav, "-ac", "1", "-ar", "16000", "-sample_fmt", "s16", str(tmp)])
    try:
        with wave.open(str(tmp)) as w:
            sr, data = w.getframerate(), array("h", w.readframes(w.getnframes()))
    finally:
        tmp.unlink(missing_ok=True)
    out = []
    for i in range(0, len(data), sr):
        seg = data[i:i + sr]
        rms = math.sqrt(sum(x * x for x in seg) / max(1, len(seg))) / 32768
        out.append(f"{i // sr:>3}s {20 * math.log10(rms + 1e-9):6.1f}")
    print("\n".join(out))


def cmd_frame(a) -> None:
    vf = []
    if a.delogo:
        x, y, w, h = a.delogo.split(":")
        vf = ["-vf", f"delogo=x={x}:y={y}:w={w}:h={h}"]
    run(["ffmpeg", "-v", "error", "-y", "-ss", str(a.t), "-i", a.video, "-frames:v", "1", *vf, a.out])
    print(a.out)


def cmd_voice(a) -> None:
    wins = []
    for w in a.windows:
        s, e = (float(x) for x in w.split("-"))
        wins.append((s, e))
    parts, labels = [], []
    for i, (s, e) in enumerate(wins):
        parts.append(f"[s{i}]atrim={s}:{e},asetpts=N/SR/TB[w{i}]")
        labels.append(f"[w{i}]")
        if i < len(wins) - 1:
            parts.append(f"anullsrc=r=44100:cl=stereo,atrim=0:{GAP_S}[g{i}]")
            labels.append(f"[g{i}]")
    split = f"[0:a]aformat=sample_rates=44100:channel_layouts=stereo,asplit={len(wins)}" + "".join(f"[s{i}]" for i in range(len(wins)))
    graph = ";".join([split, *parts, "".join(labels) + f"concat=n={len(labels)}:v=0:a=1[out]"])
    run(["ffmpeg", "-v", "error", "-y", "-i", a.media, "-filter_complex", graph, "-map", "[out]", "-ar", "44100", a.out])
    print(f"{a.out}  {duration(a.out):.2f}s")


def cmd_burn(a) -> None:
    ass = pathlib.Path(a.ass).resolve()
    # libass filter paths need escaping on Windows; run next to the .ass file and pass its bare name
    run(["ffmpeg", "-v", "error", "-y", "-i", str(pathlib.Path(a.video).resolve()), "-vf", f"ass={ass.name}",
         "-c:v", "libx264", "-crf", "18", "-c:a", "copy", str(pathlib.Path(a.out).resolve())], cwd=str(ass.parent))
    print(a.out)


def default_font() -> str:
    for f in ("C:/Windows/Fonts/msyhbd.ttc", "/System/Library/Fonts/PingFang.ttc",
              "/usr/share/fonts/opentype/noto/NotoSansCJK-Bold.ttc"):
        if os.path.exists(f):
            return f
    return ""


def cmd_ab(a) -> None:
    l0, l1 = (a.labels.split(",") + ["", ""])[:2]
    r = run(["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "csv=p=0", a.remake])
    w, h = (int(x) for x in r.stdout.strip().split(",")[:2])
    font = (a.font or default_font()).replace("\\", "/").replace(":", "\\:")
    def tag(label: str) -> str:
        if not label or not font:
            return ""
        return f",drawtext=fontfile='{font}':text='{label}':x=16:y=12:fontsize={max(18, h // 17)}:fontcolor=white:box=1:boxcolor=black@0.55:boxborderw=8"
    graph = (f"[0:v]scale={w}:{h}:force_original_aspect_ratio=increase,crop={w}:{h},setsar=1,fps=24{tag(l0)}[v0];"
             f"[1:v]setsar=1,fps=24{tag(l1)}[v1];"
             "[0:a]aresample=44100,aformat=channel_layouts=stereo[a0];[1:a]aresample=44100,aformat=channel_layouts=stereo[a1];"
             "[v0][a0][v1][a1]concat=n=2:v=1:a=1[v][a]")
    run(["ffmpeg", "-v", "error", "-y", "-i", a.orig, "-i", a.remake, "-filter_complex", graph, "-map", "[v]", "-map", "[a]",
         "-c:v", "libx264", "-crf", "20", "-c:a", "aac", a.out])
    print(a.out)


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = p.add_subparsers(dest="cmd", required=True)
    s = sub.add_parser("speech"); s.add_argument("media"); s.add_argument("--db", type=float, default=-35); s.add_argument("--min", type=float, default=0.15)
    s = sub.add_parser("levels"); s.add_argument("wav")
    s = sub.add_parser("frame"); s.add_argument("video"); s.add_argument("t", type=float); s.add_argument("out"); s.add_argument("--delogo")
    s = sub.add_parser("voice"); s.add_argument("media"); s.add_argument("out"); s.add_argument("windows", nargs="+")
    s = sub.add_parser("burn"); s.add_argument("video"); s.add_argument("ass"); s.add_argument("out")
    s = sub.add_parser("ab"); s.add_argument("orig"); s.add_argument("remake"); s.add_argument("out")
    s.add_argument("--labels", default="原片,复刻"); s.add_argument("--font", default="")
    a = p.parse_args()
    globals()["cmd_" + a.cmd](a)


if __name__ == "__main__":
    main()
