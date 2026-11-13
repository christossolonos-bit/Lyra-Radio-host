// Records the podcast: each topic becomes recordings/<date>_<topic>_<guest>.mp3 plus a .md transcript,
// with the same pauses between lines that listeners heard. Free: it reuses the voiced lines and ffmpeg.

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const DIR = process.env.DATA_DIR ? path.join(process.env.DATA_DIR, "recordings") : path.join(here, "..", "recordings");
const PARTS = path.join(DIR, ".parts");
const ENABLED = process.env.PODCAST_RECORD !== "0";

const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 50);

export function createRecorder(showName) {
  let session = null; // { topic, guest, startedAt, parts: [{ file, pauseMs, who, text }] }

  function start(topic, guest) {
    if (!ENABLED) return;
    finish();
    session = { topic, guest, startedAt: new Date(), parts: [] };
  }

  // Keep a copy of a line's audio (the original is deleted after it plays).
  function add(line, file, pauseMs = 0) {
    if (!session || !file) return;
    fs.mkdirSync(PARTS, { recursive: true });
    const copy = path.join(PARTS, `${crypto.randomUUID()}.mp3`);
    try { fs.copyFileSync(file, copy); } catch { return; }
    session.parts.push({ file: copy, pauseMs, who: line.who, text: line.text });
  }

  // Join everything into one MP3 (in the background) and write the transcript.
  function finish() {
    const s = session;
    session = null;
    if (!s) return;
    const cleanup = () => s.parts.forEach((p) => fs.rmSync(p.file, { force: true }));
    if (s.parts.length < 3) return cleanup(); // too short to be an episode

    const t = s.startedAt, two = (n) => String(n).padStart(2, "0");
    const stamp = `${t.getFullYear()}-${two(t.getMonth() + 1)}-${two(t.getDate())}_${two(t.getHours())}${two(t.getMinutes())}`; // local time
    const base = path.join(DIR, `${stamp}_${slug(s.topic)}_${s.guest.toLowerCase()}`);
    const inputs = s.parts.flatMap((p) => ["-i", p.file]);
    const chains = s.parts.map((p, i) =>
      `[${i}:a]aresample=44100,aformat=channel_layouts=mono,adelay=${Math.round(p.pauseMs)}:all=1[a${i}]`).join(";");
    const graph = `${chains};${s.parts.map((_, i) => `[a${i}]`).join("")}concat=n=${s.parts.length}:v=0:a=1[out]`;
    execFile("ffmpeg", ["-v", "error", "-y", ...inputs, "-filter_complex", graph, "-map", "[out]", "-b:a", "160k", `${base}.mp3`],
      { maxBuffer: 1 << 20 }, (err) => {
        cleanup();
        if (err) return console.error(`[recording] failed: ${err.message.split("\n")[0]}`);
        console.log(`[recording] saved ${path.basename(base)}.mp3`);
      });

    const transcript = [
      `# ${s.topic[0].toUpperCase()}${s.topic.slice(1)}`,
      "",
      `*${showName}*, with Lyra and ${s.guest}. Recorded ${s.startedAt.toLocaleString("en-GB")}.`,
      "",
      ...s.parts.map((p) => `**${p.who}:** ${p.text}\n`),
    ].join("\n");
    fs.writeFileSync(`${base}.md`, transcript);
  }

  return { start, add, finish, topic: () => session?.topic };
}
