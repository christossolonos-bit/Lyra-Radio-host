// Read a YouTube live stream's chat so viewers there can talk to Lyra. She answers out loud on the stream.
// Uses YOUTUBE_API_KEY (read-only, no sign-in needed). Quota: 1 unit to connect, 5 units per chat poll.
// Polling every 15 s costs about 1,200 units an hour of the 10,000 free daily units.

const API = "https://www.googleapis.com/youtube/v3";
const MIN_POLL_MS = Number(process.env.YOUTUBE_CHAT_POLL_SEC || 15) * 1000;

// Accepts a video id or any YouTube URL (watch?v=, youtu.be/, /live/).
export function videoIdFrom(input) {
  const s = String(input || "").trim();
  const m = s.match(/(?:v=|youtu\.be\/|\/live\/|\/shorts\/)([A-Za-z0-9_-]{11})/) || s.match(/^([A-Za-z0-9_-]{11})$/);
  return m ? m[1] : null;
}

async function get(path, params) {
  const url = `${API}/${path}?${new URLSearchParams({ ...params, key: process.env.YOUTUBE_API_KEY })}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error?.message || `YouTube ${res.status}`);
  return body;
}

// Start reading chat. onMessage({ from, text }) for every new message. Returns { stop }.
export async function connectLiveChat(input, onMessage, onStatus = () => {}) {
  if (!process.env.YOUTUBE_API_KEY) throw new Error("YOUTUBE_API_KEY is not set in .env");
  const videoId = videoIdFrom(input);
  if (!videoId) throw new Error("That doesn't look like a YouTube video id or link");

  const video = await get("videos", { part: "liveStreamingDetails,snippet", id: videoId });
  const item = video.items?.[0];
  const chatId = item?.liveStreamingDetails?.activeLiveChatId;
  if (!chatId) throw new Error("That video has no active live chat (is the stream live?)");

  let stopped = false;
  let pageToken = null;
  let first = true; // skip messages from before Lyra connected
  onStatus({ connected: true, title: item.snippet?.title || videoId, videoId });

  (async function poll() {
    while (!stopped) {
      let wait = MIN_POLL_MS;
      try {
        const page = await get("liveChat/messages", {
          liveChatId: chatId, part: "snippet,authorDetails", maxResults: "200", ...(pageToken ? { pageToken } : {}),
        });
        pageToken = page.nextPageToken;
        wait = Math.max(MIN_POLL_MS, page.pollingIntervalMillis || 0);
        if (!first) {
          for (const m of page.items || []) {
            const text = m.snippet?.displayMessage;
            if (m.snippet?.type === "textMessageEvent" && text) onMessage({ from: m.authorDetails?.displayName || "viewer", text });
          }
        }
        first = false;
      } catch (err) {
        onStatus({ connected: false, error: err.message });
        if (/ended|not found|disabled|forbidden|quota/i.test(err.message)) return; // stream over or out of quota
        wait = 60_000;
      }
      await new Promise((r) => setTimeout(r, wait));
    }
  })();

  return { stop: () => { stopped = true; onStatus({ connected: false }); } };
}
