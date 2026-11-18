#!/usr/bin/env python3
"""Mechanical checks for MiniMax H3 prompts run through local ComfyUI / the Studio page.

The checks follow MiniMax's official prompt guides (base and full-reference) plus the tag
numbering of ComfyUI's MiniMaxH3ReferenceToVideo node. They catch structure, numbering,
timing and dialogue-format mistakes; they cannot judge whether the description is good.

Examples:
  python h3_prompt_lint.py prompt.txt --mode ref2va --images 2 --audios 2 --duration 10 \
      --anchors 0,4.4,6,8.3 --lines lines.txt --audio-files voice_a.wav voice_b.wav
  python h3_prompt_lint.py prompt.txt --mode i2va --duration 5

Exit status: 0 = no errors (warnings may remain), 1 = errors found, 2 = bad arguments.
"""
from __future__ import annotations

import argparse
import re
import shutil
import subprocess
import sys
from dataclasses import dataclass, field
from pathlib import Path

REF_SECTIONS = ["subject_definitions", "summary", "retention_analysis",
                "detailed_description", "overall_soundscape", "non_diegetic_music"]
BASE_SECTIONS = ["integrated_multimodal_description", "overall_soundscape", "non_diegetic_music"]
ALL_SECTIONS = set(REF_SECTIONS) | set(BASE_SECTIONS)
MODES = ["t2va", "i2va", "fl2va", "l2va", "ref2va"]
TASK_TYPES = {"keyframe completion", "reference generation", "video editing",
              "video continuation", "audio reuse", "audio reference"}
VISUAL_MARKERS = {"fully_preserved", "partially_preserved", "attribute_transfer", "weak_reference"}
AUDIO_MARKERS = {"fully_copy", "partially_copy", "reference", "weak_reference"}
LIMITS = {"images": 9, "videos": 3, "audios": 3}

LABEL = re.compile(r"<(Subject|Picture|Video|Audio) (\d+)>")
LOOSE_LABEL = re.compile(r"<\s*(subject|picture|video|audio)\s*\d+\s*>", re.I)
BARE_LABEL = re.compile(r"(?<![<\w])(Picture|Video|Audio) \d+\b(?!>)")
D_BLOCK = re.compile(r"<d>(.*?)</d>", re.S)
LANG_TAG = re.compile(r"^\s*\[([A-Za-z][A-Za-z \-]*)\]\s+(\S.*)$", re.S)
SPEAKER = re.compile(r"\((S\d+(?:\s*,\s*S\d+)*)\)")
SHOT = re.compile(r"\[Shot (\d+)\]")
CUT_AFTER_SHOT = re.compile(r"\s*At (\d{2}):(\d{2})\.(\d{3})\b")
RANGE = re.compile(r"\[\s*(?:Shot \d+\s*:\s*)?\d+(?:\.\d+)?\s*s?\s*[-–~]\s*\d+(?:\.\d+)?\s*s\s*\]")
CJK = re.compile(r"[　-〿㐀-鿿豈-﫿＀-￯]")
QUOTED = re.compile(r"\"[^\"\n]*\"|“[^”\n]*”")
NEGATION = re.compile(r"\b(no|not|never|without|don't|doesn't|isn't|avoid|nothing|nobody|none)\b", re.I)
ACCEPTED_NEGATIONS = {"No subtitles or on-screen text appear."}
SLOT = re.compile(r"\{\{[^}\n]*\}\}")
TERMINAL = tuple(".?!。？！")
TRAILING_QUOTES = "\"'”’」』)）"

I2VA_LINE = "For the target video, at 0.00 seconds into the target video, <Picture 1> (from [Shot 1]) is fully referenced."
FL2VA_LINE = re.compile(
    r"^How the reference pictures align with the target video — Picture 1 \(from Shot 1\) aligns with the "
    r"0\.00-second mark of the target video; Picture 2 \(from Shot (\d+)\) aligns with the "
    r"(\d+\.\d{2})-second mark of the target video\.$")
