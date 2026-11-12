// Clone a voice on Fish Audio as a PRIVATE model from a reference wav (free).
//   node --env-file=.env tools/clone_voice.mjs "Marcus (episodes)" voice-refs/marcus_ep1.wav
import fs from "node:fs";
import path from "node:path";

const [title, file] = process.argv.slice(2);
const form = new FormData();
form.append("type", "tts");
form.append("title", title);
form.append("visibility", "private");
form.append("train_mode", "fast");
form.append("description", `${title}, cloned from the Lyra AI series. Private.`);
form.append("voices", new Blob([fs.readFileSync(file)], { type: "audio/wav" }), path.basename(file));
const res = await fetch("https://api.fish.audio/model", {
  method: "POST",
  headers: { Authorization: `Bearer ${process.env.FISH_API_KEY}` },
  body: form,
});
const j = await res.json();
console.log(res.status, title, j._id, j.state, j.visibility);
