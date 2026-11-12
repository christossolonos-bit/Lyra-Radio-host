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
import { createLyra, MODEL, episodeNews } from "./lyra.js";
import { synthesize, VOICE_ID } from "./voice.js";
import { createPodcast, TOPICS, PODCAST_NAME } from "./podcast.js";
import { voiceOf, availableGuests, guestCard } from "./cast.js";
import { songMedia } from "./media.js";
import { connectLiveChat } from "./youtube.js";
import { connectTikTok } from "./tiktok.js";
import { loadChannelSongs } from "./channel.js";
import { noteVisit, aboutViewers, rememberFrom, saveFact } from "./memory.js";
import { createRecorder } from "./recorder.js";
import { newsBlock } from "./news.js";

// "Viewer messages: ..." plus what Lyra remembers about those people.
const viewerBlock = (messages, intro = "Viewer messages") => messages.length
  ? ` ${intro}:\n${messages.map((m) => `${m.from}: ${m.text}`).join("\n")}${aboutViewers(messages.map((m) => m.from))}\n` +
    `If someone shared something small worth remembering (where they're from, what they love, what they're doing), ` +
    `save it with [[remember: Name | short fact]] on its own line at the end.`
  : "";
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
const recorder = createRecorder(PODCAST_NAME); // each podcast topic -> recordings/*.mp3 + transcript
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
let stationSince = 0;     // when we tuned to the current station

let songVisual = { type: "songmedia", title: "" }; // video / artwork for the current song

// ---------- Music source: live radio stations, or the artist's own songs from his YouTube channel ----------
// "channel" is the YouTube-safe mode: only his own releases, so a stream can't get copyright strikes.
const MUSIC_CHANNEL = process.env.MUSIC_CHANNEL || "";
const DJ_BREAK_MIN = 3; // between his songs, Lyra does a DJ break if she's been quiet this long (or chat is waiting)
let source = process.env.RADIO_SOURCE === "channel" && MUSIC_CHANNEL ? "channel" : "stations";
let channel = null; // { name, songs }
let trackDeck = [];
let track = null;

async function loadChannel() {
  if (!channel) {
    channel = await loadChannelSongs(MUSIC_CHANNEL);
    console.log(`[music] ${channel.name}: ${channel.songs.length} songs`);
  }
  return channel;
}
function nextChannelTrack() {
  if (!trackDeck.length) trackDeck = [...channel.songs].sort(() => Math.random() - 0.5).filter((s) => s.videoId !== track?.videoId);
  return trackDeck.pop();
}
function playTrack(t) {
  track = t;
  setNowPlaying(t.title, { videoId: t.videoId, own: true });
}
const sourceEvent = () => ({ type: "source", source, channel: channel?.name || "", available: Boolean(MUSIC_CHANNEL) });

async function setSource(s, by = "button") {
  if (s === source || !["stations", "channel"].includes(s)) return;
  if (s === "channel") {
    if (!MUSIC_CHANNEL) return;
    try { await loadChannel(); } catch (err) { console.error(`[music] ${err.message}`); return; }
  }
  source = s;
  console.log(`[source] ${source} (chosen by ${by})`);
  broadcast(sourceEvent());
  if (source === "channel") return playTrack(nextChannelTrack());
  track = null;
  setNowPlaying(""); // stop his song's video
  if (station) {
    broadcast(stationEvent());
    setNowPlaying(await nowPlayingTitle(station.url_resolved));
  } else await tuneTo(START_STATION);
}

// The page says his song finished: maybe a short DJ break, then the next one.
async function channelTrackEnded(videoId, failed = false) {
  if (source !== "channel" || !track || videoId !== track.videoId) return;
  const finished = track;
  const next = nextChannelTrack();
  track = null; // so a second "ended" for the same song is ignored
  const quietFor = (Date.now() - lastTalk) / 60_000;
  if (!failed && live && mode === "radio" && !busy && (inbox.length || quietFor >= DJ_BREAK_MIN)) {
    busy = true;
    const messages = inbox.splice(0, MAX_MESSAGES_PER_TALK);
    const msgs = viewerBlock(messages);
    await talk(`DJ break between songs. "${finished.title}" by ${channel.name} just finished. Up next is "${next.title}". ` +
      `Keep it short and end by introducing the next song.${msgs}`);
  }
  playTrack(next);
}