L2VA_LINE = re.compile(
    r"^How the reference pictures align with the target video — <Picture 1> \(from \[Shot (\d+)\]\) aligns "
    r"with the (\d+\.\d{2})-second mark of the target video\.$")


@dataclass
class Report:
    errors: list[str] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)
    notes: list[str] = field(default_factory=list)

    def error(self, rule: str, msg: str) -> None:
        self.errors.append(f"[{rule}] {msg}")

    def warn(self, rule: str, msg: str) -> None:
        self.warnings.append(f"[{rule}] {msg}")

    def note(self, rule: str, msg: str) -> None:
        self.notes.append(f"[{rule}] {msg}")


@dataclass
class Section:
    name: str
    start: int   # offset of the header line in the text
    body_start: int
    end: int
    text: str


def snippet(s: str, n: int = 70) -> str:
    s = " ".join(s.split())
    return s if len(s) <= n else s[: n - 1] + "…"


def ts(seconds: float) -> str:
    """Seconds -> MM:SS.mmm, the timestamp form the guides use."""
    ms = int(round(seconds * 1000))
    return f"{ms // 60000:02d}:{(ms % 60000) // 1000:02d}.{ms % 1000:03d}"


def parse_sections(text: str) -> list[Section]:
    heads = [(m.start(), m.end(), m.group(1))
             for m in re.finditer(r"(?m)^([a-z_]+):[ \t]*", text) if m.group(1) in ALL_SECTIONS]
    out = []
    for i, (start, body_start, name) in enumerate(heads):
        end = heads[i + 1][0] if i + 1 < len(heads) else len(text)
        out.append(Section(name, start, body_start, end, text[body_start:end].strip()))
    return out


def check_section_order(rep: Report, sections: list[Section], expected: list[str]) -> dict[str, Section]:
    names = [s.name for s in sections]
    for s in sections:
        if s.name not in expected:
            rep.error("sections", f"`{s.name}:` does not belong in this mode (expected {', '.join(expected)})")
    for name in expected:
        if names.count(name) == 0:
            rep.error("sections", f"missing section `{name}:`")
        elif names.count(name) > 1:
            rep.error("sections", f"section `{name}:` appears {names.count(name)} times")
    present = [n for n in names if n in expected]
    if present == [n for n in expected if n in present] and len(set(present)) == len(present):
        pass
    else:
        rep.error("sections", f"sections are out of order: {', '.join(present)}; expected {', '.join(expected)}")
    by_name = {}
    for s in sections:
        by_name.setdefault(s.name, s)
        if s.name in expected and not s.text:
            rep.error("sections", f"section `{s.name}:` is empty")
    return by_name


def section_of(sections: list[Section], pos: int) -> str | None:
    for s in sections:
        if s.start <= pos < s.end:
            return s.name
    return None


def check_slots(rep: Report, text: str) -> None:
    for m in SLOT.finditer(text):
        rep.error("template", f"unfilled template slot {m.group(0)}")


def check_labels_format(rep: Report, text: str, mode: str) -> None:
    for m in LOOSE_LABEL.finditer(text):
        if not LABEL.fullmatch(m.group(0)):
            rep.error("labels", f"malformed tag {m.group(0)!r}: write it exactly like <Picture 1>, <Audio 2>")
    if mode != "fl2va":
        stripped = LABEL.sub("", text)
        bare = sorted({m.group(0) for m in BARE_LABEL.finditer(stripped)})
        if bare:
            rep.warn("labels", f"untagged reference names {', '.join(bare)}: use the <...> tag form")


def check_language(rep: Report, text: str) -> None:
    outside = QUOTED.sub("", D_BLOCK.sub("", text))
    hits = []
    for line in outside.splitlines():
        if CJK.search(line):
            hits.append(snippet(line))
    for h in hits[:3]:
        rep.error("language", f"Chinese text outside <d>…</d> and outside \"on-screen text\" quotes: {h}")
    if len(hits) > 3:
        rep.error("language", f"… and {len(hits) - 3} more lines with Chinese text outside <d>")


