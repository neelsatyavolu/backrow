import { AVATAR_COLORS, type Profile } from "../../shared/payload";
import { SERVICE_LABELS } from "../../shared/services";
import { SERVER, type PopupStatus, type RuntimeIn } from "./messages";

const view = document.getElementById("view")!;
const nameInput = document.getElementById("name") as HTMLInputElement;
const swatches = document.getElementById("swatches")!;
(document.getElementById("home") as HTMLAnchorElement).href = SERVER;

let tabId = -1;
let profile: Profile = { name: "Guest", color: 0 };

const ask = <T>(msg: RuntimeIn): Promise<T> => chrome.runtime.sendMessage(msg) as Promise<T>;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls = "", text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function renderProfile(): void {
  nameInput.value = profile.name;
  swatches.replaceChildren(
    ...AVATAR_COLORS.map((color, i) => {
      const b = el("button", "swatch");
      b.style.background = color;
      b.setAttribute("aria-label", `Color ${i + 1}`);
      b.setAttribute("aria-pressed", String(i === profile.color));
      b.onclick = () => saveProfile({ ...profile, color: i });
      return b;
    }),
  );
}

async function saveProfile(next: Profile): Promise<void> {
  const name = next.name.trim().slice(0, 24);
  if (!name) return;
  profile = { ...next, name };
  renderProfile();
  await ask({ type: "set-profile", profile });
}

nameInput.addEventListener("change", () => saveProfile({ ...profile, name: nameInput.value }));

function render(status: PopupStatus): void {
  view.replaceChildren();
  if (status.session) {
    const s = status.session;
    const count = s.snapshot?.members.length ?? 0;
    const state = el("div", "status");
    state.append(el("span", "dot"), document.createTextNode(`${s.status === "open" ? "live" : s.status} · ${count} watching`));
    const row = el("div", "row");
    const field = el("input", "field");
    field.readOnly = true;
    field.value = s.invite;
    field.setAttribute("aria-label", "Invite link");
    const copy = el("button", "btn", "Copy");
    copy.onclick = async () => {
      await navigator.clipboard.writeText(s.invite);
      copy.textContent = "Copied";
      setTimeout(() => (copy.textContent = "Copy"), 1500);
    };
    row.append(field, copy);
    const leave = el("button", "btn ghost", "Leave party");
    leave.onclick = async () => {
      await ask({ type: "leave", tabId });
      void refresh();
    };
    view.append(state, el("span", "label", "Invite link"), row, el("p", "meta", "Anyone with this link can join. The part after # is the encryption key and never reaches our server."), leave);
    return;
  }
  if (!status.supported) {
    view.append(
      el("p", "title", "Open a video to start a party"),
      el("p", "meta", "Backrow works on Netflix, Hulu, Peacock and YouTube. To watch your own file, upload it on the Backrow site."),
    );
    return;
  }
  if (!status.video) {
    view.append(el("p", "title", "Pick something to watch"), el("p", "meta", "Open a show or video, then start the party from here."));
    return;
  }
  const v = status.video;
  const toggle = el("label", "toggle");
  const hostOnly = el("input");
  hostOnly.type = "checkbox";
  toggle.append(hostOnly, document.createTextNode("Only I can control playback"));
  const start = el("button", "btn accent", "Start party");
  const error = el("p", "error");
  start.onclick = async () => {
    start.disabled = true;
    start.textContent = "Starting";
    const res = await ask<{ ok: boolean; error?: string }>({ type: "start", tabId, hostOnly: hostOnly.checked });
    if (!res.ok) {
      error.textContent = res.error ?? "Could not start the party.";
      start.disabled = false;
      start.textContent = "Start party";
      return;
    }
    setTimeout(() => void refresh(), 600);
  };
  view.append(el("span", "label", SERVICE_LABELS[v.service]), el("p", "title", v.title ?? "This video"), toggle, start, error);
}

async function refresh(): Promise<void> {
  // ?tab=<id> lets the popup be opened as a page for a specific tab (used by tests).
  const forced = Number(new URLSearchParams(location.search).get("tab"));
  if (Number.isInteger(forced) && forced > 0) {
    tabId = forced;
  } else {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.id === undefined) return;
    tabId = tab.id;
  }
  const status = await ask<PopupStatus>({ type: "popup-status", tabId });
  profile = status.profile;
  renderProfile();
  render(status);
}

refresh().catch(() => {
  view.replaceChildren(el("p", "error", "Something went wrong. Reload the page and try again."));
});
