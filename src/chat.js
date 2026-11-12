// Talk to Lyra in the terminal. Run with: npm run chat
//   /as <name>   pretend to be a different viewer
//   /mute        toggle her voice on and off
//   exit         quit

import readline from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { createLyra, MODEL, CANON_UP_TO } from "./lyra.js";
import { speak, VOICE_ID } from "./voice.js";

const lyra = createLyra();
const rl = readline.createInterface({ input: stdin, output: stdout });
let viewer = "viewer";
let voiceOn = Boolean(VOICE_ID);

console.log(`Lyra is live (${MODEL}, knows episodes 1-${CANON_UP_TO}).`);
console.log(voiceOn ? "Voice: on." : "Voice: off (set FISH_VOICE_LYRA in .env to hear her).");
console.log(`Type to chat. "/as Name" switches viewer, "/mute" toggles voice, "exit" quits.\n`);

while (true) {
  const line = (await rl.question(`${viewer}: `)).trim();
  if (!line) continue;
  if (line.toLowerCase() === "exit") break;
  if (line.startsWith("/as ")) {
    viewer = line.slice(4).trim() || "viewer";
    continue;
  }
  if (line === "/mute") {
    voiceOn = !voiceOn && Boolean(VOICE_ID);
    console.log(voiceOn ? "(voice on)" : "(voice off)");
    continue;
  }

  stdout.write("Lyra: ");
  try {
    const reply = await lyra.say(viewer, line, (t) => stdout.write(t));
    stdout.write("\n");
    if (voiceOn) await speak(reply);
  } catch (err) {
    console.error(`\n[error] ${err.status ? `${err.status} ` : ""}${err.message}`);
  }
  stdout.write("\n");
}

rl.close();
