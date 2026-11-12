// Real headlines for Lyra's news breaks, from BBC News RSS feeds (free, no key). Cached for 10 minutes.

const FEEDS = (process.env.NEWS_FEEDS || [
  "https://feeds.bbci.co.uk/news/world/rss.xml",
  "https://feeds.bbci.co.uk/news/science_and_environment/rss.xml",
  "https://feeds.bbci.co.uk/news/technology/rss.xml",
].join(",")).split(",").map((s) => s.trim()).filter(Boolean);
const NEWS_SOURCE = process.env.NEWS_SOURCE_NAME || "BBC News";

let cache = { at: 0, items: [] };

const text = (xml, tag) => {
  const m = xml.match(new RegExp(`<${tag}>\\s*(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?\\s*</${tag}>`));
  return m ? m[1].replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"').trim() : "";
};

async function readFeed(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(8000), headers: { "User-Agent": "lyra-live/0.1" } });
  if (!res.ok) return [];
  const xml = await res.text();
  return [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].map(([, item]) => ({
    title: text(item, "title"),
    summary: text(item, "description"),
    date: new Date(text(item, "pubDate") || 0).getTime(),
  })).filter((i) => i.title);
}

// The freshest headlines, mixed across the feeds (world, science, tech), newest first.
export async function headlines(count = 5) {
  if (Date.now() - cache.at > 10 * 60_000) {
    const lists = await Promise.all(FEEDS.map((f) => readFeed(f).catch(() => [])));
    const dayAgo = Date.now() - 24 * 3600_000;
    // take the top stories from each feed in turn, so it isn't all one kind of news
    const mixed = [];
    for (let i = 0; i < 6; i++) for (const list of lists) if (list[i] && list[i].date > dayAgo) mixed.push(list[i]);
    const seen = new Set();
    cache = { at: Date.now(), items: mixed.filter((i) => !seen.has(i.title) && seen.add(i.title)) };
  }
  return cache.items.slice(0, count);
}

// The headlines, written for Lyra's cue.
export async function newsBlock(count = 5) {
  const items = await headlines(count);
  if (!items.length) return "";
  return `Latest headlines from ${NEWS_SOURCE}, fetched just now:\n` +
    items.map((i) => `- ${i.title}${i.summary ? `: ${i.summary}` : ""}`).join("\n") +
    `\nWhen you talk about the news, use only what these headlines and summaries say, mention it's from ${NEWS_SOURCE}, ` +
    `be gentle with sad news, and never take sides on politics.`;
}