def check_shots(rep: Report, body: str, duration: float | None) -> int:
    if RANGE.search(body):
        rep.error("shots", f"range timing {RANGE.search(body).group(0)!r}: write cuts as `[Shot N] At MM:SS.mmm, the shot cuts to …`")
    shots = list(SHOT.finditer(body))
    if not shots:
        rep.error("shots", "no `[Shot 1]` marker in the main description")
        return 0
    numbers = [int(m.group(1)) for m in shots]
    if numbers != list(range(1, len(numbers) + 1)):
        rep.error("shots", f"shot markers must run [Shot 1], [Shot 2], … once each; found {numbers}")
    last = 0.0
    for m in shots:
        n = int(m.group(1))
        cut = CUT_AFTER_SHOT.match(body, m.end())
        if n == 1:
            if cut:
                rep.error("shots", "[Shot 1] must not carry a timestamp")
            continue
        if not cut:
            rep.error("shots", f"[Shot {n}] must start with `At MM:SS.mmm,` (the cut time)")
            continue
        t = int(cut.group(1)) * 60 + int(cut.group(2)) + int(cut.group(3)) / 1000
        if t <= last:
            rep.error("shots", f"[Shot {n}] cut at {ts(t)} is not later than the previous cut ({ts(last)})")
        if duration is not None and t >= duration:
            rep.error("shots", f"[Shot {n}] cut at {ts(t)} is not inside the {duration:g} s video")
        last = t
    return len(numbers)


def check_dialogue(rep: Report, text: str, sections: list[Section], body_name: str,
                   body: Section | None, lines_file: Path | None) -> list[str]:
    opens, closes = text.count("<d>"), text.count("</d>")
    if opens != closes:
        rep.error("dialogue", f"unbalanced dialogue tags: {opens} <d> vs {closes} </d>")
    for token in ("<cutoff>", "<|cutoff|>"):
        if token in text:
            rep.error("dialogue", f"{token} found: keep every line inside the clip and finish it before the video ends")
    if "<scenetrans>" in text:
        rep.warn("dialogue", "<scenetrans> found: lines that cross a cut are untested here; prefer finishing the line before the cut")
    spoken = []
    prev_end = body.body_start if body else 0
    for m in D_BLOCK.finditer(text):
        where = section_of(sections, m.start())
        inner = m.group(1)
        if "<d>" in inner:
            rep.error("dialogue", f"nested <d> near {snippet(inner)}")
            continue
        if where != body_name:
            rep.error("dialogue", f"dialogue belongs only in `{body_name}:`, found one in `{where}:`: {snippet(inner)}")
        lang = LANG_TAG.match(inner)
        if not lang:
            rep.error("dialogue", f"<d> must start with a language tag like [Chinese] or [English]: {snippet(inner)}")
            words = inner.strip()
        else:
            words = lang.group(2).strip()
        spoken.append(words)
        if LABEL.search(inner) or SPEAKER.search(inner):
            rep.error("dialogue", f"tags or speaker IDs go outside <d>, not inside: {snippet(inner)}")
        if not words.rstrip(TRAILING_QUOTES).endswith(TERMINAL):
            rep.error("dialogue", f"end each line with . ? ! (or 。？！) before </d>: {snippet(words)}")
        if "..." in words or "…" in words:
            rep.warn("dialogue", f"ellipsis inside a line often blurs speech: {snippet(words)}")
        if re.search(r"[~～]", words) or any(ord(c) >= 0x1F000 for c in words):
            rep.warn("dialogue", f"tilde or emoji inside a line: {snippet(words)}")
        if where == body_name:
            lead = text[prev_end:m.start()]
            shot = list(SHOT.finditer(lead))
            if shot:
                lead = lead[shot[-1].end():]
            lead = re.split(r"(?<=[.!?])\s+(?=[A-Z<\[])", lead)[-1]
            if not SPEAKER.search(lead):
                rep.warn("speakers", f"no (Sx) speaker ID in the sentence that introduces: {snippet(words, 40)} "
                                     "(official guide: repeat the ID at every vocal event)")
            prev_end = m.end()
        tail = text[m.end():m.end() + 160]
        if "off-screen voiceover" in text[max(0, m.start() - 200):m.start()] and "lips remain" not in tail:
            rep.warn("voiceover", f"after a voiceover line, state that the on-screen character's lips remain closed: {snippet(words, 40)}")
    if lines_file is not None:
        confirmed = [ln.strip() for ln in lines_file.read_text(encoding="utf-8-sig").splitlines() if ln.strip()]
        if confirmed != spoken:
            if len(confirmed) != len(spoken):
                rep.error("lines", f"{len(spoken)} <d> lines in the prompt, {len(confirmed)} confirmed lines in {lines_file.name}")
            for i, (a, b) in enumerate(zip(spoken, confirmed), 1):
                if a != b:
                    rep.error("lines", f"line {i} differs from the confirmed transcript: prompt {a!r} vs confirmed {b!r}")
    return spoken


