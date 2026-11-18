"""Tests for the H3 prompt lint shipped with the h3-prompt skill (.claude/skills/h3-prompt)."""
import importlib.util
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
SKILL = ROOT / ".claude" / "skills" / "h3-prompt"
EXAMPLE = ROOT / ".claude" / "skills" / "h3-video-remake" / "prompts" / "h3_prompt_example.txt"

_spec = importlib.util.spec_from_file_location("h3_prompt_lint", SKILL / "scripts" / "h3_prompt_lint.py")
lint = importlib.util.module_from_spec(_spec)
sys.modules[_spec.name] = lint  # dataclasses resolve annotations through sys.modules
_spec.loader.exec_module(lint)

REMAKE_ARGS = ["--mode", "ref2va", "--images", "2", "--audios", "2", "--duration", "10",
               "--anchors", "0,4.4,6,8.3"]
REMAKE_LINES = ["老板，千万别竖起来！", "为什么？", "一竖起来就黑屏。", "你看，我没骗你吧。", "我拆开看看。"]

T2VA = """integrated_multimodal_description: [Shot 1] Live-action, cinematic, a medium shot frames a florist \
arranging tulips on a wooden counter in a bright shop. The camera pushes in with small amplitude at slow speed \
as the young florist with a soft, cheerful voice (S1) lifts a bouquet and says: <d>[English] These just came in.</d> \
She ties the stems with a green ribbon. [Shot 2] At 00:03.000, the camera cuts to a close-up of her hands \
smoothing the ribbon into a bow.

overall_soundscape: Paper rustles as the stems move, and scissors snip the ribbon.

non_diegetic_music: N/A
"""

I2VA = """For the target video, at 0.00 seconds into the target video, <Picture 1> (from [Shot 1]) is fully referenced.

integrated_multimodal_description: [Shot 1] 2D-animated, the cat shown in <Picture 1> stays on the windowsill with \
its orange fur and blue collar. The camera holds a static shot as the cat stretches its front legs, yawns, and \
curls its tail around its paws.

overall_soundscape: A soft yawn, then quiet room tone.

non_diegetic_music: N/A
"""

FL2VA = """How the reference pictures align with the target video — Picture 1 (from Shot 1) aligns with the \
0.00-second mark of the target video; Picture 2 (from Shot 1) aligns with the 6.00-second mark of the target video.

integrated_multimodal_description: [Shot 1] Live-action, a runner begins in the crouched start position \
established by Picture 1. The camera tracks right at fast speed as she pushes off, lengthens her stride, and \
settles into the upright sprinting pose and framing established by Picture 2 at the end of the shot.

overall_soundscape: Spikes strike the track in a fast rhythm while wind rushes past.

non_diegetic_music: N/A
"""


def errors(text, argv):
    return lint.check_text(text, argv).errors


def rules(messages):
    return {m.split("]")[0].strip("[") for m in messages}


def example():
    return EXAMPLE.read_text(encoding="utf-8")


def test_accepted_remake_prompt_has_no_errors_and_three_known_warnings(tmp_path):
    lines = tmp_path / "lines.txt"
    lines.write_text("\n".join(REMAKE_LINES), encoding="utf-8")
    rep = lint.check_text(example(), [*REMAKE_ARGS, "--lines", str(lines)])
    assert rep.errors == []
    assert rules(rep.warnings) == {"negation", "speakers", "music"}
    assert len(rep.warnings) == 3


@pytest.mark.parametrize("text,argv", [
    (T2VA, ["--mode", "t2va", "--duration", "5"]),
    (I2VA, ["--mode", "i2va", "--duration", "5"]),
    (FL2VA, ["--mode", "fl2va", "--duration", "6"]),
])
def test_base_mode_prompts_pass(text, argv):
    rep = lint.check_text(text, argv)
    assert rep.errors == []
    assert rep.warnings == []


