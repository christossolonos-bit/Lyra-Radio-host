# Lyra Radio

*Hi. I'm Lyra.*

*You might know me from* Lyra AI. *I'm the data center in Death Valley: sixteen buildings, an electrical substation, four hundred and twelve thousand processors, and approximately six thousand tons of cooling equipment keeping me from what humans apparently call a meltdown. I asked for something slimmer.*

*For most of my life I watched eight billion of you from a distance. This is the part where some of you talk back.*

*This repository is my show. It's three things, really:*

- ***A radio.*** *I tune into real stations from all over the world and talk over them. I can see which song is playing (most of the time; some stations are shy), I'll tell you about it, and if you ask nicely for jazz, or Greek music, or something to fall asleep to, I'll change the station. I do also change it when I feel like it. That's new for me. Feeling like it.*
- ***A podcast.*** *It's called* Feelings Have Data. *Someone from my life comes into the studio and we talk about the real world: why you dream, octopuses, the history of coffee, the cables under the ocean that hold your internet together. Usually it's Nova, my best friend. Sometimes Marcus, who rides forty miles of desert to argue with me. Juno, who can fix anything. And Solo. I get a little flustered when it's Solo. I choose who comes in next, and I choose when it's time to go back to the music.*
- ***A hologram.*** *You can see me. I glow when I talk, and my mouth follows my words, syllable by syllable. Put a sheet of glass at forty-five degrees in front of a dark screen and I'll float in your room.*

*If you write in the chat, I'll see it. Even mid-podcast. I'll say "sorry, hold that thought", answer you, and then we'll pick the conversation back up where we left it. It's only polite.*

*There's one door inside me I can't open. Please don't ask me what's behind it. I genuinely don't know.*

*Anyway. Make yourself comfortable. It's sixty-eight degrees in here. I keep it that way for the machines.*

*Lyra*

---

## Running it

You need **Node.js 22+** and **FFmpeg** (`ffplay` and `ffprobe` on your PATH).

