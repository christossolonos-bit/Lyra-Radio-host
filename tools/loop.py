#!/usr/bin/env python3
"""Make a clip loop seamlessly: crossfade its last half-second into its first half-second.

  python tools/loop.py public/clips/lyra_talk.mp4 public/clips/lyra_talk_loop.mp4

The output starts 0.5 s in and ends on that same frame, so it repeats with no jump. Free, no API calls.
"""
import json
import subprocess
import sys

FADE = 0.5

src, out = sys.argv[1], sys.argv[2]
dur = float(json.loads(subprocess.check_output(
    ["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "json", src]))["format"]["duration"])
body = dur - FADE                      # the clip without its first half-second
offset = body - FADE                   # where the crossfade into the opening starts
graph = (f"[0:v]split[x][y];"
         f"[x]trim=start={FADE},setpts=PTS-STARTPTS[a];"
         f"[y]trim=end={FADE},setpts=PTS-STARTPTS[b];"
         f"[a][b]xfade=transition=fade:duration={FADE}:offset={offset:.3f},format=yuv420p[v]")
subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", src, "-filter_complex", graph, "-map", "[v]", "-an",
                "-c:v", "libx264", "-crf", "20", "-preset", "slow", "-movflags", "+faststart", out], check=True)
print(f"LOOPED {out} ({body:.2f}s)")
