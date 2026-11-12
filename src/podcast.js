// The podcast: Lyra and Nova talk about a topic.
// Each segment = ONE model request that writes 6-8 lines for both hosts.
// The server then voices each line with ONE TTS request (Lyra's or Nova's voice).

import OpenAI from "openai";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildSystemPrompt, MODEL } from "./lyra.js";

const here = path.dirname(fileURLToPath(import.meta.url));
export const PODCAST_NAME = process.env.PODCAST_NAME || "Feelings Have Data";

// Topics the hosts pick from when no viewer has suggested one.
// Mostly real-world subjects; a few personal ones for flavour.
export const TOPICS = [
  // science and nature
  "why we dream, and what scientists think dreams are for",
  "octopuses, and how strange and clever they are",
  "how the brain decides what to remember and what to forget",
  "the deep ocean, and how little of it humans have explored",
  "why music gives people chills",
  "how animals find their way home over huge distances",
  "the night sky: stars, satellites, and what the light really is",
  "why humans love spicy food when it literally hurts",
  "deserts: how life survives where there's almost no water",
  "how much of who we are comes from genes versus how we're raised",
  // people and the world
  "why people cry at movies they've seen ten times",
  "first impressions, and whether science says they're ever right",
  "the difference between being alone and being lonely",
  "why humans talk to things that can't answer, like plants, cars and pets",
  "how different countries eat breakfast",
  "superstitions people still follow, and where they came from",
  "why some cities feel friendly and others don't",
  "small kindnesses strangers do that nobody sees",
  "what makes a place feel like home",
  "nostalgia: why old songs and smells hit so hard",
  // technology and making things
  "fixing things versus replacing them, and the right-to-repair idea",
  "how the internet actually physically works: cables under the ocean",
  "what artificial intelligence really is, and what people get wrong about it",
  "inventions that happened by accident",
  "why old phones and cars felt built to last",
  // history and culture
  "lost ancient wonders, and how we know they existed",
  "how people kept in touch before phones",
  "the history of coffee and how it took over the world",
];

export function buildPodcastPrompt() {
  const rules = fs.readFileSync(path.join(here, "..", "lyra", "podcast.md"), "utf8").replaceAll("{SHOW}", PODCAST_NAME);
  return `${rules.trim()}\n\n---\n\n${buildSystemPrompt()}`;
}

const title = (s) => s[0].toUpperCase() + s.slice(1).toLowerCase();

// "LYRA: hi" / "JUNO: hi" lines -> { lines: [{ who, text }], nextGuest }
// Only Lyra and this segment's guest may speak; any other name is dropped.
export function parseScript(raw, guest, castNames) {
  const lines = [];
  const remember = [];
  let nextGuest = null;
  for (const line of raw.split(/\r?\n/)) {
    const mem = line.match(/^\s*\**\s*REMEMBER\s*\**\s*:\s*([^|]+?)\s*\|\s*(.+)$/i);
    if (mem) {
      remember.push({ name: mem[1], fact: mem[2] });
      continue;
    }
    const next = line.match(/^\s*\**\s*NEXT GUEST\s*\**\s*:\s*\**\s*([A-Za-z]+)/i);
    if (next) {
      // a guest's name, or RADIO when Lyra decides it's time for music
      if (castNames.includes(title(next[1])) || title(next[1]) === "Radio") nextGuest = title(next[1]);
      continue;
    }
    const m = line.match(/^\s*\**\s*([A-Za-z]+)\s*\**\s*:\s*(.+)$/);
    if (!m || ![ "Lyra", guest ].includes(title(m[1]))) continue;
    const text = m[2].replace(/\*|\[[^\]]*\]|\([^)]*\)/g, "").replace(/\s+/g, " ").trim();
    if (text) lines.push({ who: title(m[1]), text });
  }
  return { lines: lines.slice(0, 10), nextGuest, remember };
}

export function createPodcast() {
  const client = new OpenAI({
    apiKey: process.env.NVIDIA_API_KEY,
    baseURL: "https://integrate.api.nvidia.com/v1",
    maxRetries: 0, // one request per call
  });
  const system = { role: "system", content: buildPodcastPrompt() };
  const history = [];

  // ONE model request -> the next 6-8 lines of the show, spoken by Lyra and `guest`.
  async function segment(cue, guest, castNames) {
    const user = { role: "user", content: `[show cue] ${cue}` };
    const res = await client.chat.completions.create({
      model: MODEL,
      max_tokens: 900,
      temperature: 0.9,
      chat_template_kwargs: { enable_thinking: false },
      messages: [system, ...history.slice(-12), user],
    });
    const raw = res.choices[0]?.message?.content || "";
    const assistant = { role: "assistant", content: raw };
    history.push(user, assistant);
    const parsed = parseScript(raw, guest, castNames);
    return {
      ...parsed,
      // Only the first n lines were said aloud (someone interrupted): remember just those.
      keep(n) {
        assistant.content = parsed.lines.slice(0, n).map((l) => `${l.who.toUpperCase()}: ${l.text}`).join("\n");
      },
      // Written but never used: forget it entirely.
      forget() {
        const i = history.indexOf(user);
        if (i >= 0) history.splice(i, 2);
      },
    };
  }

  return { segment };
}
