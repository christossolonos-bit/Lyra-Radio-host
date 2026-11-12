#!/usr/bin/env python3
"""Lyra's talking and idle loops for the hologram screen, made through production_lock.py.

One step per run, and each paid step only after Chris says yes:
  python tools/gen_talking.py prompts   # print every prompt (free)
  python tools/gen_talking.py still     # first frame, GPT Image 2 (~$0.06)
  python tools/gen_talking.py talk      # 6 s talking loop, Hailuo 3 Max 768p silent (~$0.48)
  python tools/gen_talking.py idle      # 6 s idle loop, same model (~$0.48)

Outputs land in public/clips/. Both loops start AND end on the first frame, so they loop and swap cleanly.
"""
from __future__ import annotations

import base64
import json
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

SERIES = Path(r"D:\Music for distrokid\Solo Stories\Lyra AI movie")
sys.path.insert(0, str(SERIES))
from production_lock import Line, Shot, build_prompt, ref_paths, submit, video_payload, _image  # noqa: E402

OUT = Path(__file__).resolve().parent.parent / "public" / "clips"
OUT.mkdir(parents=True, exist_ok=True)
FIRST = OUT / "lyra_live_first.png"
API = "https://openrouter.ai/api/v1"

BLACK = ("Pure black empty background, nothing else in frame: no room, no floor, no platform, no furniture, "
         "so she can be shown as a hologram on a black screen.")
BASE = dict(
    director="SPIELBERG", characters=["Lyra"], engine="care", framing="upper_body",
    location="the dark projection room inside the Vira campus, lights off",
)

STILL = Shot(id="LIVE0", beat="Lyra is present and warm for the people watching her show", **BASE,
             action=f"Lyra's hologram, centred, facing the camera straight on, head and shoulders down to the chest, "
                    f"a soft natural smile, mouth closed. {BLACK}")

# Hailuo 3 Max takes one keyframe only, so the loops get the first frame and loop.py crossfades the end back into it.
TALK = Shot(id="LIVE1", beat="Lyra talks to the people watching her show", **BASE, duration=6,
            first_frame=FIRST,
            action=f"Lyra talks warmly to the camera, small head tilts and eyebrow lifts, smiling between phrases, "
                   f"and ends back in her starting pose. Camera locked off, no movement. {BLACK}",
            lines=[Line("Lyra", "talks to camera with small head tilts", "Hi everyone. It's sixty-eight in here, and Patch is asleep.")])

IDLE = Shot(id="LIVE2", beat="Lyra listens to the people watching her show", **BASE, duration=6,
            first_frame=FIRST,
            action=f"Lyra listens with her mouth closed: she blinks, breathes, a tiny smile, her hair drifts slightly, "
                   f"and she ends back in her starting pose. Camera locked off, no movement. {BLACK}")


def key() -> str:
    for line in Path(r"d:\movie maker\.env").read_text(encoding="utf-8").splitlines():
        if line.startswith("OPENROUTER_API_KEY="):
            return line.split("=", 1)[1].strip()
    raise SystemExit("no OPENROUTER_API_KEY in d:\\movie maker\\.env")


def get(url: str, k: str) -> dict:
    with urllib.request.urlopen(urllib.request.Request(url, headers={"Authorization": f"Bearer {k}"}), timeout=60) as r:
        return json.loads(r.read())


def still() -> None:
    k = key()
    payload = {"model": "openai/gpt-image-2", "prompt": build_prompt(STILL), "aspect_ratio": "16:9",
               "input_references": [_image(p) for p in ref_paths(STILL)]}
    body = submit(f"{API}/images", k, payload, timeout=300)
    data = (body.get("data") or [None])[0]
    if not data:
        raise SystemExit(f"no image: {json.dumps(body)[:600]}")
    if data.get("b64_json"):
        FIRST.write_bytes(base64.b64decode(data["b64_json"]))
    else:
        with urllib.request.urlopen(data["url"], timeout=120) as r:
            FIRST.write_bytes(r.read())
    print(f"SAVED {FIRST}  cost={(body.get('usage') or {}).get('cost')}")


def video(shot: Shot, name: str) -> None:
    if not FIRST.exists():
        raise SystemExit("make the first frame first: python tools/gen_talking.py still")
    k = key()
    payload = video_payload(shot, model="minimax/hailuo-3-max", resolution="768p")
    payload["generate_audio"] = False  # muted on the page; her Fish voice plays instead (rule 8: H3 Max = silent)
    try:
        job = submit(f"{API}/videos", k, payload, timeout=180)
    except urllib.error.HTTPError as e:  # rejected before starting: nothing charged
        raise SystemExit(f"REJECTED {e.code}: {e.read().decode('utf-8', 'replace')[:800]}")
    poll = job.get("polling_url") or f"{API}/videos/{job.get('id')}"
    print(f"JOB {job.get('id')}", flush=True)
    while True:
        time.sleep(10)
        res = get(poll, k)
        status = res.get("status")
        print(f"  {status}", flush=True)
        if status in ("completed", "succeeded"):
            break
        if status in ("failed", "error", "cancelled"):
            raise SystemExit(f"FAILED: {json.dumps(res)[:600]}")
    out = OUT / f"{name}.mp4"
    url = (res.get("unsigned_urls") or [None])[0]
    with urllib.request.urlopen(urllib.request.Request(url, headers={"Authorization": f"Bearer {k}"}), timeout=180) as r:
        out.write_bytes(r.read())
    print(f"SAVED {out}  cost={(res.get('usage') or {}).get('cost')}")


if __name__ == "__main__":
    step = sys.argv[1] if len(sys.argv) > 1 else "prompts"
    if step == "prompts":
        for s in (STILL, TALK, IDLE):
            print(f"\n== {s.id} ==\n{build_prompt(s)}\nrefs: {[p.name for p in ref_paths(s)]}")
    elif step == "still":
        still()
    elif step == "talk":
        video(TALK, "lyra_talk")
    elif step == "idle":
        video(IDLE, "lyra_idle")
    else:
        raise SystemExit(__doc__)
