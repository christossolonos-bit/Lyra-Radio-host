// Lyra's hologram show: a small local web server.
// Run with: npm run holo, then open http://localhost:5177
//
// The server is Lyra's brain and voice (Nemotron + Fish) and finds radio stations.
// The browser page is the show: it draws the hologram and plays her voice and the station.
// Each talk = ONE model request + ONE TTS request. Failures are skipped, never retried.

import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { createLyra, MODEL } from "./lyra.js";
import { synthesize, VOICE_ID } from "./voice.js";
import { createPodcast, TOPICS, PODCAST_NAME } from "./podcast.js";
import { voiceOf, availableGuests, guestCard } from "./cast.js";
import { songMedia } from "./media.js";
import { findStations, splitStationTag, describeStation, nowPlayingTitle, pickOne } from "./radio.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(here, "..", "public");
const AUDIO_DIR = path.join(os.tmpdir(), "lyra-live-audio");
fs.mkdirSync(AUDIO_DIR, { recursive: true });

const PORT = Number(process.env.PORT || 5177);
const SHOW_NAME = process.env.RADIO_SHOW_NAME || "Lyra Radio";
const START_STATION = process.env.RADIO_STATION || "chillout";
const TALK_EVERY_MIN = Number(process.env.RADIO_TALK_EVERY_MIN || 8);
const MIN_GAP_SEC = 8; // she answers chat quickly here, since people can see her
const MAX_MESSAGES_PER_TALK = 3;

// ---------- Show state ----------

const lyra = createLyra();
const clients = new Set(); // open browser pages (Server-Sent Events)
const inbox = [];
let station = null;
let live = false;
let busy = false;
let lastTalk = 0;
let finishSpeaking = null; // resolves when the page says her audio has finished

// Podcast mode: Lyra and Nova talk about topics. "radio" mode is the stations + chat show.
const SEGMENTS_PER_TOPIC = 3;
// Podcast pacing: a slightly slower voice, and a human pause before each turn.
const PODCAST_SPEED = Number(process.env.PODCAST_SPEED || 0.9);
const PAUSE_MS = [550, 1100]; // random pause between lines, in milliseconds
let guest = null; // who's in the studio with Lyra right now
const podcast = createPodcast();
let mode = "radio";
let podcastRunning = false;
let topicDeck = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function nextTopic() {
  if (!topicDeck.length) topicDeck = [...TOPICS].sort(() => Math.random() - 0.5);
  return topicDeck.pop();
}

function broadcast(event) {
  const data = `data: ${JSON.stringify(event)}\n\n`;
  for (const res of clients) res.write(data);
}

function stationEvent() {
  return station && {
    type: "station",
    name: station.name.trim(),
    country: station.country,
    tags: station.tags.split(",").filter(Boolean).slice(0, 3),
    url: station.url_resolved,
  };
}

// ---------- What's playing ----------
let nowPlaying = "";      // the current song, if the station shares it
let recentSongs = [];     // the last few songs before it
let nowPlayingAt = 0;     // when we last checked

let songVisual = { type: "songmedia", title: "" }; // video / artwork for the current song

function setNowPlaying(title) {
  if (title === nowPlaying) return false;
  if (nowPlaying) recentSongs = [nowPlaying, ...recentSongs].slice(0, 4);
  nowPlaying = title;
  console.log(`♪ ${title || "(no title)"}`);
  broadcast({ type: "nowplaying", title });
  // find a music video / album art for it in the background, then send it to the page
  songMedia(title).then((m) => {
    if (title !== nowPlaying) return; // the song already changed again
    songVisual = { type: "songmedia", title, ...m };
    if (title) console.log(`  visuals: ${m.videoId ? `video ${m.videoId}` : "no video"}, ${m.art ? "artwork" : "no artwork"}`);
    broadcast(songVisual);
  });
  return Boolean(title);
}

async function tuneTo(words) {
  const found = await findStations(words).catch(() => []);
  if (!found.length) {
    console.log(`[radio] no station found for "${words}"`);
    return false;
  }
  // Prefer a station that tells us what song is on, so Lyra can know the music.
  const candidates = [...found.slice(0, 6)].sort(() => Math.random() - 0.5);
  const titles = await Promise.all(candidates.map((s) => nowPlayingTitle(s.url_resolved, 4000)));
  const withTitle = candidates.findIndex((_, i) => titles[i]);
  const pick = withTitle >= 0 ? withTitle : 0;
  station = candidates[pick];
  recentSongs = [];
  nowPlaying = "";
  console.log(`📻 ${describeStation(station)}`);
  broadcast(stationEvent());
  setNowPlaying(titles[pick] || "");
  nowPlayingAt = Date.now();
  return true;
}

