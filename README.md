# Backrow

Free, open-source watch parties for **Netflix, Hulu, Peacock, YouTube, Prime Video, HBO Max, Disney+** and **videos streamed from your own computer**. Play, pause and seek stay in sync for everyone, and the chat on the side is end-to-end encrypted. It runs on Cloudflare's free plan.

**Live:** https://backrow.n3el.dev

## Install (Chrome, Edge, Brave, Arc)

1. Download [`backrow-extension.zip`](https://backrow.n3el.dev/backrow-extension.zip) (also attached to each [release](https://github.com/neelsatyavolu/backrow/releases)).
2. Unzip it, and keep the `backrow-extension` folder somewhere permanent.
3. Open `chrome://extensions` and turn on **Developer mode**.
4. Click **Load unpacked** and choose the folder.

Or install from git, which makes updates a `git pull`:

```sh
git clone https://github.com/neelsatyavolu/backrow.git
```

Load unpacked the `backrow/extension/dist` folder. To update, run `git pull` in `backrow` and click the reload button on the Backrow card in `chrome://extensions`. No build step is needed: `extension/dist` is committed, and CI checks that it matches the source.

To start a party, open a show, click the Backrow icon, press **Start party** and send the invite link. Everyone needs the extension, plus their own account on the streaming site. YouTube and your own videos need no account.

To watch your own file, open [backrow.n3el.dev/host](https://backrow.n3el.dev/host) and pick it. Nothing is uploaded: your browser streams it peer-to-peer (WebRTC) to each friend, compressed live in high quality. Friends need no extension and can use any modern browser. Hosting needs Chrome, Edge or Firefox, and the tab has to stay open.

## Features

- Synced play, pause, seek and speed. Small drift is corrected with a brief speed change rather than a jump, and big drift with a seek.
- Next episode and autoplay take the party along with you.
- A chat with reactions, typing indicators, join/leave notices and "Maya paused at 41:02" events.
- An optional host-only mode, where only the host controls playback.
- Stream your own file straight from your browser, with a custom player that has a seek preview, volume, keyboard shortcuts and fullscreen with the chat alongside.
- Profiles with a display name, color and optional photo, all end-to-end encrypted like the chat.
- The video shrinks beside the chat (animated) instead of being covered, including in fullscreen.
- Peacock sync stays on the show even when viewers get different ad breaks.
- Optional accounts (email and password) that keep your photo, name and color on every device, encrypted so the server can't read them. Nothing else needs an account.
- No ads, no tracking.

## Privacy model

Each party has a random 256-bit key, carried in the invite link after the `#`. Browsers never send the fragment to a server.

| Encrypted with the party key (AES-GCM) | Visible to the server |
|---|---|
| Chat messages and reactions | Random party id |
| Names and colors | Number of connected members |
| Which show or file is playing | Message timing and sizes |
| Play/pause/seek positions | Who is host, and the control mode |
| Your own video (WebRTC DTLS-SRTP, browser to browser; setup is sealed with the party key) | That two members are exchanging connection setup |

Your own videos never touch the server. WebRTC setup messages (offers, answers, candidates) are sealed with the party key, so the server can't swap in its own encryption keys.

Anyone holding the invite link can join and read the chat, so share it only with the people you're inviting.

### Accounts

Accounts are optional and only sync your profile. Your password never leaves the browser: it is stretched with PBKDF2 (600,000 rounds, salted with your email) and split with HKDF into two keys. One key proves who you are; the server stores only a salted hash of it. The other encrypts your profile (AES-GCM) before upload, and the server never sees it. The server stores your email, that hash and the encrypted profile.

Emails (a 6-digit code to confirm your address or reset your password) are sent through Resend. Because only your password can unlock your saved profile, resetting a forgotten password clears it; the copy on your device is uploaded again. Sign-in tries are rate limited per address and per IP, and each code allows five attempts in 15 minutes.

## How it works

```
extension/   Chrome MV3 extension
  background.ts   one encrypted WebSocket per tab (survives page loads)
  content.ts      sidebar + sync on streaming sites
  player.ts       per-site player adapters
  netflix-main.ts Netflix seeks through its own player API (main world)
web/         landing page, invite page, host/viewer player, WebRTC streaming
worker/      Cloudflare Worker
  room.ts         one Durable Object per party (WebSocket hibernation)
  room-logic.ts   pure relay/permission rules (unit tested)
  account.ts      optional accounts (D1 + Resend email codes)
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

For accounts in local dev, put `DEV_CODES=1` in `worker/.dev.vars` and run `npx wrangler d1 migrations apply backrow-accounts --local --config worker/wrangler.jsonc` once. The dev server then shows email codes on the page instead of sending them. The account e2e tests need this.

`npm run build` writes the extension to `extension/dist` (load it unpacked) and the zip to `dist/`. Commit `extension/dist` along with source changes, or the CI check fails. Set `BACKROW_SERVER` to build an extension that talks to your own server; those builds go to `extension/dist-dev`, which git ignores, so the committed copy always points at backrow.n3el.dev.

### Self-host

```sh
# create a D1 database and put its id in worker/wrangler.jsonc, edit the routes
# for your domain and the sender in worker/src/account.ts, then:
npx wrangler secret put RESEND_API_KEY --config worker/wrangler.jsonc
BACKROW_SERVER=https://your.domain npm run deploy
```

## Limits and known gaps

- The extension supports Chromium browsers only. Firefox and Safari can join your-own-video parties in the browser.
- Netflix, Hulu, Peacock and YouTube were tested end to end with two separate browser profiles (Google Chrome for the DRM services): Netflix, Hulu, Peacock and YouTube, plus peer-to-peer streaming of your own videos. The tests covered pause, play, seeks from either side (including paused seeks), and steady playback, which held within about 0.3 s.
- Netflix, Hulu and Disney+ are driven through their own player APIs (`netflix-main.ts`, `hulu-main.ts`, `disney-main.ts`). Netflix errors if `currentTime` is written directly. Hulu only buffers a little ahead, so a plain seek gets clamped, and its element clock runs a few seconds off the content clock. Disney+'s element clock is relative to its stream buffer, so Backrow reads and seeks the show position through Disney's player.
- Prime Video, HBO Max and Disney+ support is new and has not been tested end to end yet. Ads on those three are not detected, so an ad-supported plan can pull viewers apart during a break. Prime Video plays every episode of a season on the same page, so the party can't follow an episode change there: everyone picks the episode by hand. Prime Video works on primevideo.com, not amazon.com/gp/video.
- Hulu ads play in a separate player and are detected. Peacock stitches ads into the stream, so Backrow reads Peacock's ad-break list and syncs on ad-free show time; viewers with different ads stay on the same scene. YouTube ads pause syncing until they end.
- The resize-beside-chat layout was verified on Netflix, Hulu and Peacock (and fullscreen on Netflix). YouTube uses a lighter rule because its page scrolls; that layout hasn't been checked in a browser yet.
- Your-own-video streaming uses Cloudflare STUN only for now. Friends on strict networks (some corporate, school or mobile carriers) may fail to connect until a TURN relay is configured (set the `TURN_KEY_ID` and `TURN_KEY_TOKEN` secrets). The host's upload speed limits how many people can watch: about 2–5 at 1080p on a typical home connection.
- No video or voice call.

## License

[MIT](LICENSE). Backrow is not affiliated with Netflix, Hulu, Peacock, YouTube, Amazon, HBO Max or Disney.
