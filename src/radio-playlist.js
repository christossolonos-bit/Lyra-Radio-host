// Lyra Radio: plays your songs and Lyra talks in the breaks.
// Run with: npm run radio
//   type a message   it waits for the next break, then Lyra answers it on air
//   /as <name>       pretend to be a different viewer
//   /skip            skip the current song
//   exit             stop the show
//
// Each break = ONE model request + ONE TTS request. A failed break is skipped, never retried.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createLyra } from "./lyra.js";
import { synthesize, startPlayback, play } from "./voice.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const PLAYLIST = path.join(here, "..", "radio", "playlist.txt");

const SHOW_NAME = process.env.RADIO_SHOW_NAME || "Lyra Radio";
// Start preparing the next break this many seconds before the song ends.
const PREP_SECONDS = Number(process.env.RADIO_PREP_SECONDS || 30);
// For testing: cut every song to this many seconds (0 = full songs).
const MAX_SONG_SECONDS = Number(process.env.RADIO_MAX_SONG_SECONDS || 0);
// How many viewer messages Lyra answers per break. The rest wait for the next one.
const MAX_MESSAGES_PER_BREAK = 3;

// ---------- Playlist ----------

function probe(file) {
  const out = execFileSync("ffprobe", [
    "-v", "error", "-show_entries", "format=duration:format_tags=title,artist", "-of", "json", file,
  ]);
  const { format } = JSON.parse(out);
  return { duration: Number(format.duration) || 0, tags: format.tags || {} };
}

export function loadPlaylist(file = PLAYLIST) {
  const tracks = [];
  for (const raw of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const [filePath, title, artist] = line.split("|").map((s) => s.trim());
    if (!fs.existsSync(filePath)) {
      console.warn(`[playlist] missing, skipped: ${filePath}`);
      continue;
    }
    const { duration, tags } = probe(filePath);
    tracks.push({
      file: filePath,
      title: title || tags.title || path.parse(filePath).name,
      artist: artist || tags.artist || "",
      duration,
    });
  }
  return tracks;
}

// Shuffled order that reshuffles when it runs out and never plays the same song twice in a row.
function createDeck(tracks) {
  let pile = [];
  let last = null;
  return function next() {
    if (pile.length === 0) {
      pile = [...tracks].sort(() => Math.random() - 0.5);
      if (pile.length > 1 && pile[pile.length - 1] === last) pile.unshift(pile.pop());
    }
    last = pile.pop();
    return last;
  };
}

// ---------- What Lyra is told before each break ----------

const describe = (t) => `"${t.title}"${t.artist ? ` by ${t.artist}` : ""}`;

export function openingCue(next) {
  return `The show "${SHOW_NAME}" is starting now. Open the show, welcome everyone listening, then introduce the first song: ${describe(next)}.`;
}

export function breakCue(prev, next, messages) {
  const msgs = messages.length
    ? ` Viewer messages that came in during the song:\n${messages.map((m) => `${m.from}: ${m.text}`).join("\n")}`
    : " No viewer messages this time.";
  return `${describe(prev)} just finished. Next song: ${describe(next)}.${msgs}`;
}

// ---------- The show ----------

async function main() {
  const tracks = loadPlaylist();
  if (tracks.length === 0) {
    console.error("No playable songs in radio/playlist.txt.");
    process.exit(1);
  }
  const nextTrack = createDeck(tracks);
  const lyra = createLyra();
  const inbox = [];
  let viewer = "viewer";
  let nowPlaying = null;

  // One model request + one TTS request. Returns null if either fails (the show just keeps playing).
  async function makeBreak(cueText) {
    try {
      const text = await lyra.cue(cueText);
      const file = await synthesize(text, path.join(os.tmpdir(), `lyra_break_${Date.now()}.mp3`));
      return { text, file };
    } catch (err) {
      console.error(`[break skipped] ${err.status ? `${err.status} ` : ""}${err.message}`);
      return null;
    }
  }

  const rl = readline.createInterface({ input: process.stdin });
  rl.on("line", (raw) => {
    const line = raw.trim();
    if (!line) return;
    if (line.toLowerCase() === "exit") {
      nowPlaying?.stop();
      console.log("Show over.");
      process.exit(0);
    }
    if (line === "/skip") return nowPlaying?.stop();
    if (line.startsWith("/as ")) {
      viewer = line.slice(4).trim() || "viewer";
      return console.log(`(you are now ${viewer})`);
    }
    inbox.push({ from: viewer, text: line });
    console.log(`(queued for the next break: ${viewer}: ${line})`);
  });

  console.log(`${SHOW_NAME} is on air with ${tracks.length} songs. Type to chat, /skip, /as Name, exit.\n`);

  let current = nextTrack();
  let brk = await makeBreak(openingCue(current));

  while (true) {
    if (brk) {
      console.log(`\nLyra: ${brk.text}\n`);
      await play(brk.file);
      fs.rmSync(brk.file, { force: true });
    }

    const next = nextTrack();
    const length = MAX_SONG_SECONDS ? Math.min(MAX_SONG_SECONDS, current.duration) : current.duration;
    console.log(`♪ Now playing: ${describe(current)} (${Math.round(length)}s)`);
    nowPlaying = startPlayback(current.file, MAX_SONG_SECONDS);

    // Prepare the next break near the end of the song, using the messages that arrived so far.
    let prepared = null;
    const prepare = () => {
      const messages = inbox.splice(0, MAX_MESSAGES_PER_BREAK);
      prepared = makeBreak(breakCue(current, next, messages));
    };
    const timer = setTimeout(prepare, Math.max(0, (length - PREP_SECONDS) * 1000));

    await nowPlaying.done;
    clearTimeout(timer);
    if (!prepared) prepare(); // song was skipped before the break was prepared
    brk = await prepared;
    current = next;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