// One talk: ONE model request + ONE TTS request, then wait for the page to finish playing it.
async function talk(cueText) {
  busy = true;
  broadcast({ type: "thinking" });
  try {
    const reply = await lyra.cue(cueText);
    const { spoken, station: wanted } = splitStationTag(reply); // strips every [[...]] tag from what she says
    if (/\[\[\s*quiet\s*\]\]/i.test(reply) && !spoken) { // her choice: let the music play
      console.log("[Lyra chose to stay quiet]");
      broadcast({ type: "idle" });
      return;
    }
    // Lyra's own choice to bring someone on for the podcast: [[podcast: Juno]]
    const invite = reply.match(/\[\[\s*podcast\s*:\s*([A-Za-z]+)\s*\]\]/i);
    const invited = invite && availableGuests().find((n) => n.toLowerCase() === invite[1].toLowerCase());
    const id = crypto.randomUUID();
    const file = path.join(AUDIO_DIR, `${id}.mp3`);
    await synthesize(spoken, file);
    console.log(`Lyra: ${spoken}`);

    const done = new Promise((resolve) => {
      finishSpeaking = resolve;
      setTimeout(resolve, 90_000); // never get stuck if no page reports back
    });
    broadcast({ type: "say", who: "Lyra", text: spoken, audio: `/audio/${id}.mp3` });
    await done;
    setTimeout(() => fs.rmSync(file, { force: true }), 60_000);

    if (invited) setMode("podcast", { by: "Lyra", guest: invited }); // starts once this talk has finished
    else if (wanted) await tuneTo(wanted);
  } catch (err) {
    console.error(`[talk skipped] ${err.status ? `${err.status} ` : ""}${err.message}`);
    broadcast({ type: "idle" });
  } finally {
    finishSpeaking = null;
    lastTalk = Date.now();
    busy = false;
  }
}

async function stationInfo() {
  if (!station) return "No station is playing.";
  if (Date.now() - nowPlayingAt > 15_000) { // refresh if our info is old
    setNowPlaying(await nowPlayingTitle(station.url_resolved));
    nowPlayingAt = Date.now();
  }
  const song = nowPlaying
    ? ` The song playing right now is "${nowPlaying}" (that's what the station broadcasts, usually "Artist - Title").`
    : " This station doesn't say which song is playing, so don't name one.";
  const before = recentSongs.length ? ` Earlier: ${recentSongs.map((s) => `"${s}"`).join(", ")}.` : "";
  return `You're tuned to ${describeStation(station)}.${song}${before}`;
}

// Follow the music: check the song every 20 s. When a new one starts and Lyra's been quiet a while,
// she gets a turn: say something about it, or choose to stay quiet.
const SONG_TALK_GAP_MIN = 4;
setInterval(async () => {
  if (!live || mode !== "radio" || !station) return;
  const changed = setNowPlaying(await nowPlayingTitle(station.url_resolved));
  nowPlayingAt = Date.now();
  if (!changed || busy || (Date.now() - lastTalk) / 60_000 < SONG_TALK_GAP_MIN) return;
  busy = true;
  await talk(`A new song just started. ${await stationInfo()} ` +
    `You can say something short about it (the artist, the sound, what it makes you think of, a real fact you know), ` +
    `or if you'd rather let the music speak, reply with only [[quiet]].`);
}, 20_000);

// ---------- Podcast ----------

// ONE TTS request for one line, in that host's voice. Returns the file, or null if it failed.
async function voiceLine(line) {
  const file = path.join(AUDIO_DIR, `${crypto.randomUUID()}.mp3`);
  try {
    await synthesize(line.text, file, line.who === "Lyra" ? VOICE_ID : voiceOf(line.who), PODCAST_SPEED);
    return file;
  } catch (err) {
    console.error(`[line skipped] ${line.who}: ${err.message}`);
    return null;
  }
}