def check_speakers(rep: Report, body_text: str, defs_text: str, retention_text: str) -> None:
    order = []
    for m in SPEAKER.finditer(body_text):
        for sid in re.split(r"\s*,\s*", m.group(1)):
            if sid not in order:
                order.append(sid)
    expected = [f"S{i}" for i in range(1, len(order) + 1)]
    if order != expected:
        rep.error("speakers", f"speaker IDs must be numbered by first appearance (S1, S2, …); found {order}")
    for m in SPEAKER.finditer(defs_text):
        for sid in re.split(r"\s*,\s*", m.group(1)):
            if sid not in order:
                rep.error("speakers", f"({sid}) is bound in subject_definitions but never speaks in the description: "
                                      "if that character has no line in this segment, delete its <Audio> lines and do not "
                                      "upload its voice file; if a line was missed, add it")
    if SPEAKER.search(retention_text):
        rep.error("speakers", "do not write (Sx) speaker IDs in retention_analysis")


def check_negations(rep: Report, body_text: str) -> None:
    plain = D_BLOCK.sub(". ", body_text)  # keep a sentence boundary where a line was
    flagged = []
    for sent in re.split(r"(?<=[.!?])\s+", plain):
        sent = sent.strip()
        if not sent or not NEGATION.search(sent):
            continue
        if sent in ACCEPTED_NEGATIONS:
            rep.note("negation", f"kept the tested line {sent!r} (no negative prompt exists; untested whether dropping it helps)")
            continue
        flagged.append(sent)
    for sent in flagged[:5]:
        rep.warn("negation", f"negated wording can pull the named thing into the frame; say what is there instead: {snippet(sent, 90)}")
    if len(flagged) > 5:
        rep.warn("negation", f"… and {len(flagged) - 5} more negated sentences")


def check_audio_sections(rep: Report, by_name: dict[str, Section]) -> None:
    music = by_name.get("non_diegetic_music")
    if music and music.text.strip().rstrip(".").lower() == "none":
        rep.warn("music", "write `N/A` when there is no background music (official form), not `None`")
    sound = by_name.get("overall_soundscape")
    if sound and sound.text.strip().upper().rstrip(".") == "N/A":
        rep.warn("soundscape", "`N/A` in overall_soundscape means total silence; describe room tone and action sounds instead")


def probe_seconds(path: Path) -> float | None:
    if not shutil.which("ffprobe"):
        return None
    out = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", str(path)],
                         capture_output=True, text=True)
    try:
        return float(out.stdout.strip())
    except ValueError:
        return None


