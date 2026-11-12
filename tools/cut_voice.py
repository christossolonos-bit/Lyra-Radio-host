#!/usr/bin/env python3
"""Cut one character's lines out of an episode and join them into a clean voice reference (free, local).

  python tools/cut_voice.py <episode.mp4> <out.wav> 299.0-300.34 302.02-303.44 ...

Timestamps come from a Whisper transcript. Each line gets a small pad and a short fade so the joins don't click,
with a quarter-second of silence between lines.
"""
import subprocess
import sys

src, out, spans = sys.argv[1], sys.argv[2], sys.argv[3:]
PAD, GAP = 0.08, 0.25
parts, labels = [], []
for i, span in enumerate(spans):
    a, b = (float(x) for x in span.split("-"))
    a, b = max(0, a - PAD), b + PAD
    d = b - a
    parts.append(f"[0:a]atrim={a:.3f}:{b:.3f},asetpts=PTS-STARTPTS,afade=t=in:d=0.03,afade=t=out:st={d - 0.05:.3f}:d=0.05,"
                 f"apad=pad_dur={GAP}[a{i}]")
    labels.append(f"[a{i}]")
graph = ";".join(parts) + f";{''.join(labels)}concat=n={len(spans)}:v=0:a=1,aformat=sample_rates=44100:channel_layouts=mono[out]"
subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", src, "-filter_complex", graph, "-map", "[out]", out], check=True)
dur = subprocess.check_output(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", out]).decode().strip()
print(f"WROTE {out} ({float(dur):.1f}s from {len(spans)} lines)")