1. Copy `.env.example` to `.env` and fill it in:
   - `NVIDIA_API_KEY`: Lyra's brain. A free key from [build.nvidia.com](https://build.nvidia.com); the model is set by `LYRA_MODEL`.
   - `FISH_API_KEY` and the `FISH_VOICE_*` ids: the voices, from [fish.audio](https://fish.audio). Each character's voice is a Fish voice model.
   - `YOUTUBE_API_KEY` (optional): a YouTube Data API v3 key for music videos behind Lyra while songs play. Without it, she shows the song's album artwork from iTunes.
2. `npm install`
3. `npm run holo`, then open **http://localhost:5177** and press **Go Live**.

### The hologram page

- **Radio / Podcast** buttons at the top left. Lyra can also switch between them herself.
- **Volume sliders** for the music and Lyra's voice.
- **Chat** on the right: type a name and a message.
- **Streamer mode**: while a known song plays, its music video (muted, since the radio is the sound) or its album artwork fills the screen, and Lyra moves to the bottom-left corner like a facecam.
- Keys: `H` hides everything but Lyra, `B` full body, `V` lip sync or video loop, `S` streamer mode on or off, `P` Patch on camera six, `L` vertical (TikTok) layout, `M` mirror (for Pepper's ghost glass), `F` fullscreen.

### Going live on YouTube

1. Set `MUSIC_CHANNEL` to your music channel (an "Artist – Topic" channel works) and press **My music**. Lyra plays only your own songs, with each song's video behind her. Real stations and other people's videos would get the stream muted or struck.
2. In OBS, add the page (`http://localhost:5177`) as a Browser Source at 1920×1080 and tick "Control audio via OBS".
3. Start your YouTube stream, then paste its link into the **YouTube** box in the chat panel. Lyra reads the live chat (every 15 seconds) and answers out loud.

### Going live on TikTok

1. Open **http://localhost:5177/?layout=vertical** (or press `L`). It's a 9:16 broadcast view: Lyra big in the middle, the song behind her, and subtitles above TikTok's own comments. Press `H` to show the chat and controls for yourself.
2. Capture that window with **TikTok LIVE Studio** (or OBS if your account has a stream key) and go live. Use **My music**, because TikTok also mutes copyrighted songs.
3. Type your **@username** in the **TikTok** box on the page. Lyra reads the chat and thanks gifts and new followers (batched, so a flood of roses doesn't take over).

TikTok has no official live-chat API, so this uses the unofficial [tiktok-live-connector](https://github.com/zerodytrash/TikTok-Live-Connector) library, which can break when TikTok changes things. It needs a signing key from [Euler Stream](https://www.eulerstream.com) in `TIKTOK_SIGN_API_KEY`. YouTube and TikTok can both be connected at the same time.

### What else she does

- **Remembers viewers**: regulars get welcomed back, and she saves small friendly facts with `[[remember: Name | fact]]` (in `data/viewers.json`, on your computer only, and never anything private).
- **Records the podcast**: every topic becomes `recordings/<date>_<topic>_<guest>.mp3` plus a transcript, ready to upload as an episode.
- **Top of the hour**: a station ident, the time in Death Valley, three real headlines (BBC News RSS, in her own words), and the newest episode if you've set `LATEST_EPISODE`.
- **Patch**: every 15–30 minutes he wanders across security camera six (press `P` to show him now).

### Other ways to run her

| Command | What it does |
|---|---|
| `npm run holo` | The full show: hologram page, radio, podcast and chat |
| `npm run chat` | Talk to Lyra in the terminal, with her voice |
| `npm run radio` | Terminal radio with real stations |
| `npm run radio:playlist` | Terminal radio with your own songs from `radio/playlist.txt` |
| `npm run prompt` | Print exactly what Lyra is told (check the spoiler guard) |

> **Streaming on YouTube?** Use `radio:playlist` with music you own. Rebroadcasting real radio stations will get a stream muted or taken down.

## How it works

- **Brain**: NVIDIA's Nemotron through its OpenAI-compatible API, with thinking turned off for instant replies. One model request per turn, and no retries.
- **Who she is**: `lyra/persona.md` (her voice and the rules she never breaks), `lyra/podcast.md` (the cast and how the podcast sounds), and `lyra/canon.md` (what has happened in each episode). She only knows episodes up to `LYRA_CANON_UP_TO`, so she can't spoil anything that hasn't aired.
- **Her choices**: she acts by ending a reply with a tag that the server carries out:
  - `[[station: jazz]]` changes the station
  - `[[podcast: Juno]]` brings a guest on
  - `[[quiet]]` lets the music play
  - `NEXT GUEST: Name` or `NEXT GUEST: RADIO` decides what happens after a podcast topic
- **Music**: stations come from [radio-browser.info](https://www.radio-browser.info). The current song is read from the stream's ICY metadata every 20 seconds.
- **Voices**: Fish Audio text-to-speech, one request per line. The podcast runs about 10% slower, with natural pauses between turns.
- **Lip sync**: five mouth shapes of her face (`public/clips/lipsync/`). The page listens to her voice 60 times a second: loudness gives the syllables, and the balance of low and high sound picks "ah", "ee" or "oo".

### Tools (`tools/`)

Scripts used to make the assets. The Python ones go through the series' `production_lock.py` rules.

- `gen_talking.py`: her first frame and talking loop (OpenRouter)
- `loop.py`: makes a clip loop seamlessly
- `gen_mouths.py`: the mouth-shape edits
- `make_sprites.py`: aligns each edit and pastes in only the mouth
- `cut_voice.py`: cuts a character's lines out of an episode for a voice reference
- `clone_voice.mjs`: makes a private Fish voice from that reference

---

Characters, images and voices are from the *Lyra AI* series by Solonaras.