def check_audio_files(rep: Report, files: list[Path]) -> None:
    total = 0.0
    for f in files:
        if not f.exists():
            rep.error("audio", f"{f} does not exist")
            continue
        sec = probe_seconds(f)
        if sec is None:
            rep.warn("audio", f"could not read the length of {f.name} (is ffprobe installed?)")
            continue
        total += sec
        if not 2.0 <= sec <= 15.0:
            rep.error("audio", f"{f.name} is {sec:.2f} s; each reference audio must be 2–15 s")
    if total > 15.0:
        rep.warn("audio", f"reference audio totals {total:.2f} s; MiniMax's limit is 15 s combined (the local node does not enforce it)")


def check_base(rep: Report, text: str, mode: str, duration: float | None) -> tuple[dict[str, Section], list[Section]]:
    lines = text.splitlines()
    first = next((i for i, ln in enumerate(lines) if ln.strip()), None)
    sections = parse_sections(text)
    by_name = check_section_order(rep, sections, BASE_SECTIONS)
    pre = text[: sections[0].start].strip() if sections else text.strip()
    if mode == "t2va":
        if pre:
            rep.error("instruction", f"T2VA starts directly with `integrated_multimodal_description:`; remove: {snippet(pre)}")
    else:
        line = lines[first].strip() if first is not None else ""
        blank_after = first is not None and first + 1 < len(lines) and not lines[first + 1].strip()
        body = by_name.get("integrated_multimodal_description")
        n_shots = len(SHOT.findall(body.text)) if body else 0
        if mode == "i2va":
            if line != I2VA_LINE:
                rep.error("instruction", f"I2VA must open with exactly: {I2VA_LINE}")
        else:
            pattern = FL2VA_LINE if mode == "fl2va" else L2VA_LINE
            m = pattern.match(line)
            if not m:
                rep.error("instruction", f"{mode.upper()} must open with the official alignment line (see templates/{mode}.txt)")
            else:
                shot_n, secs = int(m.group(1)), float(m.group(2))
                if n_shots and shot_n != n_shots:
                    rep.error("instruction", f"the alignment line points at Shot {shot_n}, but the last shot is Shot {n_shots}")
                if duration is not None and abs(secs - duration) > 0.15:
                    rep.error("instruction", f"the alignment line says {secs:.2f} s, but the video is {duration:g} s")
        if not blank_after:
            rep.error("instruction", "leave one blank line after the alignment line")
        if pre and pre != line:
            rep.error("instruction", "only the alignment line may come before `integrated_multimodal_description:`")
    allowed = {"t2va": set(), "i2va": {("Picture", 1)}, "l2va": {("Picture", 1)},
               "fl2va": {("Picture", 1), ("Picture", 2)}}[mode]
    for m in LABEL.finditer(text):
        if (m.group(1), int(m.group(2))) not in allowed:
            rep.error("labels", f"{m.group(0)} is not available in {mode.upper()} (reference tags belong to ref2va)")
    return by_name, sections


