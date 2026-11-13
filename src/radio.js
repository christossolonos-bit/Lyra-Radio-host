// Lyra Radio, live stations: Lyra plays real internet radio and talks over it.
// Run with: npm run radio
//   type a message      Lyra answers it in her next talk break (within about 20 seconds)
//   /as <name>          pretend to be a different viewer
//   /talk               make Lyra talk now
//   /station <words>    switch station yourself (e.g. /station greek)
//   exit                stop the show
//
// Not for YouTube streams: rebroadcasting stations gets streams muted or taken down.
// For YouTube use your own songs: npm run radio:playlist
//
// Each talk break = ONE model request + ONE TTS request. Failures are skipped, never retried.

import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { execFile } from "node:child_process";
import { pathToFileURL } from "node:url";
import { createLyra } from "./lyra.js";
import { synthesize, startPlayback, play } from "./voice.js";

const SHOW_NAME = process.env.RADIO_SHOW_NAME || "Lyra Radio";
const START_STATION = process.env.RADIO_STATION || "chillout";
// Lyra talks on her own every this many minutes when nobody writes in.
const TALK_EVERY_MIN = Number(process.env.RADIO_TALK_EVERY_MIN || 8);
// Wait at least this long between breaks, so chat doesn't stop the music every few seconds.
const MIN_GAP_SEC = 20;
const MAX_MESSAGES_PER_BREAK = 3;

// ---------- Stations (radio-browser.info, a free public directory) ----------

const DIRECTORY = "https://de1.api.radio-browser.info/json/stations/search";

export async function findStations(words) {
  const query = new URLSearchParams({
    hidebroken: "true", order: "votes", reverse: "true", limit: "15",
  });
  const tries = [{ tag: words.toLowerCase(), tagExact: "true" }, { tag: words.toLowerCase() }, { name: words }];
  for (const extra of tries) {
    const url = `${DIRECTORY}?${new URLSearchParams({ ...Object.fromEntries(query), ...extra })}`;
    const res = await fetch(url, { headers: { "User-Agent": "lyra-live/0.1" } });
    if (!res.ok) continue;
    // a public https site can't play http:// streams (browsers block them), so it only uses https ones
    const httpsOnly = Boolean(process.env.ADMIN_KEY);
    const found = (await res.json()).filter(
      (s) => s.url_resolved && ["MP3", "AAC", "AAC+", "OGG"].includes(s.codec) && (s.bitrate === 0 || s.bitrate >= 64) &&
        (!httpsOnly || s.url_resolved.startsWith("https://")),
    );
    if (found.length) return found;
  }
  return [];
}

// Pick one of the top few results so the same search doesn't always give the same station.
export const pickOne = (list) => list[Math.floor(Math.random() * Math.min(5, list.length))];

export function describeStation(s) {
  const tags = s.tags.split(",").filter(Boolean).slice(0, 4).join(", ");
  return `"${s.name.trim()}" from ${s.country || "somewhere"}${tags ? ` (${tags})` : ""}`;
}

// What song is on right now? Internet radio slips the title into the audio stream every few KB
// ("ICY metadata") when you ask with an Icy-MetaData header. Returns "" if the station doesn't share it.
export async function nowPlayingTitle(url, timeoutMs = 7000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { headers: { "Icy-MetaData": "1", "User-Agent": "lyra-live/0.1" }, signal: ctrl.signal });
    const metaint = Number(res.headers.get("icy-metaint"));
    if (!res.ok || !metaint) return ffprobeTitle(url); // this station doesn't do ICY; try the slower way
    const reader = res.body.getReader();
    let buf = new Uint8Array(0);
    // read: [metaint bytes of audio][1 byte: metadata length / 16][metadata]
    while (true) {
      if (buf.length > metaint) {
        const len = buf[metaint] * 16;
        if (len === 0) return ""; // no title in this block
        if (buf.length >= metaint + 1 + len) {
          const meta = Buffer.from(buf.subarray(metaint + 1, metaint + 1 + len)).toString("utf8");
          const m = meta.match(/StreamTitle='(.*?)';/);
          return cleanTitle(m ? m[1] : "");
        }
      }
      const { value, done } = await reader.read();
      if (done) return "";
      const next = new Uint8Array(buf.length + value.length);
      next.set(buf);
      next.set(value, buf.length);
      buf = next;
    }
  } catch {
    return "";
  } finally {
    clearTimeout(timer);
    ctrl.abort(); // stop downloading audio
  }
}

// Station IDs and ads aren't songs.
function cleanTitle(t) {
  const s = t.replace(/\0/g, "").trim();
  if (!s || s.length < 3 || /^(-|\s)*$/.test(s) || /advert|commercial|^live$|station id/i.test(s)) return "";
  if (!/\s/.test(s) && /\d/.test(s) && s.length > 8) return ""; // a random code like "u1dzdnmg65quv", not a song
  return s;
}

