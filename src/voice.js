// Lyra's voice: Fish Audio text-to-speech.
// Rule: exactly ONE TTS request per reply. The whole reply goes in one call.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

const FISH_URL = "https://api.fish.audio/v1/tts";

export const VOICE_ID = process.env.FISH_VOICE_LYRA || "";
const FISH_MODEL = process.env.FISH_MODEL || "s1";

// Turn text into speech. Returns the path of the saved mp3.
// speed: 1 = Fish's normal pace, 0.9 = about 10% slower and more relaxed.
export async function synthesize(text, outFile = path.join(os.tmpdir(), "lyra_reply.mp3"), voiceId = VOICE_ID, speed = 1) {
  if (!voiceId) throw new Error("No voice set. Put the Fish voice id in .env (FISH_VOICE_LYRA / FISH_VOICE_NOVA).");

  const res = await fetch(FISH_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.FISH_API_KEY}`,
      "Content-Type": "application/json",
      model: FISH_MODEL,
    },
    body: JSON.stringify({ text, reference_id: voiceId, format: "mp3", prosody: { speed, volume: 0 } }),
  });
  if (!res.ok) throw new Error(`Fish TTS ${res.status}: ${(await res.text()).slice(0, 200)}`);

  fs.writeFileSync(outFile, Buffer.from(await res.arrayBuffer()));
  return outFile;
}

// Start playing an audio file (uses ffplay from FFmpeg).
// Returns { done, stop }: done resolves when it finishes, stop() cuts it off early.
// maxSeconds > 0 cuts playback short (used for quick radio tests).
export function startPlayback(file, maxSeconds = 0) {
  const args = ["-nodisp", "-autoexit", "-loglevel", "quiet"];
  if (maxSeconds > 0) args.push("-t", String(maxSeconds));
  const p = spawn("ffplay", [...args, file], { stdio: "ignore" });
  const done = new Promise((resolve, reject) => {
    p.on("error", () => reject(new Error("ffplay not found. Install FFmpeg to hear Lyra.")));
    p.on("close", resolve);
  });
  return { done, stop: () => p.kill() };
}

// Play an audio file and wait until it finishes.
export function play(file) {
  return startPlayback(file).done;
}

export async function speak(text) {
  if (!text.trim()) return;
  await play(await synthesize(text));
}