def check_ref(rep: Report, text: str, args, duration: float | None) -> tuple[dict[str, Section], list[Section]]:
    sections = parse_sections(text)
    by_name = check_section_order(rep, sections, REF_SECTIONS)
    pre = text[: sections[0].start].strip() if sections else text.strip()
    if pre:
        rep.error("sections", f"text before `subject_definitions:` is not allowed in ref2va: {snippet(pre)}")
    counts = {"Picture": args.images, "Video": args.videos, "Audio": args.audios + args.video_audios}
    for kind, limit_key in (("images", "images"), ("videos", "videos"), ("audios", "audios")):
        if getattr(args, kind) > LIMITS[limit_key]:
            rep.error("inputs", f"{getattr(args, kind)} {kind}: the node accepts at most {LIMITS[limit_key]}")
    if args.video_audios > args.videos:
        rep.error("inputs", "--video-audios cannot exceed --videos (a soundtrack belongs to a reference video)")
    used = {"Subject": set(), "Picture": set(), "Video": set(), "Audio": set()}
    for m in LABEL.finditer(text):
        used[m.group(1)].add(int(m.group(2)))
    flag = {"Picture": "--images", "Video": "--videos", "Audio": "--audios/--video-audios"}
    for kind, n in counts.items():
        for i in sorted(used[kind]):
            if i > n:
                rep.error("labels", f"<{kind} {i}> is used but only {n} {kind.lower()} input(s) are attached "
                                    f"(pass {flag[kind]}; Studio anchors never get a <Picture N> number)")
    defs = by_name.get("subject_definitions")
    summ = by_name.get("summary")
    ret = by_name.get("retention_analysis")
    desc = by_name.get("detailed_description")
    defs_text = defs.text if defs else ""
    def_lines = {}
    for ln in defs_text.splitlines():
        m = LABEL.match(ln.strip())
        if m:
            key = (m.group(1), int(m.group(2)))
            if key in def_lines:
                rep.error("definitions", f"<{key[0]} {key[1]}> is defined twice")
            def_lines[key] = ln
    subjects = sorted(i for k, i in def_lines if k == "Subject")
    if subjects != list(range(1, len(subjects) + 1)):
        rep.error("definitions", f"subjects must be numbered <Subject 1>, <Subject 2>, … without gaps; found {subjects}")
    for i in sorted(used["Subject"]):
        if ("Subject", i) not in def_lines:
            rep.error("definitions", f"<Subject {i}> is used but not defined on its own line in subject_definitions")
    defined_in_defs = {(m.group(1), int(m.group(2))) for m in LABEL.finditer(defs_text)}
    for i in range(1, args.images + 1):
        if ("Picture", i) not in defined_in_defs:
            rep.error("definitions", f"<Picture {i}> is attached but never named in subject_definitions")
    for i in range(1, args.videos + 1):
        if ("Video", i) not in defined_in_defs:
            rep.error("definitions", f"<Video {i}> is attached but never named in subject_definitions")
    for i in range(1, counts["Audio"] + 1):
        if ("Audio", i) not in def_lines:
            rep.error("definitions", f"<Audio {i}> is attached but has no definition line (start a line with <Audio {i}> is …)")
    # summary
    if summ:
        m = re.match(r"\s*\[([^\]]+)\]", summ.text)
        if not m:
            rep.error("summary", "summary must start with the task type in brackets, e.g. [reference generation + audio reference]")
        else:
            types = [t.strip() for t in m.group(1).split("+")]
            for t in types:
                if t not in TASK_TYPES:
                    rep.error("summary", f"unknown task type {t!r}; allowed: {', '.join(sorted(TASK_TYPES))}")
            if len(set(types)) != len(types):
                rep.error("summary", "a task type is repeated in the summary prefix")
            if args.anchors and "keyframe completion" not in types:
                rep.warn("summary", "pinned anchors are used, so the summary prefix should include `keyframe completion`")
            if counts["Audio"] and not ({"audio reference", "audio reuse"} & set(types)):
                rep.warn("summary", "audio references are attached; add `audio reference` (timbre/style) or `audio reuse` (signal copied)")
            if "video editing" in types and "edited version of <Video" not in summ.text:
                rep.warn("summary", "for video editing, begin with `The target video is an edited version of <Video 1>.`")
        for m in LABEL.finditer(summ.text):
            if (m.group(1), int(m.group(2))) not in defined_in_defs:
                rep.error("summary", f"{m.group(0)} appears in the summary but not in subject_definitions")
    # retention
    if ret:
        ret_lines = {}
        for ln in ret.text.splitlines():
            m = re.match(r"\s*<(Subject|Picture|Video|Audio) (\d+)>(?:\s*\([^)]*\))?\s*:\s*([A-Za-z_]+)", ln)
            if not m:
                if ln.strip():
                    rep.warn("retention", f"line does not look like `<Tag N> (where): marker - reason`: {snippet(ln)}")
                continue
            kind, idx, marker = m.group(1), int(m.group(2)), m.group(3)
            ret_lines[(kind, idx)] = marker
            allowed = AUDIO_MARKERS if kind == "Audio" else VISUAL_MARKERS
            if marker not in allowed:
                rep.error("retention", f"<{kind} {idx}> uses {marker!r}; allowed: {', '.join(sorted(allowed))}")
        for key in def_lines:
            if key not in ret_lines:
                rep.error("retention", f"<{key[0]} {key[1]}> is defined but has no retention_analysis line")
    # description
    if desc:
        before = SHOT.split(desc.text, maxsplit=1)[0].strip()
        if not before:
            rep.warn("description", "open detailed_description with one or two style sentences before [Shot 1]")
        for i in subjects:
            if f"<Subject {i}>" not in desc.text:
                rep.warn("description", f"<Subject {i}> is defined but never appears in detailed_description")
        types = re.match(r"\s*\[([^\]]+)\]", summ.text).group(1) if summ and re.match(r"\s*\[([^\]]+)\]", summ.text) else ""
        if "video editing" not in types:
            words = len(re.findall(r"[A-Za-z][A-Za-z'\-]*", D_BLOCK.sub("", desc.text)))
            if words < 250:
                rep.warn("length", f"detailed_description has {words} English words; generation prompts usually need 350–500")
            elif words > 750:
                rep.warn("length", f"detailed_description has {words} English words; trim repetition unless dialogue needs it")
        for t in args.anchors:
            if t == 0:
                if "first frame" not in desc.text.lower():
                    rep.warn("anchors", "an anchor pins 0 s: say `The shot begins from the pinned first frame`")
            elif ts(t) not in desc.text:
                rep.error("anchors", f"anchor at {t:g} s is not described: mention `the pinned keyframe at {ts(t)}`")
    check_pinned_wording(rep, text, args.anchors)
    check_audio_map(rep, def_lines, args)
    check_speakers(rep, desc.text if desc else "", defs_text, ret.text if ret else "")
    return by_name, sections