async function playLine(line, file) {
  console.log(`${line.who}: ${line.text}`);
  const done = new Promise((resolve) => {
    finishSpeaking = resolve;
    setTimeout(resolve, 60_000);
  });
  broadcast({ type: "say", who: line.who, text: line.text, audio: `/audio/${path.basename(file)}` });
  await done;
  finishSpeaking = null;
  setTimeout(() => fs.rmSync(file, { force: true }), 60_000);
}

function podcastCue({ topic, seg, first, joining, who }) {
  const only = ` Only LYRA and ${who.toUpperCase()} speak.`;
  if (first) return `Open the show "${PODCAST_NAME}". Lyra welcomes everyone and introduces today's first guest, ${who}. They start on: ${topic}.${only}`;
  if (seg === 0 && joining) return `${who} joins Lyra in the studio for a new topic: ${topic}. Lyra welcomes them in.${only}`;
  if (seg === 0) return `New topic with ${who}: ${topic}.${only}`;
  if (seg === SEGMENTS_PER_TOPIC - 1)
    return `Keep going on "${topic}" and wrap the topic up in this segment. Then Lyra chooses what happens next: ` +
      `the next guest from ${availableGuests().join(", ")}, or RADIO if she'd rather play some music for a while.${only}`;
  return `Keep the conversation about "${topic}" going somewhere new.${only}`;
}

// A viewer wrote in mid-conversation: Lyra cuts in, answers, and they pick the thread back up.
function interruptCue({ who, topic, messages, lastSaid }) {
  const msgs = messages.map((m) => `${m.from}: ${m.text}`).join("\n");
  return `Viewer messages just came in while they were talking about "${topic}":\n${msgs}\n` +
    `The last thing said out loud was ${lastSaid.who.toUpperCase()}: "${lastSaid.text}". Anything written after that was never said. ` +
    `Lyra cuts in naturally and politely (like "sorry, hold that thought"), reads the message out by name and answers it, and ${who} can react. ` +
    `Then they pick the conversation back up right where it stopped and carry on. 5 to 7 lines. Only LYRA and ${who.toUpperCase()} speak.`;
}

// Change between radio and podcast. Used by the page's buttons AND by Lyra's own choices.
function setMode(m, { by = "button", guest: startGuest } = {}) {
  if (m === mode) return;
  mode = m;
  console.log(`[mode] ${mode} (chosen by ${by})`);
  broadcast({ type: "mode", mode });
  if (!live) return;
  if (mode === "podcast") runPodcast(startGuest);
  else {
    lastTalk = Date.now(); // let the music play before she talks again
    if (!station) tuneTo(START_STATION);
  }
}

