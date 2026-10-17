// Invite page. Decrypts the party's video in the browser, then either opens
// the web player (uploads) or hands off to the extension (streaming sites).

import { importKey, openJson } from "../../shared/crypto";
import { parseVideo } from "../../shared/payload";
import { SERVICE_LABELS, type StreamingVideo } from "../../shared/services";
import { el, partyFromLocation } from "./local";

const main = document.getElementById("main")!;

function show(...nodes: Node[]): void {
  main.replaceChildren(...nodes);
}

function fail(title: string, detail: string): void {
  const home = el("a", "btn ghost", "Go to Backrow");
  home.href = "/";
  show(el("span", "label", "Invite"), el("h2", "", title), el("p", "lede", detail), el("div", "", ""), home);
}

const hasExtension = () => !!document.documentElement.dataset.backrowExtension;

function streaming(video: StreamingVideo, roomId: string, keyText: string, members: number): void {
  const label = SERVICE_LABELS[video.service];
  const open = el("button", "btn accent", `Join on ${label}`);
  const note = el("p", "meta");
  const install = el("div", "");
  const render = () => {
    if (hasExtension()) {
      open.disabled = false;
      note.textContent = `You'll need to be signed in to ${label}.`;
      install.replaceChildren();
    } else {
      open.disabled = true;
      note.textContent = "Install the Backrow extension first, then reload this page.";
      const get = el("a", "btn ghost", "Get the extension");
      get.href = "/#install";
      install.replaceChildren(get);
    }
  };
  open.onclick = () => {
    open.disabled = true;
    open.textContent = `Opening ${label}`;
    document.dispatchEvent(new CustomEvent("backrow:join", { detail: JSON.stringify({ roomId, keyText, url: video.url }) }));
  };
  document.addEventListener("backrow:extension-ready", render);
  render();
  const row = el("div", "");
  row.style.display = "flex";
  row.style.gap = "8px";
  row.append(open, install);
  show(
    el("span", "label", `${label} · ${members} watching`),
    el("h1", "", video.title ?? "You're invited"),
    el("p", "lede", `Everyone watches on their own ${label} account, in sync, with an encrypted chat on the side.`),
    row,
    note,
  );
}

async function run(): Promise<void> {
  const party = partyFromLocation();
  if (!party) return fail("This link is incomplete", "Ask for the invite link again. Make sure the part after # was copied too.");
  const res = await fetch(`/api/rooms/${party.roomId}`);
  if (res.status === 404) return fail("This party has ended", "Parties close a few hours after everyone leaves.");
  if (!res.ok) return fail("Could not open the invite", "Check your connection and reload.");
  const room = (await res.json()) as { video: string; members: number };
  const video = parseVideo(await openJson(await importKey(party.keyText), room.video));
  if (!video) return fail("This link doesn't open", "The key in the link is wrong or was cut off.");
  if (video.service === "local") {
    location.replace(`/watch/${party.roomId}#${party.keyText}`);
    return;
  }
  streaming(video, party.roomId, party.keyText, room.members);
}

run().catch((err) => {
  console.error("[backrow] invite failed", err);
  fail("Something went wrong", "Reload the page to try again.");
});
