// Read a TikTok LIVE's chat, gifts and follows so Lyra can answer and thank people.
// TikTok has no official API for this; it uses the open-source tiktok-live-connector library
// (unofficial, so it can break when TikTok changes things). No login needed: just the username of an account that's live.
// Optional: TIKTOK_SIGN_API_KEY (a free Euler Stream key) makes connecting more reliable.

import { TikTokLiveConnection, WebcastEvent, ControlEvent } from "tiktok-live-connector";

export async function connectTikTok(username, { onChat, onGift, onFollow, onStatus }) {
  const user = String(username || "").trim().replace(/^@/, "").replace(/^https?:\/\/(www\.)?tiktok\.com\/@/, "").split(/[/?]/)[0];
  if (!user) throw new Error("Enter a TikTok username");

  const conn = new TikTokLiveConnection(user, {
    enableExtendedGiftInfo: true, // gift names
    processInitialData: false,    // skip chat from before Lyra connected
    ...(process.env.TIKTOK_SIGN_API_KEY ? { signApiKey: process.env.TIKTOK_SIGN_API_KEY } : {}),
  });
  const nameOf = (d) => d.user?.nickname || d.user?.uniqueId || "viewer";

  conn.on(WebcastEvent.CHAT, (d) => d.comment && onChat({ from: nameOf(d), text: d.comment }));
  conn.on(WebcastEvent.GIFT, (d) => {
    // streak gifts fire on every tap; count them once, when the streak ends
    if (d.giftDetails?.giftType === 1 && !d.repeatEnd) return;
    onGift({ from: nameOf(d), gift: d.giftDetails?.giftName || d.extendedGiftInfo?.name || "a gift", count: d.repeatCount || 1 });
  });
  conn.on(WebcastEvent.FOLLOW, (d) => onFollow({ from: nameOf(d) }));
  conn.on(WebcastEvent.STREAM_END, () => onStatus({ connected: false, error: "the live ended" }));
  conn.on(ControlEvent.DISCONNECTED, () => onStatus({ connected: false }));

  try {
    await conn.connect();
  } catch (err) {
    const why = /offline/i.test(err.constructor?.name || err.message) ? `@${user} isn't live right now`
      : /sign|plan|euler/i.test(err.message) ? "TikTok's signing service needs an API key: add TIKTOK_SIGN_API_KEY to .env (eulerstream.com)"
      : /room id/i.test(err.message) ? `couldn't find @${user}'s live room (are they live?)`
      : err.message;
    throw new Error(why);
  }
  onStatus({ connected: true, title: `@${user}` });
  return { stop: () => conn.disconnect().catch(() => {}) };
}