TS = r"\d{2}:\d{2}\.\d{3}"
PINNED_AFTER = re.compile(rf"pinned (?:key)?frames? at ((?:{TS}(?:,\s*|,?\s+and\s+)?)+)")
PINNED_BEFORE = re.compile(rf"At ({TS}),? the frame matches the (?:[a-z]+ )*?pinned")


def check_pinned_wording(rep: Report, text: str, anchors: list[float]) -> None:
    """Text about pinned frames must match the anchors actually passed to Studio."""
    if not anchors:
        if re.search(r"\bpinned\b", text, re.I):
            rep.error("anchors", "the prompt talks about pinned frames, but no --anchors were given "
                                 "(r2v without anchors: remove every `pinned` sentence)")
        return
    wanted = {ts(t) for t in anchors}
    if 0 not in anchors and re.search(r"pinned first frame", text, re.I):
        rep.error("anchors", "the prompt says `pinned first frame`, but no anchor sits at 0 s")
    found = set(PINNED_BEFORE.findall(text))
    for m in PINNED_AFTER.finditer(text):
        found.update(re.findall(TS, m.group(1)))
    for t in sorted(found - wanted):
        rep.error("anchors", f"the prompt pins a frame at {t}, but that time is not in --anchors")


def check_audio_map(rep: Report, def_lines: dict, args) -> None:
    """Print which file and speaker each <Audio j> means, so a swapped upload order is easy to spot."""
    if not args.audio_files:
        return
    for i, f in enumerate(args.audio_files, start=args.video_audios + 1):
        line = def_lines.get(("Audio", i), "")
        who = re.search(r"for (<Subject \d+>(?:'s voice)?)\s*(\((?:S\d+)\))?", line)
        target = f"{who.group(1)} {who.group(2) or ''}".strip() if who else "no speaker named in its definition"
        rep.note("audio-map", f"<Audio {i}> = {f.name} -> {target}; check this matches who speaks in that file")


