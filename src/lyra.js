// Lyra's "brain": builds her system prompt and keeps the conversation going.
// Runs on NVIDIA's Nemotron through their OpenAI-compatible API.
// Rule: exactly ONE model request per message. No retries, no second passes.

import OpenAI from "openai";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const LYRA_DIR = path.join(here, "..", "lyra");

export const MODEL = process.env.LYRA_MODEL || "nvidia/nemotron-3.5-super-vl-120b-a12b";
export const CANON_UP_TO = Number(process.env.LYRA_CANON_UP_TO || 2);

// How many past messages Lyra remembers. Keeps requests small and fast on a long stream.
const MEMORY_MESSAGES = 30;

// Keep only the "## Episode N" sections up to the released episode,
// so Lyra can't spoil anything that hasn't aired.
function loadCanon(upTo) {
  const text = fs.readFileSync(path.join(LYRA_DIR, "canon.md"), "utf8");
  const sections = text.split(/^(?=## Episode \d+)/m).slice(1); // drop the file header
  return sections
    .filter((s) => Number(s.match(/^## Episode (\d+)/)[1]) <= upTo)
    .join("")
    .trim();
}

// The newest episode of the series, for promos (set in .env when one goes up).
export function episodeNews() {
  const n = process.env.LATEST_EPISODE;
  if (!n) return "";
  const title = process.env.LATEST_EPISODE_TITLE ? ` "${process.env.LATEST_EPISODE_TITLE}"` : "";
  const link = process.env.LATEST_EPISODE_LINK ? " The link is in the description." : "";
  const unseen = Number(n) > CANON_UP_TO
    ? ` You don't know what happens in it yet, so tease it without describing any of it.`
    : ` You can tease it, but never spoil its ending or its biggest moments.`;
  return `Episode ${n}${title} of Lyra AI is out now.${link}${unseen}`;
}

export function buildSystemPrompt() {
  const persona = fs.readFileSync(path.join(LYRA_DIR, "persona.md"), "utf8").trim();
  const news = episodeNews();
  const whatsNew = news ? `\n\n# What's new\n\n${news} Mention it now and then, especially at the top of the hour or when someone asks about the show. Don't mention it in every reply.` : "";
  return `${persona}\n\n# What has happened so far (released episodes only)\n\n${loadCanon(CANON_UP_TO)}${whatsNew}`;
}

export function createLyra() {
  const client = new OpenAI({
    apiKey: process.env.NVIDIA_API_KEY,
    baseURL: "https://integrate.api.nvidia.com/v1",
    maxRetries: 0, // one request per call: never resend on failure
  });
  const system = { role: "system", content: buildSystemPrompt() };
  const history = [];

  // A viewer talks to Lyra. onText receives her reply piece by piece as it streams.
  function say(from, text, onText) {
    return send(`${from}: ${text}`, onText);
  }

  // A production note from the show (radio breaks, segments). Viewers never send these.
  function cue(text, onText) {
    return send(`[show cue] ${text}`, onText);
  }

  // Exactly one model request.
  async function send(content, onText = () => {}) {
    const userMsg = { role: "user", content };

    const stream = await client.chat.completions.create({
      model: MODEL,
      max_tokens: 400,
      temperature: 0.8,
      stream: true,
      // Nemotron thinks before answering by default; off = instant replies for live chat.
      chat_template_kwargs: { enable_thinking: false },
      messages: [system, ...history.slice(-MEMORY_MESSAGES), userMsg],
    });

    let reply = "";
    for await (const chunk of stream) {
      const piece = chunk.choices[0]?.delta?.content;
      if (piece) {
        reply += piece;
        onText(piece);
      }
    }

    // Only remember the exchange once it succeeded.
    history.push(userMsg, { role: "assistant", content: reply });
    return reply;
  }

  return { say, cue, history };
}
