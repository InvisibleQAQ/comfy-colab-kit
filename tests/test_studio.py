"""Studio page: profile key, plan/kit.json plumbing, VM install, and the JS modules (via node --test)."""
import copy
import importlib.util
import json
import shutil
import subprocess
from pathlib import Path

import pytest
import yaml

from gate.config import Settings
from gate.plan import build_plan
from gate.profiles import STUDIO_MODES, ProfileError, load_profile, parse_profile

ROOT = Path(__file__).resolve().parent.parent
H3 = ROOT / "profiles/examples/minimax-h3-video"
STUDIO = ROOT / "packages/colab/studio"


def _setup_module(monkeypatch, tmp_path, plan):
    p = tmp_path / "plan.json"
    p.write_text(json.dumps(plan))
    monkeypatch.setenv("KIT_PLAN", str(p))
    spec = importlib.util.spec_from_file_location("kit_setup_studio", ROOT / "packages/colab/setup.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def test_h3_profile_serves_every_studio_mode():
    p = load_profile(H3)
    assert {w.studio: w.id for w in p.workflows.values() if w.studio} == {
        "t2v": "h3-t2v", "i2v": "h3-i2v", "r2v": "h3-r2v", "keyframes": "h3-multiframe"}
    assert set(STUDIO_MODES) == {"t2v", "i2v", "r2v", "keyframes"}


@pytest.mark.parametrize("mutate,msg", [
    (lambda d: d["workflows"][0].update(studio="music"), "studio must be one of"),
    (lambda d: d["workflows"][1].update(studio="t2v"), "already serves studio mode 't2v'"),
])
def test_invalid_studio_key(mutate, msg):
    d = copy.deepcopy(yaml.safe_load((H3 / "profile.yaml").read_text()))
    mutate(d)
    with pytest.raises(ProfileError, match=msg):
        parse_profile(d, H3)


def test_plan_carries_studio_mode_and_on_demand_size():
    plan = build_plan(load_profile(H3), Settings.from_env({"AUTH_DISABLED": "true"}))
    modes = {w["id"]: w.get("studio") for w in plan["workflows"]}
    assert modes == {"h3-t2v": "t2v", "h3-i2v": "i2v", "h3-r2v": "r2v", "h3-multiframe": "keyframes"}
    # the ref2va DiT + its LoRA are fetched on demand; the Studio shows their size before asking
    assert plan["on_demand_gb"] == {"h3-r2v": 22.93, "h3-multiframe": 22.93}
    assert set(plan["on_demand_gb"]) == set(plan["on_demand"])


def test_plan_without_studio_workflows_has_no_studio_keys():
    plan = build_plan(load_profile(ROOT / "tests/fixtures/profiles/tiny"), Settings.from_env({"AUTH_DISABLED": "true"}))
    assert all("studio" not in w for w in plan["workflows"])


def test_kit_info_lists_studio_modes(monkeypatch, tmp_path):
    plan = build_plan(load_profile(H3), Settings.from_env({"AUTH_DISABLED": "true"}))
    setup = _setup_module(monkeypatch, tmp_path, plan)
    info = setup.kit_info("h3-t2v.json")
    assert info["default_workflow"] == "h3-t2v.json"
    by_id = {w["id"]: w for w in info["workflows"]}
    assert by_id["h3-r2v"] == {"id": "h3-r2v", "title": plan["workflows"][2]["title"], "file": "h3-r2v.json", "studio": "r2v"}
    assert info["on_demand_gb"]["h3-multiframe"] == 22.93


def test_install_studio_copies_assets(monkeypatch, tmp_path):
    setup = _setup_module(monkeypatch, tmp_path, {"workflows": [], "models": []})
    web = tmp_path / "web"
    (web / "studio").mkdir(parents=True)
    (web / "studio" / "stale.js").write_text("old")
    assert setup.install_studio(str(web)) is True
    assert sorted(x.name for x in (web / "studio").iterdir()) == ["patch.js", "queue.js", "studio.css", "studio.js"]
    assert (web / "studio" / "studio.js").read_bytes() == (STUDIO / "studio.js").read_bytes()


def test_kit_tarball_ships_the_studio():
    """The VM gets packages/colab as a tarball; the Studio must ride along for setup.py to install it."""
    import tarfile

    from gate.session import Session

    path = Session._kit_tarball(None, {"workflows": []})
    try:
        with tarfile.open(path) as tar:
            names = set(tar.getnames())
    finally:
        Path(path).unlink()
    assert {"colab/setup.py", "colab/studio/studio.js", "colab/studio/patch.js", "colab/studio/queue.js",
            "colab/studio/studio.css"} <= names


def test_studio_never_vendors_a_graph():
    """The page patches the frontend's own conversion of the installed workflows; it carries no workflow JSON."""
    src = "".join((STUDIO / f).read_text(encoding="utf-8") for f in ("studio.js", "patch.js", "queue.js"))
    assert "graphToPrompt" in src and "/kit/workflows/" in src
    assert '"class_type": "' not in src and "widgets_values" not in src


@pytest.mark.skipif(shutil.which("node") is None, reason="node is not installed")
def test_studio_js_unit_tests():
    """patch.js (the prompt patcher) and queue.js (queue order, estimates, projects)."""
    r = subprocess.run(["node", "--test", "tests/studio/patch.test.mjs", "tests/studio/queue.test.mjs"], cwd=ROOT,
                       capture_output=True, text=True, timeout=120)
    assert r.returncode == 0, r.stdout[-4000:] + r.stderr[-2000:]


@pytest.mark.skipif(shutil.which("node") is None, reason="node is not installed")
def test_studio_js_parses():
    for f in ("studio.js", "patch.js", "queue.js"):
        r = subprocess.run(["node", "--check", str(STUDIO / f)], capture_output=True, text=True, timeout=60)
        assert r.returncode == 0, r.stderr