def lint(text: str, args) -> Report:
    rep = Report()
    duration = args.duration
    if duration is not None and not 4 <= duration <= 15:
        rep.warn("duration", f"{duration:g} s is outside H3's 4–15 s range")
    check_slots(rep, text)
    check_labels_format(rep, text, args.mode)
    check_language(rep, text)
    if args.mode == "ref2va":
        by_name, sections = check_ref(rep, text, args, duration)
        body_name = "detailed_description"
    else:
        if args.images or args.videos or args.audios or args.video_audios:
            rep.error("inputs", "--images/--videos/--audios only apply to ref2va")
        by_name, sections = check_base(rep, text, args.mode, duration)
        body_name = "integrated_multimodal_description"
        if args.anchors:
            rep.error("inputs", "--anchors (pinned keyframes) only apply to ref2va")
        body = by_name.get(body_name)
        if body:
            check_speakers(rep, body.text, "", "")
    body = by_name.get(body_name)
    if body:
        check_shots(rep, body.text, duration)
        check_negations(rep, body.text)
    check_dialogue(rep, text, sections, body_name, body, args.lines)
    check_audio_sections(rep, by_name)
    if args.audio_files:
        check_audio_files(rep, args.audio_files)
    return rep


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(description="Check a MiniMax H3 prompt against the official format and local tag numbering.")
    p.add_argument("prompt", type=Path, help="prompt text file (UTF-8)")
    p.add_argument("--mode", required=True, choices=MODES,
                   help="t2va | i2va (first frame) | fl2va (first+last) | l2va (last only) | ref2va (references, with or without anchors)")
    p.add_argument("--images", type=int, default=0, help="reference images attached (ref2va), in upload order")
    p.add_argument("--videos", type=int, default=0, help="reference videos attached (ref2va)")
    p.add_argument("--video-audios", type=int, default=0, help="reference videos whose soundtrack is also wired (ref2va)")
    p.add_argument("--audios", type=int, default=None, help="standalone reference audio clips (ref2va)")
    p.add_argument("--duration", type=float, default=None, help="video length in seconds")
    p.add_argument("--anchors", default="", help="pinned anchor times in seconds, comma separated, e.g. 0,4.4,6")
    p.add_argument("--lines", type=Path, default=None, help="confirmed dialogue, one line per row, exactly as it goes inside <d>")
    p.add_argument("--audio-files", type=Path, nargs="+", default=None, help="the standalone reference audio files, to check their length")
    return p


def prepare(args) -> str | None:
    """Normalise parsed arguments in place; return a usage error message, or None."""
    try:
        args.anchors = sorted(float(x) for x in args.anchors.split(",") if x.strip())
    except ValueError:
        return "--anchors must be numbers in seconds, e.g. 0,4.4,6"
    if args.audios is None:
        args.audios = len(args.audio_files) if args.audio_files else 0
    elif args.audio_files and len(args.audio_files) != args.audios:
        return "--audios and --audio-files disagree on the number of audio clips"
    return None


def check_text(text: str, argv: list[str]) -> Report:
    """Lint prompt text directly; argv holds the options without the prompt path (used by tests)."""
    args = build_parser().parse_args(["-", *argv])
    problem = prepare(args)
    if problem:
        raise ValueError(problem)
    return lint(text, args)


def main(argv: list[str] | None = None) -> int:
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    args = build_parser().parse_args(argv)
    problem = prepare(args)
    if problem:
        print(problem, file=sys.stderr)
        return 2
    if not args.prompt.exists():
        print(f"{args.prompt} does not exist", file=sys.stderr)
        return 2
    text = args.prompt.read_text(encoding="utf-8-sig")
    rep = lint(text, args)
    for e in rep.errors:
        print("ERROR", e)
    for w in rep.warnings:
        print("WARN ", w)
    for n in rep.notes:
        print("NOTE ", n)
    print(f"{len(rep.errors)} error(s), {len(rep.warnings)} warning(s)")
    return 1 if rep.errors else 0


if __name__ == "__main__":
    sys.exit(main())