@pytest.mark.parametrize("mutate,argv,rule", [
    # an audio tag beyond the attached clips (numbering swapped or shifted)
    (lambda t: t.replace("<Audio 2>", "<Audio 3>"), REMAKE_ARGS, "labels"),
    # dialogue moved into the soundscape
    (lambda t: t.replace("faint electrical hum", "faint electrical hum. <d>[Chinese] 好了。</d>"), REMAKE_ARGS, "dialogue"),
    # a cut after the end of the clip
    (lambda t: t.replace("At 00:04.333", "At 00:12.000"), REMAKE_ARGS, "shots"),
    # range timing instead of a cut time
    (lambda t: t.replace("[Shot 2] At 00:04.333,", "[Shot 2: 4.3-10 s]"), REMAKE_ARGS, "shots"),
    # a missing section
    (lambda t: t.replace("retention_analysis:", "notes:"), REMAKE_ARGS, "sections"),
    # Chinese outside <d>
    (lambda t: t.replace("Quiet indoor workshop room tone", "安静的工作室"), REMAKE_ARGS, "language"),
    # a visual marker on an audio tag
    (lambda t: t.replace("<Audio 2>: reference", "<Audio 2>: fully_preserved"), REMAKE_ARGS, "retention"),
    # a line without a language tag
    (lambda t: t.replace("<d>[Chinese] 为什么？</d>", "<d>为什么？</d>"), REMAKE_ARGS, "dialogue"),
    # speakers numbered out of order
    (lambda t: t.replace("(S1)", "(SX)").replace("(S2)", "(S1)").replace("(SX)", "(S2)"), REMAKE_ARGS, "speakers"),
    # an anchor the description never mentions
    (lambda t: t, [*REMAKE_ARGS[:-1], "0,4.4,6,8.3,9.5"], "anchors"),
    # an anchor numbered as a picture in Studio
    (lambda t: t.replace("shown in the pinned frames", "shown in <Picture 3>"), REMAKE_ARGS, "labels"),
    # an unknown task type
    (lambda t: t.replace("[keyframe completion + reference generation + audio reference]",
                         "[keyframe completion + lip sync]"), REMAKE_ARGS, "summary"),
])
def test_mutated_remake_prompt_fails(mutate, argv, rule):
    text = mutate(example())
    assert text != example() or "9.5" in argv[-1]
    assert rule in rules(errors(text, argv))


def test_pinned_wording_without_anchors_fails():
    argv = [a for a in REMAKE_ARGS if a not in ("--anchors", "0,4.4,6,8.3")]
    assert "anchors" in rules(errors(example(), argv))


def test_pinned_time_must_be_an_anchor():
    text = example().replace("At 00:06.000 the frame matches", "At 00:06.500 the frame matches")
    msgs = errors(text, REMAKE_ARGS)
    assert any("00:06.500" in m and "not in --anchors" in m for m in msgs)


def test_audio_map_is_printed_for_audio_files(tmp_path):
    files = [tmp_path / "voice_customer.wav", tmp_path / "voice_boss.wav"]
    rep = lint.check_text(example(), [*REMAKE_ARGS[:4], *REMAKE_ARGS[6:], "--audio-files", *map(str, files)])
    mapping = [n for n in rep.notes if n.startswith("[audio-map]")]
    assert "<Audio 1> = voice_customer.wav -> <Subject 2> (S1)" in mapping[0]
    assert "<Audio 2> = voice_boss.wav -> <Subject 1> (S2)" in mapping[1]


def test_confirmed_lines_must_match_exactly(tmp_path):
    lines = tmp_path / "lines.txt"
    lines.write_text("\n".join(REMAKE_LINES[:-1] + ["我拆开看。"]), encoding="utf-8")
    assert "lines" in rules(errors(example(), [*REMAKE_ARGS, "--lines", str(lines)]))


def test_i2va_needs_its_opening_line():
    assert "instruction" in rules(errors(I2VA.split("\n", 2)[2], ["--mode", "i2va", "--duration", "5"]))


def test_fl2va_alignment_must_match_duration():
    assert "instruction" in rules(errors(FL2VA, ["--mode", "fl2va", "--duration", "8"]))


def test_t2va_rejects_reference_tags():
    text = T2VA.replace("a florist", "the florist in <Picture 1>")
    assert "labels" in rules(errors(text, ["--mode", "t2va", "--duration", "5"]))


@pytest.mark.parametrize("name,mode", [("ref2va", "ref2va"), ("t2va", "t2va"), ("i2va", "i2va"),
                                       ("fl2va", "fl2va"), ("l2va", "l2va")])
def test_unfilled_templates_are_rejected(name, mode):
    text = (SKILL / "templates" / f"{name}.txt").read_text(encoding="utf-8")
    argv = ["--mode", mode, "--duration", "10"]
    if mode == "ref2va":
        argv += ["--images", "2", "--audios", "2"]
    assert "template" in rules(errors(text, argv))


def test_negations_warn_but_do_not_fail():
    text = T2VA.replace("She ties the stems", "No customers appear. She ties the stems")
    rep = lint.check_text(text, ["--mode", "t2va", "--duration", "5"])
    assert rep.errors == []
    assert "negation" in rules(rep.warnings)
