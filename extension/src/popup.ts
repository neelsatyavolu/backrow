import { AVATAR_COLORS, type Profile } from "../../shared/payload";
import { fileToAvatar, photoCanvas } from "../../shared/ui/avatar-image";
import { SERVICE_LABELS } from "../../shared/services";
import { SERVER, type PopupStatus, type RuntimeIn } from "./messages";

const view = document.getElementById("view")!;
const nameInput = document.getElementById("name") as HTMLInputElement;
const swatches = document.getElementById("swatches")!;
const avatarEl = document.getElementById("avatar")!;
const photoBtn = document.getElementById("photo") as HTMLButtonElement;
const removeBtn = document.getElementById("removePhoto") as HTMLButtonElement;
const photoFile = document.getElementById("photoFile") as HTMLInputElement;
const photoError = document.getElementById("photoError")!;
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
  avatarEl.style.background = AVATAR_COLORS[profile.color] ?? AVATAR_COLORS[0]!;
  avatarEl.replaceChildren(profile.photo ? photoCanvas(profile.photo, "") : document.createTextNode(profile.name.slice(0, 1).toUpperCase()));
  photoBtn.textContent = profile.photo ? "Change photo" : "Upload photo";
  removeBtn.hidden = !profile.photo;
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
// On macOS the file picker closes the toolbar popup before a file comes back,
// so from the popup this opens the same page in a tab, where picking works.
const inToolbarPopup = chrome.extension.getViews({ type: "popup" }).includes(window);
const profileOnly = new URLSearchParams(location.search).get("edit") === "profile";
photoBtn.addEventListener("click", () => {
  if (inToolbarPopup) void chrome.tabs.create({ url: chrome.runtime.getURL("popup.html?edit=profile") });
  else photoFile.click();
});
photoFile.addEventListener("change", async () => {
  const file = photoFile.files?.[0];
  photoFile.value = "";
  if (!file) return;
  photoError.hidden = true;
  try {
    await saveProfile({ ...profile, photo: await fileToAvatar(file) });
  } catch (err) {
    photoError.textContent = err instanceof Error ? err.message : "That image couldn't be used.";
    photoError.hidden = false;
  }
});
removeBtn.addEventListener("click", () => {
  const { photo: _removed, ...rest } = profile;
  void saveProfile(rest);
});

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

if (profileOnly) {
  document.body.classList.add("profile-page");
  view.hidden = true;
}

refresh().catch(() => {
  view.replaceChildren(el("p", "error", "Something went wrong. Reload the page and try again."));
});