async function runPodcast(startGuest) {
  if (podcastRunning) return;
  podcastRunning = true;
  while (busy) await sleep(300); // let a radio talk finish first
  busy = true;
  const cast = availableGuests();
  const castAndRadio = () => [...availableGuests(), "Radio"];
  let topic = nextTopic(), seg = 0, first = true, joining = false;
  let writing = cast.includes(startGuest) ? startGuest : cast.includes("Nova") ? "Nova" : cast[0]; // guest being written for
  let radioNext = false; // Lyra chose to go back to the radio after this topic
  let failed = false;

  // ONE model request. extra rides along with the result.
  const ask = (cue, who, extra) => {
    const p = podcast.segment(cue, who, castAndRadio()).then((r) => ({ ...r, who, ...extra }));
    p.catch(() => {}); // if we stop before using it, a failure must not crash the server
    return p;
  };
  const nextSegment = () => {
    const before = { topic, seg, first, joining };
    const p = ask(podcastCue({ topic, seg, first, joining, who: writing }), writing, { wrap: seg === SEGMENTS_PER_TOPIC - 1, topic });
    p.undo = () => ({ topic, seg, first, joining } = before); // used if this segment gets thrown away
    seg++; first = false; joining = false; // move the topic on for the segment after this one
    if (seg >= SEGMENTS_PER_TOPIC) { seg = 0; topic = nextTopic(); }
    return p;
  };

  try {
    broadcast({ type: "thinking" });
    let pending = nextSegment();
    while (live && mode === "podcast") {
      const res = await pending;
      pending = null;
      const { lines, nextGuest, who, wrap } = res;
      if (!lines.length) throw new Error("the model returned no dialogue lines");
      if (who !== guest) { guest = who; broadcast({ type: "guest", ...guestCard(guest) }); }
      if (wrap) { // Lyra chose what comes next: a guest, or the radio
        if (nextGuest === "Radio") radioNext = true;
        else {
          const others = availableGuests().filter((n) => n !== who);
          writing = nextGuest && nextGuest !== who && others.includes(nextGuest)
            ? nextGuest : others[Math.floor(Math.random() * others.length)] || who;
          joining = writing !== who;
        }
        console.log(`[podcast] Lyra chose: ${radioNext ? "the radio" : writing}${nextGuest ? "" : " (picked for her)"}`);
      }

      // Play the lines. Voice the next line while this one plays; write ahead near the end so there's no gap.
      let said = 0;
      let nextAudio = voiceLine(lines[0]);
      for (let i = 0; i < lines.length; i++) {
        const file = await nextAudio;
        if (i + 1 < lines.length) nextAudio = voiceLine(lines[i + 1]);
        if (!pending && !radioNext && !inbox.length && i >= lines.length - 2) pending = nextSegment();
        if (file) {
          if (i > 0) await sleep(PAUSE_MS[0] + Math.random() * (PAUSE_MS[1] - PAUSE_MS[0])); // a breath between turns
          await playLine(lines[i], file);
        }
        said = i + 1;
        if (!live || mode !== "podcast") break;
        if (inbox.length) break; // a viewer wrote in: Lyra cuts in after this line
      }
      if (!live || mode !== "podcast") break;

      if (inbox.length) {
        res.keep?.(said); // only what was actually said stays in the show's memory
        if (pending) { // written before the interruption: throw it away and rewind the topic
          const old = await pending.catch(() => null);
          old?.forget?.();
          pending.undo();
          pending = null;
        }
        const messages = inbox.splice(0, MAX_MESSAGES_PER_TALK);
        console.log(`[podcast] Lyra interrupts for ${messages.map((m) => m.from).join(", ")}`);
        broadcast({ type: "thinking" });
        pending = ask(interruptCue({ who, topic: res.topic, messages, lastSaid: lines[said - 1] || lines[0] }), who, { topic: res.topic });
        continue;
      }

      if (radioNext) { setMode("radio", { by: "Lyra" }); break; }
      if (!pending) pending = nextSegment();
    }
  } catch (err) {
    failed = true;
    console.error(`[podcast stopped] ${err.status ? `${err.status} ` : ""}${err.message}`);
    broadcast({ type: "idle" });
  } finally {
    podcastRunning = false;
    lastTalk = Date.now();
    busy = false;
    // switched away and straight back while we were finishing: start again (but never loop on errors)
    if (!failed && live && mode === "podcast") setTimeout(() => runPodcast(), 0);
  }
}

async function startShow() {
  if (live) return;
  live = true;
  broadcast({ type: "live" });
  if (mode === "podcast") return runPodcast();
  busy = true; // keep the talk timer quiet while the show opens
  await tuneTo(START_STATION);
  await talk(
    `The show "${SHOW_NAME}" is starting now. People can see your hologram on screen and type to you. ` +
      `Welcome everyone and introduce the station in three or four sentences at most. ${await stationInfo()}`,
  );
}

// Every few seconds: talk if someone wrote in (after a short gap), or if it's been a while.
setInterval(async () => {
  if (!live || busy || mode !== "radio") return;
  const since = (Date.now() - lastTalk) / 1000;
  const hasMail = inbox.length > 0 && since >= MIN_GAP_SEC;
  if (!hasMail && since < TALK_EVERY_MIN * 60) return;
  busy = true; // claim the slot before the slow parts below
  const messages = inbox.splice(0, MAX_MESSAGES_PER_TALK);
  const msgs = messages.length
    ? ` Viewer messages:\n${messages.map((m) => `${m.from}: ${m.text}`).join("\n")}`
    : " Nobody has written in. Say something short over the music.";
  await talk(`Talk break. ${await stationInfo()}${msgs}`);
}, 2000);

// ---------- HTTP ----------

const TYPES = {
  ".html": "text/html; charset=utf-8", ".png": "image/png", ".jpg": "image/jpeg",
  ".js": "text/javascript", ".css": "text/css", ".mp4": "video/mp4", ".mp3": "audio/mpeg",
};

