// "My music": the songs on a YouTube channel, played as the radio's music.
// Safe for streaming on YouTube because they're the artist's own releases.
// Works with auto-generated "Artist - Topic" music channels (whose songs only show up through search).
// Quota: about 100 units per 50 songs to find them, so the list is cached on disk for a day.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const API = "https://www.googleapis.com/youtube/v3";
const here = path.dirname(fileURLToPath(import.meta.url));
const CACHE_DIR = path.join(here, "..", "data");
const CACHE_HOURS = 24;

async function get(p, params) {
  const url = `${API}/${p}?${new URLSearchParams({ ...params, key: process.env.YOUTUBE_API_KEY })}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error?.message || `YouTube ${res.status}`);
  return body;
}

// "PT3M25S" -> 205
function seconds(iso) {
  const m = String(iso).match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/) || [];
  return (+m[1] || 0) * 3600 + (+m[2] || 0) * 60 + (+m[3] || 0);
}

const decode = (s) => s.replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">");

// Channel link (/channel/UC..., /@handle) or id -> { name, songs: [{ videoId, title, seconds }] }
export async function loadChannelSongs(input) {
  if (!process.env.YOUTUBE_API_KEY) throw new Error("YOUTUBE_API_KEY is not set in .env");
  const s = String(input || "").trim();
  const handle = s.match(/@([A-Za-z0-9._-]+)/)?.[1];
  const ch = await get("channels", { part: "snippet", ...(s.match(/UC[A-Za-z0-9_-]{22}/) ? { id: s.match(/UC[A-Za-z0-9_-]{22}/)[0] } : { forHandle: handle || s }) });
  const channel = ch.items?.[0];
  if (!channel) throw new Error("Channel not found");

  const cacheFile = path.join(CACHE_DIR, `channel_${channel.id}.json`);
  try {
    const cached = JSON.parse(fs.readFileSync(cacheFile, "utf8"));
    if (Date.now() - cached.savedAt < CACHE_HOURS * 3600_000 && cached.songs.length) return cached;
  } catch {}

  // every video on the channel, newest first
  const ids = [];
  let pageToken;
  do {
    const page = await get("search", { part: "id", channelId: channel.id, type: "video", order: "date", maxResults: "50", ...(pageToken ? { pageToken } : {}) });
    ids.push(...page.items.map((i) => i.id.videoId));
    pageToken = page.nextPageToken;
  } while (pageToken && ids.length < 300);

  const songs = [];
  for (let i = 0; i < ids.length; i += 50) {
    const vids = await get("videos", { part: "snippet,contentDetails,status", id: ids.slice(i, i + 50).join(",") });
    for (const v of vids.items) {
      const secs = seconds(v.contentDetails.duration);
      // songs only: skip clips under a minute, very long videos, live streams and ones that can't be embedded
      if (secs < 60 || secs > 900 || !v.status.embeddable || v.snippet.liveBroadcastContent !== "none") continue;
      songs.push({ videoId: v.id, title: decode(v.snippet.title), seconds: secs });
    }
  }
  const result = { name: channel.snippet.title.replace(/\s*-\s*Topic$/, ""), songs, savedAt: Date.now() };
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  fs.writeFileSync(cacheFile, JSON.stringify(result, null, 1));
  return result;
}