// media: pass { videoId, own: true } for the artist's own songs (no lookup needed; the video IS the music)
function setNowPlaying(title, media) {
  if (title === nowPlaying && !media) return false;
  if (nowPlaying) recentSongs = [nowPlaying, ...recentSongs].slice(0, 4);
  nowPlaying = title;
  console.log(`♪ ${title || "(no title)"}`);
  broadcast({ type: "nowplaying", title });
  if (media) {
    songVisual = { type: "songmedia", title, ...media };
    broadcast(songVisual);
    return Boolean(title);
  }
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
  stationSince = Date.now();
  recentSongs = [];
  nowPlaying = "";
  console.log(`📻 ${describeStation(station)}`);
  broadcast(stationEvent());
  setNowPlaying(titles[pick] || "");
  nowPlayingAt = Date.now();
  return true;
}

// One talk: ONE model request + ONE TTS request, then wait for the page to finish playing it.
// How long we've been on the current station. Under 20 minutes she only switches if a viewer asked.
const stationMinutes = () => (Date.now() - stationSince) / 60_000;
const STAY_MIN = 20;

// opts.canSwitch: may she change station this time? (a viewer wrote in, or she's been on it a while)
async function talk(cueText, { canSwitch = false } = {}) {
  busy = true;
  broadcast({ type: "thinking" });
  try {
    const reply = await lyra.cue(cueText);
    rememberFrom(reply); // [[remember: Name | fact]]
    let { spoken, station: wanted } = splitStationTag(reply); // strips every [[...]] tag from what she says
    if (wanted && !canSwitch) { // too soon and nobody asked: keep the station, and drop her "I'm switching" line
      console.log(`[radio] kept the station (she wanted "${wanted}", but nobody asked and it's only been ${Math.round(stationMinutes())} min)`);
      wanted = null;
      spoken = spoken.split(/(?<=[.!?])\s+/)
        .filter((s) => !/\b(switch|switching|put(ting)? on|chang(e|ing)|tun(e|ing)|flip(ping)?)\b/i.test(s))
        .join(" ").trim() || spoken;
    }
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
    else if (source === "channel" && /\[\[\s*next song\s*\]\]/i.test(reply)) playTrack(nextChannelTrack());
    else if (wanted && source === "stations") await tuneTo(wanted); // no outside stations in YouTube-safe mode
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
  if (source === "channel") {
    const before = recentSongs.length ? ` Earlier: ${recentSongs.map((s) => `"${s}"`).join(", ")}.` : "";
    return `You're playing ${channel?.name || "the artist"}'s own songs from his YouTube music channel. ` +
      `Now playing: "${track?.title || nowPlaying}" by ${channel?.name}.${before} In this mode you only play his songs ` +
      `(it keeps the stream safe), so you can't switch to radio stations; if someone wants something else, ` +
      `you can skip to another of his songs by ending your reply with [[next song]].`;
  }
  if (!station) return "No station is playing.";
  if (Date.now() - nowPlayingAt > 15_000) { // refresh if our info is old
    setNowPlaying(await nowPlayingTitle(station.url_resolved));
    nowPlayingAt = Date.now();
  }
  const song = nowPlaying
    ? ` The song playing right now is "${nowPlaying}" (that's what the station broadcasts, usually "Artist - Title").`
    : " This station doesn't say which song is playing, so don't name one.";
  const before = recentSongs.length ? ` Earlier: ${recentSongs.map((s) => `"${s}"`).join(", ")}.` : "";
  const mins = Math.round((Date.now() - stationSince) / 60_000);
  const stay = mins < 20 ? " Stay on this station unless a viewer asks for something different." : "";
  return `You're tuned to ${describeStation(station)}, and have been for ${mins} minute${mins === 1 ? "" : "s"}.${song}${before}${stay}`;
}

// Follow the music: check the song every 20 s. When a new one starts and Lyra's been quiet a while,
// she gets a turn: say something about it, or choose to stay quiet.
const SONG_TALK_GAP_MIN = 4;
setInterval(async () => {
  if (!live || mode !== "radio" || !station || source !== "stations") return;
  const changed = setNowPlaying(await nowPlayingTitle(station.url_resolved));
  nowPlayingAt = Date.now();
  if (!changed || busy || (Date.now() - lastTalk) / 60_000 < SONG_TALK_GAP_MIN) return;
  busy = true;
  await talk(`A new song just started. ${await stationInfo()} ` +
    `You can say something short about it (the artist, the sound, what it makes you think of, a real fact you know), ` +
    `or if you'd rather let the music speak, reply with only [[quiet]].`, { canSwitch: stationMinutes() >= STAY_MIN });
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
  return `${viewerBlock(messages, `Viewer messages just came in while they were talking about "${topic}"`).trim()}\n` +
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
    if (source === "channel" && channel) playTrack(track || nextChannelTrack());
    else if (!station) tuneTo(START_STATION);
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
      for (const r of res.remember || []) saveFact(r.name, r.fact);
      if (!lines.length) throw new Error("the model returned no dialogue lines");
      if (who !== guest) { guest = who; broadcast({ type: "guest", ...guestCard(guest) }); }
      if (res.topic && res.topic !== recorder.topic()) recorder.start(res.topic, who); // a new topic = a new episode file
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
          const pause = i > 0 ? PAUSE_MS[0] + Math.random() * (PAUSE_MS[1] - PAUSE_MS[0]) : 0;
          if (pause) await sleep(pause); // a breath between turns
          await playLine(lines[i], file);
          recorder.add(lines[i], file, pause);
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
    recorder.finish(); // save whatever topic was in progress
    podcastRunning = false;
    lastTalk = Date.now();
    busy = false;
    // switched away and straight back while we were finishing: start again (but never loop on errors)
    if (!failed && live && mode === "podcast") setTimeout(() => runPodcast(), 0);
  }
}

// ---------- Patch cameo ----------
// Every 15-30 minutes Patch wanders past camera six. The page shows the feed, and Lyra hears about it.
let patchSeenAt = 0;
function schedulePatch() {
  setTimeout(() => {
    if (live) {
      broadcast({ type: "patch" });
      patchSeenAt = Date.now();
      console.log("[patch] on camera six");
    }
    schedulePatch();
  }, (15 + Math.random() * 15) * 60_000);
}
schedulePatch();
// Added to Lyra's next radio cue (within two minutes of him showing up).
function patchNote() {
  if (!patchSeenAt || Date.now() - patchSeenAt > 2 * 60_000) return "";
  patchSeenAt = 0;
  return " (Patch just wandered across security camera six, and viewers saw it on screen. You can mention it if you like.)";
}

// ---------- Show clock ----------
// Top of every hour (radio only): a station ident, the time in Death Valley, the news, and the new episode if there is one.
let showStartedAt = 0;
let lastTopOfHour = -1;
setInterval(async () => {
  if (!live || mode !== "radio" || busy) return;
  const now = new Date();
  if (now.getMinutes() > 5 || now.getHours() === lastTopOfHour) return; // in the first five minutes of the hour
  if (Date.now() - showStartedAt < 10 * 60_000) return; // not right after the show opened
  lastTopOfHour = now.getHours();
  busy = true;
  const time = now.toLocaleTimeString("en-US", { timeZone: "America/Los_Angeles", hour: "numeric", minute: "2-digit" });
  const news = process.env.NEWS === "0" ? "" : await newsBlock().catch(() => "");
  const promo = episodeNews();
  const asks = [
    `Do a short station ident ("you're listening to Lyra Radio") and say the time`,
    news && "then a short news break from the outside world: pick three of these stories and say each in your own voice in one or two sentences",
    promo && "and briefly mention the new episode",
  ].filter(Boolean).join(", ");
  console.log("[clock] top of the hour");
  await talk(`It's the top of the hour: ${time} in Death Valley. ${await stationInfo()} ${asks}. Then back to the music.` +
    `${news ? `\n${news}` : ""}${promo ? `\n${promo}` : ""}`);
}, 30_000);

async function startShow() {
  if (live) return;
  live = true;
  showStartedAt = Date.now();
  broadcast({ type: "live" });
  if (mode === "podcast") return runPodcast();
  busy = true; // keep the talk timer quiet while the show opens
  if (source === "channel") {
    try { await loadChannel(); broadcast(sourceEvent()); playTrack(nextChannelTrack()); }
    catch (err) { console.error(`[music] ${err.message}; using stations`); source = "stations"; broadcast(sourceEvent()); }
  }
  if (source === "stations") await tuneTo(START_STATION);
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
  let msgs = viewerBlock(messages) || " Nobody has written in. Say something short over the music.";
  // someone asked about the news: give her real headlines for this answer
  if (messages.some((m) => /\bnews\b|headlines|what'?s happening/i.test(m.text))) msgs += `\n${await newsBlock().catch(() => "")}`;
  await talk(`Talk break. ${await stationInfo()}${patchNote()}${msgs}`, { canSwitch: messages.length > 0 || stationMinutes() >= STAY_MIN });
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

// Every chat message (the page's own chat, or YouTube live chat) lands here.
function addChat({ from, text, source = "page" }) {
  const msg = { from: clean(from, 30) || "viewer", text: clean(text, 300), source };
  if (!msg.text) return false;
  inbox.push(msg);
  if (!source.endsWith("-event")) noteVisit(msg.from); // gift/follow summaries aren't a person
  if (inbox.length > 30) inbox.shift(); // a flood of messages: keep the newest
  broadcast({ type: "chat", ...msg });
  return true;
}

// ---------- YouTube live chat ----------
let ytChat = null;
let ytStatus = { type: "youtube", connected: false };
async function connectYouTube(video) {
  ytChat?.stop();
  ytChat = null;
  if (!video) return;
  const status = (s) => {
    ytStatus = { type: "youtube", ...s };
    console.log(`[youtube] ${s.connected ? `reading chat: ${s.title}` : s.error ? `stopped: ${s.error}` : "disconnected"}`);
    broadcast(ytStatus);
  };
  try {
    ytChat = await connectLiveChat(video, (m) => addChat({ ...m, source: "youtube" }), status);
  } catch (err) {
    status({ connected: false, error: err.message });
  }
}
if (process.env.YOUTUBE_LIVE_ID) connectYouTube(process.env.YOUTUBE_LIVE_ID);

// ---------- TikTok LIVE chat, gifts and follows ----------
let ttConn = null;
let ttStatus = { type: "tiktok", connected: false };
let ttEvents = { gifts: [], follows: [] }; // batched so a flood of roses doesn't make her talk nonstop

// Watching: keep checking every minute until the account goes live, connect, and go back to waiting after the live ends.
const TT_RETRY_MS = 60_000;
let ttWatch = null;  // username being watched
let ttRetry = null;
let ttGen = 0;       // ignores status from connections we've already replaced

async function connectTikTokLive(username) {
  const gen = ++ttGen;
  clearTimeout(ttRetry);
  ttConn?.stop();
  ttConn = null;
  ttWatch = username || null;
  if (!username) return broadcast((ttStatus = { type: "tiktok", connected: false }));
  const status = (s) => {
    if (gen !== ttGen) return;
    const offline = /isn't live|ended|room/i.test(s.error || "") || (!s.connected && !s.error);
    if (!s.connected && offline && ttWatch) { // not live (yet / any more): wait and try again
      s = { connected: false, waiting: true, error: `waiting for @${ttWatch.replace(/^@/, "")} to go live` };
      clearTimeout(ttRetry);
      ttRetry = setTimeout(() => ttWatch && connectTikTokLive(ttWatch), TT_RETRY_MS);
    }
    if (JSON.stringify({ type: "tiktok", ...s }) === JSON.stringify(ttStatus)) return; // don't log the same wait every minute
    ttStatus = { type: "tiktok", ...s };
    console.log(`[tiktok] ${s.connected ? `reading ${s.title}` : s.error || "disconnected"}`);
    broadcast(ttStatus);
  };
  try {
    ttConn = await connectTikTok(username, {
      onChat: (m) => addChat({ ...m, source: "tiktok" }),
      onGift: (g) => ttEvents.gifts.push(g),
      onFollow: (f) => ttEvents.follows.push(f.from),
      onStatus: status,
    });
  } catch (err) {
    status({ connected: false, error: err.message });
  }
}
if (process.env.TIKTOK_USERNAME) connectTikTokLive(process.env.TIKTOK_USERNAME);

// Every 20 s, gifts and follows since last time become one note in Lyra's inbox, so she can thank people.
setInterval(() => {
  const { gifts, follows } = ttEvents;
  if (!gifts.length && !follows.length) return;
  ttEvents = { gifts: [], follows: [] };
  const parts = [];
  if (gifts.length) parts.push(`gifts: ${gifts.slice(0, 8).map((g) => `${g.from} sent ${g.count > 1 ? `${g.count}× ` : ""}${g.gift}`).join(", ")}${gifts.length > 8 ? ` and ${gifts.length - 8} more` : ""}`);
  if (follows.length) parts.push(`new followers: ${[...new Set(follows)].slice(0, 8).join(", ")}${follows.length > 8 ? ` and ${follows.length - 8} more` : ""}`);
  addChat({ from: "TikTok", text: `(${parts.join("; ")})`, source: "tiktok-event" });
}, 20_000);

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const send = (code, body = "", type = "text/plain") => {
    res.writeHead(code, { "Content-Type": type });
    res.end(body);
  };

  // Live updates to the page
  if (url.pathname === "/api/events") {
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
    res.write(`data: ${JSON.stringify({ type: "hello", live, mode, show: SHOW_NAME, podcast: PODCAST_NAME, model: MODEL,
      tiktokUser: ttWatch || process.env.TIKTOK_USERNAME || "",
      episode: process.env.LATEST_EPISODE || "", episodeTitle: process.env.LATEST_EPISODE_TITLE || "" })}\n\n`);
    if (station) res.write(`data: ${JSON.stringify(stationEvent())}\n\n`);
    if (nowPlaying) res.write(`data: ${JSON.stringify({ type: "nowplaying", title: nowPlaying })}\n\n`);
    if (songVisual.title) res.write(`data: ${JSON.stringify(songVisual)}\n\n`);
    res.write(`data: ${JSON.stringify(ytStatus)}\n\n`);
    res.write(`data: ${JSON.stringify(ttStatus)}\n\n`);
    res.write(`data: ${JSON.stringify(sourceEvent())}\n\n`);
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
    return addChat({ from, text }) ? send(204) : send(400, "empty message");
  }

  // Show Patch on camera six now (the P key on the page).
  if (req.method === "POST" && url.pathname === "/api/patch") {
    broadcast({ type: "patch" });
    patchSeenAt = Date.now();
    return send(204);
  }

  // Music source: "stations" (live radio) or "channel" (the artist's own songs; YouTube-safe).
  if (req.method === "POST" && url.pathname === "/api/source") {
    const { source: wanted } = await readBody(req);
    await setSource(wanted, "button");
    return send(204);
  }
  // The page finished (or couldn't play) one of his songs.
  if (req.method === "POST" && (url.pathname === "/api/track-ended" || url.pathname === "/api/track-error")) {
    const { videoId } = await readBody(req);
    channelTrackEnded(String(videoId || ""), url.pathname.endsWith("error"));
    return send(204);
  }

  // Connect to a TikTok LIVE (a username; empty = disconnect).
  if (req.method === "POST" && url.pathname === "/api/tiktok") {
    const { username } = await readBody(req);
    await connectTikTokLive(clean(username, 100));
    return send(204);
  }

  // Connect to a YouTube live stream's chat (a video id or link; empty = disconnect).
  if (req.method === "POST" && url.pathname === "/api/youtube") {
    const { video } = await readBody(req);
    await connectYouTube(clean(video, 200));
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
