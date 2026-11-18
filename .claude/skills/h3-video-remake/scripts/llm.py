"""Ask a video model (Gemini) or an audio model (Qwen omni) about a reference clip.

Keys are read from the nearest `.env` (searched upward from the current directory, then from this script);
they are never printed. Needed variables:
  GEMINI_BASE_URL, GEMINI_API_KEY, GEMINI_MODEL, GEMINI_PROTOCOL (OPENAI_RESPONSE or chat)
  BAI_LIAN_BASE_URL, BAI_LIAN_API_KEY, BAI_LIAN_MODEL (an omni model that takes input_audio, e.g. qwen3.5-omni-plus)

usage:
  python llm.py gemini <video.mp4> <prompt.txt> <out.txt>
  python llm.py qwen   <audio.mp3|wav> <prompt.txt> <out.txt>
"""
import base64
import pathlib
import sys
import time

from openai import OpenAI


def find_env() -> pathlib.Path:
    for start in (pathlib.Path.cwd(), pathlib.Path(__file__).resolve().parent):
        for d in (start, *start.parents):
            if (d / ".env").is_file():
                return d / ".env"
    sys.exit("no .env found (looked upward from the current directory and from this script)")


def load_env() -> dict:
    out = {}
    for line in find_env().read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if line and not line.startswith("#") and "=" in line:
            k, v = line.split("=", 1)
            out[k.strip()] = v.strip().strip('"').strip("'")
    return out


def need(e: dict, *keys: str) -> None:
    missing = [k for k in keys if not e.get(k)]
    if missing:
        sys.exit("missing in .env: " + ", ".join(missing))


def b64(path: str) -> str:
    return base64.b64encode(pathlib.Path(path).read_bytes()).decode()


def gemini(e: dict, media: str, prompt: str) -> str:
    need(e, "GEMINI_BASE_URL", "GEMINI_API_KEY", "GEMINI_MODEL")
    client = OpenAI(api_key=e["GEMINI_API_KEY"], base_url=e["GEMINI_BASE_URL"], timeout=600)
    data_url = "data:video/mp4;base64," + b64(media)
    if e.get("GEMINI_PROTOCOL", "").upper() == "OPENAI_RESPONSE":
        r = client.responses.create(model=e["GEMINI_MODEL"], input=[{"role": "user", "content": [
            {"type": "input_file", "filename": pathlib.Path(media).name, "file_data": data_url},
            {"type": "input_text", "text": prompt}]}])
        return r.output_text
    r = client.chat.completions.create(model=e["GEMINI_MODEL"], messages=[{"role": "user", "content": [
        {"type": "video_url", "video_url": {"url": data_url}}, {"type": "text", "text": prompt}]}])
    return r.choices[0].message.content


def qwen(e: dict, media: str, prompt: str) -> str:
    need(e, "BAI_LIAN_BASE_URL", "BAI_LIAN_API_KEY", "BAI_LIAN_MODEL")
    client = OpenAI(api_key=e["BAI_LIAN_API_KEY"], base_url=e["BAI_LIAN_BASE_URL"], timeout=600)
    fmt = pathlib.Path(media).suffix.lstrip(".").lower()
    # omni models only answer in streaming mode
    stream = client.chat.completions.create(model=e["BAI_LIAN_MODEL"], stream=True, modalities=["text"],
        messages=[{"role": "user", "content": [
            {"type": "input_audio", "input_audio": {"data": f"data:;base64,{b64(media)}", "format": fmt}},
            {"type": "text", "text": prompt}]}])
    parts = []
    for chunk in stream:
        if chunk.choices and chunk.choices[0].delta and chunk.choices[0].delta.content:
            parts.append(chunk.choices[0].delta.content)
    return "".join(parts)


def main() -> None:
    if len(sys.argv) != 5 or sys.argv[1] not in ("gemini", "qwen"):
        sys.exit(__doc__)
    which, media, prompt_file, out = sys.argv[1:5]
    prompt = pathlib.Path(prompt_file).read_text(encoding="utf-8")
    t = time.time()
    text = (gemini if which == "gemini" else qwen)(load_env(), media, prompt)
    pathlib.Path(out).parent.mkdir(parents=True, exist_ok=True)
    pathlib.Path(out).write_text(text, encoding="utf-8")
    print(f"{which}: {len(text)} chars in {time.time() - t:.0f}s -> {out}")


if __name__ == "__main__":
    main()