function ffprobeTitle(url) {
  return new Promise((resolve) => {
    execFile(
      "ffprobe",
      ["-v", "error", "-show_entries", "format_tags=StreamTitle", "-of", "default=nw=1:nk=1", url],
      { timeout: 6000 },
      (err, stdout) => resolve(err ? "" : cleanTitle(stdout.trim())),
    );
  });
}

// Lyra ends a reply with [[station: words]] when she wants to switch. Split that off.
export function splitStationTag(text) {
  const m = text.match(/\[\[\s*station\s*:\s*([^\]]+?)\s*\]\]/i);
  return { spoken: text.replace(/\[\[[^\]]*\]\]/g, "").trim(), station: m ? m[1] : null };
}

// ---------- The show ----------

async function main() {
  const lyra = createLyra();
  const inbox = [];
  let viewer = "viewer";
  let station = null;
  let stream = null;
  let busy = false;
  let lastBreak = 0;
  let forceTalk = false;

  async function tuneTo(words) {
    const found = await findStations(words).catch(() => []);
    if (!found.length) {
      console.log(`[radio] no station found for "${words}"`);
      return false;
    }
    station = pickOne(found);
    console.log(`📻 Tuned to ${describeStation(station)}`);
    return true;
  }

  function startStream() {
    stream?.stop();
    const s = startPlayback(station.url_resolved);
    s.ourStop = false;
    const stop = s.stop;
    s.stop = () => { s.ourStop = true; stop(); };
    // If the station drops on its own, find another one with the same style.
    s.done.then(async () => {
      if (s.ourStop || stream !== s) return;
      console.log("[radio] station dropped, finding another");
      const style = station.tags.split(",")[0] || START_STATION;
      if (await tuneTo(style)) startStream();
    });
    stream = s;
  }

  // One talk break: ONE model request, ONE TTS request.
  async function talkBreak(cueText) {
    busy = true;
    try {
      const reply = await lyra.cue(cueText);
      const { spoken, station: wanted } = splitStationTag(reply);
      const file = await synthesize(spoken, path.join(os.tmpdir(), `lyra_talk_${Date.now()}.mp3`));
      stream?.stop();
      console.log(`\nLyra: ${spoken}\n`);
      await play(file);
      fs.rmSync(file, { force: true });
      if (wanted) await tuneTo(wanted);
    } catch (err) {
      console.error(`[break skipped] ${err.status ? `${err.status} ` : ""}${err.message}`);
    } finally {
      if (station) startStream();
      lastBreak = Date.now();
      busy = false;
    }
  }

  async function stationInfo() {
    const title = await nowPlayingTitle(station.url_resolved);
    return `You're tuned to ${describeStation(station)}.${title ? ` The station says the current song is "${title}".` : ""}`;
  }

  const rl = readline.createInterface({ input: process.stdin });
  rl.on("line", async (raw) => {
    const line = raw.trim();
    if (!line) return;
    if (line.toLowerCase() === "exit") {
      stream?.stop();
      console.log("Show over.");
      process.exit(0);
    }
    if (line === "/talk") return (forceTalk = true);
    if (line.startsWith("/station ")) {
      if (await tuneTo(line.slice(9).trim())) startStream();
      return;
    }
    if (line.startsWith("/as ")) {
      viewer = line.slice(4).trim() || "viewer";
      return console.log(`(you are now ${viewer})`);
    }
    inbox.push({ from: viewer, text: line });
    console.log(`(Lyra will answer in her next break: ${viewer}: ${line})`);
  });

  console.log(`${SHOW_NAME} (live stations). Type to chat, /talk, /station <words>, /as Name, exit.\n`);
  if (!(await tuneTo(START_STATION))) process.exit(1);

  await talkBreak(
    `The show "${SHOW_NAME}" is starting now, playing live radio stations from around the world. ` +
      `Welcome everyone listening and introduce the station. ${await stationInfo()}`,
  );

  // Every few seconds: talk if someone wrote in (and the gap has passed), or if it's been a while.
  setInterval(async () => {
    if (busy) return;
    const since = (Date.now() - lastBreak) / 1000;
    const hasMail = inbox.length > 0 && since >= MIN_GAP_SEC;
    const due = since >= TALK_EVERY_MIN * 60;
    if (!hasMail && !due && !forceTalk) return;
    forceTalk = false;
    busy = true; // claim the slot before the slow parts below
    const messages = inbox.splice(0, MAX_MESSAGES_PER_BREAK);
    const msgs = messages.length
      ? ` Viewer messages:\n${messages.map((m) => `${m.from}: ${m.text}`).join("\n")}`
      : " Nobody has written in. Say something short over the music.";
    await talkBreak(`Talk break. ${await stationInfo()}${msgs}`);
  }, 3000);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
