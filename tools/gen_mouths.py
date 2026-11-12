#!/usr/bin/env python3
"""Mouth shapes and a blink for Lyra's live lip sync, made through production_lock.py.

Each one is an edit of the approved first frame where ONLY the mouth (or eyes) change.
Afterwards make_sprites.py pastes just that area onto the base face, so nothing else can drift.

  python tools/gen_mouths.py prompts        # print every prompt (free)
  python tools/gen_mouths.py all            # make all 5 (~$0.03 each, GPT Image 2)
  python tools/gen_mouths.py ah             # make just one
"""
from __future__ import annotations

import base64
import json
import sys
import urllib.error
import urllib.request
from pathlib import Path

SERIES = Path(r"D:\Music for distrokid\Solo Stories\Lyra AI movie")
sys.path.insert(0, str(SERIES))
from production_lock import REFS, Shot, build_prompt, submit, _image  # noqa: E402

CLIPS = Path(__file__).resolve().parent.parent / "public" / "clips"
BASE = CLIPS / "lyra_live_first.png"
OUT = CLIPS / "shapes"
OUT.mkdir(parents=True, exist_ok=True)

KEEP = ("Edit the FIRST reference image. Keep everything else pixel-identical: the same face, eyes, eyebrows, hair, "
        "head position, framing, glow, scanlines and pure black background. Change only this: ")
SHAPES = {
    "small": "her lips are slightly parted, relaxed, as if in the middle of a word. Eyes unchanged.",
    "ah":    "her mouth is open as when saying 'ah', jaw dropped a little, upper teeth just visible. Eyes unchanged.",
    "ee":    "her mouth is wide as when saying 'ee', lips stretched, teeth together and visible. Eyes unchanged.",
    "oo":    "her lips are rounded and pushed slightly forward as when saying 'oo', a small round opening. Eyes unchanged.",
    "blink": "her eyes are gently closed, mid-blink, eyelids relaxed. Mouth unchanged.",
}


def shot(name: str) -> Shot:
    return Shot(id=f"MOUTH_{name}", director="SPIELBERG", characters=["Lyra"], engine="care", framing="upper_body",
                beat="Lyra mid-word on her live show", location="the dark projection room inside the Vira campus, lights off",
                action=KEEP + SHAPES[name])


def key() -> str:
    for line in Path(r"d:\movie maker\.env").read_text(encoding="utf-8").splitlines():
        if line.startswith("OPENROUTER_API_KEY="):
            return line.split("=", 1)[1].strip()
    raise SystemExit("no OPENROUTER_API_KEY")


def make(name: str, k: str) -> None:
    payload = {
        "model": "openai/gpt-image-2", "prompt": build_prompt(shot(name)), "aspect_ratio": "16:9",
        # the approved frame first (what to edit), then her face ref for identity
        "input_references": [_image(BASE), _image(REFS / "lyra_face_source.png")],
    }
    try:
        body = submit("https://openrouter.ai/api/v1/images", k, payload, timeout=300)
    except urllib.error.HTTPError as e:
        raise SystemExit(f"REJECTED {e.code}: {e.read().decode('utf-8', 'replace')[:600]}")
    data = (body.get("data") or [None])[0]
    if not data:
        raise SystemExit(f"no image for {name}: {json.dumps(body)[:500]}")
    out = OUT / f"{name}.png"
    if data.get("b64_json"):
        out.write_bytes(base64.b64decode(data["b64_json"]))
    else:
        with urllib.request.urlopen(data["url"], timeout=120) as r:
            out.write_bytes(r.read())
    print(f"SAVED {out.name}  cost={(body.get('usage') or {}).get('cost')}", flush=True)


if __name__ == "__main__":
    arg = sys.argv[1] if len(sys.argv) > 1 else "prompts"
    if arg == "prompts":
        for n in SHAPES:
            print(f"\n== {n} ==\n{build_prompt(shot(n))}")
    else:
        names = list(SHAPES) if arg == "all" else [arg]
        k = key()
        for n in names:
            make(n, k)
