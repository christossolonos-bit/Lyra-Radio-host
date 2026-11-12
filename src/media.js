// Visuals for the song that's playing: a music video (YouTube, needs YOUTUBE_API_KEY) and album artwork (iTunes, free).
// The video is shown MUTED behind Lyra; the radio station is still the sound.

const cache = new Map(); // title -> { videoId, art }

// "Artist - Title (Radio Edit) [Label]" -> "Artist Title", which searches better
function searchText(title) {
  return title
    .replace(/\s+(-|–|by)\s+.*\bon\s+\S+\.(com|net|org|fm)\b.*$/i, "") // "... on walmradio.com"
    .replace(/\([^)]*\)|\[[^\]]*\]/g, "")
    .replace(/[-–]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

async function youtubeVideo(q) {
  const key = process.env.YOUTUBE_API_KEY;
  if (!key) return null;
  const url = "https://www.googleapis.com/youtube/v3/search?" + new URLSearchParams({
    part: "snippet", type: "video", videoEmbeddable: "true", maxResults: "1", q: `${q} official video`, key,
  });
  const res = await fetch(url, { signal: AbortSignal.timeout(6000) });
  if (!res.ok) {
    console.error(`[media] YouTube search ${res.status}`);
    return null;
  }
  return (await res.json()).items?.[0]?.id?.videoId || null;
}

async function itunesArt(q) {
  const url = "https://itunes.apple.com/search?" + new URLSearchParams({ term: q, entity: "song", limit: "1" });
  const res = await fetch(url, { signal: AbortSignal.timeout(6000) });
  if (!res.ok) return null;
  const hit = (await res.json()).results?.[0];
  return hit?.artworkUrl100 ? hit.artworkUrl100.replace("100x100bb", "1000x1000bb") : null;
}

export async function songMedia(title) {
  if (!title) return {};
  if (cache.has(title)) return cache.get(title);
  const q = searchText(title);
  const [videoId, art] = await Promise.all([
    youtubeVideo(q).catch(() => null),
    itunesArt(q).catch(() => null),
  ]);
  const media = { videoId, art };
  cache.set(title, media);
  if (cache.size > 200) cache.delete(cache.keys().next().value);
  return media;
}
