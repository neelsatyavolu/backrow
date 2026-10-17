# Backrow

Free, open-source watch parties for **Netflix, Hulu, Peacock, YouTube** and **your own video files**. Play, pause and seek stay in sync for everyone, and the chat on the side is end-to-end encrypted. It runs on Cloudflare's free plan.

**Live:** https://backrow.n3el.dev

## Install (Chrome, Edge, Brave, Arc)

1. Download [`backrow-extension.zip`](https://backrow.n3el.dev/backrow-extension.zip) (also attached to each [release](https://github.com/neelsatyavolu/backrow/releases)).
2. Unzip it, and keep the `backrow-extension` folder somewhere permanent.
3. Open `chrome://extensions` and turn on **Developer mode**.
4. Click **Load unpacked** and choose the folder.

To start a party, open a show, click the Backrow icon, press **Start party** and send the invite link. Everyone needs the extension, plus their own account on the streaming site. YouTube and uploaded videos need no account.

To watch your own file, upload it on [backrow.n3el.dev](https://backrow.n3el.dev#upload). No extension is needed for that, and it works in any modern browser, phones included.

## Features

- Synced play, pause, seek and speed. Small drift is corrected with a brief speed change rather than a jump, and big drift with a seek.
- Next episode and autoplay take the party along with you.
- A chat with reactions, typing indicators, join/leave notices and "Maya paused at 41:02" events.
- An optional host-only mode, where only the host controls playback.
- Encrypted uploads of up to 2 GB, streamed with seeking support and deleted automatically.
- Profiles with a display name, color and optional photo, all end-to-end encrypted like the chat.
- The video shrinks beside the chat (animated) instead of being covered, including in fullscreen.
- Peacock sync stays on the show even when viewers get different ad breaks.
- No accounts, no ads, no tracking.

## Privacy model

Each party has a random 256-bit key, carried in the invite link after the `#`. Browsers never send the fragment to a server.

| Encrypted with the party key (AES-GCM) | Visible to the server |
|---|---|
| Chat messages and reactions | Random party id |
| Names and colors | Number of connected members |
| Which show or file is playing | Message timing and sizes |
| Play/pause/seek positions | Who is host, and the control mode |
| Uploaded video (separate per-file key, 1 MiB chunks) | Encrypted file size |

Uploaded files are encrypted chunk by chunk in the uploader's browser. Viewers decrypt them in a service worker (`web/src/sw.ts`) that answers the `<video>` element's range requests, so seeking works without downloading the whole file. Files are deleted when the party has been empty for 6 hours, and an R2 lifecycle rule removes anything older than a day.

Anyone holding the invite link can join and read the chat, so share it only with the people you're inviting.

## How it works

```
extension/   Chrome MV3 extension
  background.ts   one encrypted WebSocket per tab (survives page loads)
  content.ts      sidebar + sync on streaming sites
  player.ts       per-site player adapters
  netflix-main.ts Netflix seeks through its own player API (main world)
web/         landing page, invite page, web player, decrypting service worker
worker/      Cloudflare Worker
  room.ts         one Durable Object per party (WebSocket hibernation)
  room-logic.ts   pure relay/permission rules (unit tested)
  quota.ts        caps total upload storage to stay inside the free tier
shared/      protocol, crypto, sync math, chat panel (used by all of the above)
```

## Debugging sync

To see every sync decision in the console of a streaming tab, run `localStorage.setItem("backrow:debug", "1")` there and reload. Please include that output when reporting a sync bug.

## Develop

```sh
npm install
npm run dev          # builds, then runs the Worker on http://localhost:8787
npm test             # unit tests
npm run typecheck
BACKROW_SERVER=http://localhost:8787 npm run test:e2e   # live tests against a running server
```

`npm run build` writes the extension to `extension/dist` (load it unpacked) and the zip to `dist/`. Set `BACKROW_SERVER` to build an extension that talks to your own server.

### Self-host

```sh
npx wrangler r2 bucket create backrow-media
npx wrangler r2 bucket lifecycle add backrow-media expire-uploads media/ --expire-days 1
openssl rand -hex 32 | npx wrangler secret put UPLOAD_SECRET --config worker/wrangler.jsonc
# edit worker/wrangler.jsonc routes for your domain, then:
BACKROW_SERVER=https://your.domain npm run deploy
```

## Limits and known gaps

- The extension supports Chromium browsers only. Firefox and Safari can join uploaded-video parties in the browser.
- All four services were tested end to end with two separate browser profiles (Google Chrome for the DRM services): Netflix, Hulu, Peacock and YouTube, plus uploaded videos. The tests covered pause, play, seeks from either side (including paused seeks), and steady playback, which held within about 0.3 s.
- Netflix and Hulu are driven through their own player APIs (`netflix-main.ts`, `hulu-main.ts`). Netflix errors if `currentTime` is written directly. Hulu only buffers a little ahead, so a plain seek gets clamped, and its element clock runs a few seconds off the content clock.
- Hulu ads play in a separate player and are detected. Peacock stitches ads into the stream, so Backrow reads Peacock's ad-break list and syncs on ad-free show time; viewers with different ads stay on the same scene. YouTube ads pause syncing until they end.
- The resize-beside-chat layout was verified on Netflix, Hulu and Peacock (and fullscreen on Netflix). YouTube uses a lighter rule because its page scrolls; that layout hasn't been checked in a browser yet.
- No video or voice call.

## License

[MIT](LICENSE). Backrow is not affiliated with Netflix, Hulu, Peacock or YouTube.