// Serve a file, with Range support (browsers need it to loop and seek video).
function serveFile(req, res, file, type) {
  const size = fs.statSync(file).size;
  const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || "");
  if (range) {
    const start = range[1] ? Number(range[1]) : 0;
    const end = range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
    res.writeHead(206, { "Content-Type": type, "Content-Range": `bytes ${start}-${end}/${size}`,
      "Accept-Ranges": "bytes", "Content-Length": end - start + 1 });
    return fs.createReadStream(file, { start, end }).pipe(res);
  }
  res.writeHead(200, { "Content-Type": type, "Content-Length": size, "Accept-Ranges": "bytes" });
  fs.createReadStream(file).pipe(res);
}

function readBody(req) {
  return new Promise((resolve) => {
    let body = "";
    req.on("data", (c) => (body += c.length + body.length < 10_000 ? c : ""));
    req.on("end", () => {
      try { resolve(JSON.parse(body || "{}")); } catch { resolve({}); }
    });
  });
}

const clean = (s, max) => String(s ?? "").replace(/[\r\n]+/g, " ").trim().slice(0, max);

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const send = (code, body = "", type = "text/plain") => {
    res.writeHead(code, { "Content-Type": type });
    res.end(body);
  };

  // Live updates to the page
  if (url.pathname === "/api/events") {
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
    res.write(`data: ${JSON.stringify({ type: "hello", live, mode, show: SHOW_NAME, podcast: PODCAST_NAME, model: MODEL })}\n\n`);
    if (station) res.write(`data: ${JSON.stringify(stationEvent())}\n\n`);
    if (nowPlaying) res.write(`data: ${JSON.stringify({ type: "nowplaying", title: nowPlaying })}\n\n`);
    if (songVisual.title) res.write(`data: ${JSON.stringify(songVisual)}\n\n`);
    if (guest) res.write(`data: ${JSON.stringify({ type: "guest", ...guestCard(guest) })}\n\n`);
    clients.add(res);
    req.on("close", () => clients.delete(res));
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/start") {
    startShow();
    return send(204);
  }

  // Switch between the radio show and the podcast.
  if (req.method === "POST" && url.pathname === "/api/mode") {
    const { mode: wanted } = await readBody(req);
    if (["radio", "podcast"].includes(wanted)) setMode(wanted, { by: "button" });
    return send(204);
  }

  if (req.method === "POST" && url.pathname === "/api/chat") {
    const { from, text } = await readBody(req);
    const msg = { from: clean(from, 30) || "viewer", text: clean(text, 300) };
    if (!msg.text) return send(400, "empty message");
    inbox.push(msg);
    broadcast({ type: "chat", ...msg });
    return send(204);
  }

  if (req.method === "POST" && url.pathname === "/api/spoken") {
    finishSpeaking?.();
    return send(204);
  }

  // The page couldn't play the station: find another one of the same style.
  if (req.method === "POST" && url.pathname === "/api/station-failed") {
    if (station) await tuneTo(station.tags.split(",")[0] || START_STATION);
    return send(204);
  }

  if (req.method === "POST" && url.pathname === "/api/station") {
    const { words } = await readBody(req);
    if (clean(words, 40)) await tuneTo(clean(words, 40));
    return send(204);
  }

  // Lyra's generated speech
  const audio = url.pathname.match(/^\/audio\/([\w-]+\.mp3)$/);
  if (audio) {
    const file = path.join(AUDIO_DIR, audio[1]);
    if (!fs.existsSync(file)) return send(404);
    res.writeHead(200, { "Content-Type": "audio/mpeg" });
    return fs.createReadStream(file).pipe(res);
  }

  // Static files from public/ (and public/clips/). Anything outside public/ is refused.
  const rel = url.pathname === "/" ? "index.html" : decodeURIComponent(url.pathname).replace(/^\/+/, "");
  const file = path.resolve(PUBLIC_DIR, rel);
  const type = TYPES[path.extname(file).toLowerCase()];
  if (type && file.startsWith(PUBLIC_DIR + path.sep) && fs.existsSync(file) && fs.statSync(file).isFile()) {
    return serveFile(req, res, file, type);
  }
  send(404, "not found");
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`Lyra hologram: http://localhost:${PORT}  (press "Go live" on the page)`);
});
