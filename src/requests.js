// Song requests: find a viewer's song on YouTube so it can play on the site through YouTube's embedded player.
// Music only, SafeSearch strict, embeddable videos only. Quota: about 101 units per search (of 10,000 a day).

const API = "https://www.googleapis.com/youtube/v3";

async function get(p, params) {
  const url = `${API}/${p}?${new URLSearchParams({ ...params, key: process.env.YOUTUBE_API_KEY })}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error?.message || `YouTube ${res.status}`);
  return body;
}

const seconds = (iso) => {
  const m = String(iso).match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/) || [];
  return (+m[1] || 0) * 3600 + (+m[2] || 0) * 60 + (+m[3] || 0);
};
const decode = (s) => s.replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&");

// "Queen Bohemian Rhapsody" -> { videoId, title, channel, seconds } or null
export async function findSong(words) {
  if (!process.env.YOUTUBE_API_KEY) throw new Error("YOUTUBE_API_KEY is not set");
  const search = await get("search", {
    part: "snippet", type: "video", videoCategoryId: "10", videoEmbeddable: "true", safeSearch: "strict",
    maxResults: "5", q: words,
  });
  const ids = (search.items || []).map((i) => i.id.videoId).filter(Boolean);
  if (!ids.length) return null;
  const vids = await get("videos", { part: "snippet,contentDetails,status", id: ids.join(",") });
  // the first result that's an actual song length, embeddable and not a live stream
  for (const id of ids) {
    const v = vids.items.find((x) => x.id === id);
    const secs = v && seconds(v.contentDetails.duration);
    if (!v || !v.status.embeddable || v.snippet.liveBroadcastContent !== "none" || secs < 60 || secs > 600) continue;
    return { videoId: v.id, title: decode(v.snippet.title), channel: decode(v.snippet.channelTitle), seconds: secs };
  }
  return null;
}
