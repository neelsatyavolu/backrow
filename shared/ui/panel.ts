// The party sidebar: members, chat, reactions and settings. Renders only with
// textContent, so nothing another member sends can inject markup.

import type { ChatEntry, ConnectionStatus, Member, PartyEvent, RoomSnapshot } from "../party-client";
import { AVATAR_COLORS, CHAT_MAX, NAME_MAX, REACTIONS, type PlaybackState, type Profile } from "../payload";
import type { ControlMode } from "../protocol";
import { expectedPosition, formatTime } from "../sync";
import { applyEvent } from "../room-mirror";
import { PANEL_CSS } from "./panel-css";

export interface PanelActions {
  sendChat(text: string): void;
  react(emoji: string): void;
  typing(on: boolean): void;
  setControl(mode: ControlMode): void;
  setProfile(profile: Profile): void;
  inviteUrl(): string;
  leave(): void;
  serverNow(): number;
}

export interface PanelOptions {
  /** Docked panels sit in the page layout (web player); floating ones overlay a site. */
  docked: boolean;
  profile: Profile;
}

type El = HTMLElement;

function h<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (cls) el.className = cls;
  if (text !== undefined) el.textContent = text;
  return el;
}

function avatar(m: Pick<Member, "name" | "color">, host = false): El {
  const a = h("span", host ? "avatar host" : "avatar", m.name.slice(0, 1).toUpperCase());
  a.style.background = AVATAR_COLORS[m.color] ?? AVATAR_COLORS[0]!;
  a.title = host ? `${m.name} (host)` : m.name;
  return a;
}

const clock = (at: number) => new Date(at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

export class ChatPanel {
  readonly host: El;
  private panel!: El;
  private tab!: El;
  private log!: El;
  private people!: El;
  private statusEl!: El;
  private typingEl!: El;
  private lockEl!: El;
  private settings!: El;
  private controlToggle!: HTMLInputElement;
  private nameInput!: HTMLInputElement;
  private swatches: HTMLButtonElement[] = [];
  private input!: HTMLTextAreaElement;
  private floats!: El;
  private snap: RoomSnapshot | null = null;
  private lastFrom: string | null = null;
  private typers = new Map<string, { name: string; timer: ReturnType<typeof setTimeout> }>();
  private typingSent = 0;
  private typingStop: ReturnType<typeof setTimeout> | null = null;
  private unread = 0;
  private profile: Profile;

  constructor(
    private readonly root: ShadowRoot,
    private readonly actions: PanelActions,
    private readonly opts: PanelOptions,
  ) {
    this.profile = opts.profile;
    // A constructed sheet is not blocked by strict page CSPs, unlike <style>.
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(PANEL_CSS);
    root.adoptedStyleSheets = [sheet];
    this.host = h("div", "backrow-scope");
    root.append(this.host);
    this.build();
  }

  private build(): void {
    const panel = h("aside", this.opts.docked ? "panel docked" : "panel");
    panel.setAttribute("aria-label", "Watch party");

    const head = h("div", "head");
    const brand = h("span", "brand", "Backrow");
    this.statusEl = h("span", "status");
    const invite = h("button", "icon-btn", "Invite");
    invite.title = "Copy the invite link";
    invite.onclick = () => this.copyInvite();
    const gear = h("button", "icon-btn", "You");
    gear.title = "Your name and color";
    gear.onclick = () => this.settings.classList.toggle("open");
    head.append(brand, this.statusEl, h("span", "spacer"), invite, gear);
    if (!this.opts.docked) {
      const hide = h("button", "icon-btn", "Hide");
      hide.title = "Hide the party panel";
      hide.onclick = () => this.setOpen(false);
      head.append(hide);
    }

    this.people = h("div", "people");
    this.settings = this.buildSettings();
    this.log = h("div", "log");
    this.log.setAttribute("role", "log");
    this.log.setAttribute("aria-live", "polite");
    this.typingEl = h("div", "typing");
    this.lockEl = h("div", "lock");

    const reacts = h("div", "reacts");
    for (const emoji of REACTIONS) {
      const b = h("button", "react", emoji);
      b.title = `React ${emoji}`;
      b.onclick = () => this.actions.react(emoji);
      reacts.append(b);
    }

    const compose = h("form", "compose");
    this.input = h("textarea");
    this.input.placeholder = "Say something";
    this.input.maxLength = CHAT_MAX;
    this.input.rows = 1;
    this.input.setAttribute("aria-label", "Message");
    const send = h("button", "send", "Send");
    send.type = "submit";
    compose.append(this.input, send);
    compose.onsubmit = (e) => {
      e.preventDefault();
      this.submit();
    };
    this.input.addEventListener("keydown", (e) => {
      // Keep keystrokes away from the site's player shortcuts.
      e.stopPropagation();
      if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        this.submit();
      }
    });
    for (const type of ["keyup", "keypress"]) this.input.addEventListener(type, (e) => e.stopPropagation());
    // On streaming sites keydown is swallowed before it reaches us (see the
    // content script), so Enter is also handled at the input level.
    this.input.addEventListener("beforeinput", (e) => {
      if (e.inputType === "insertLineBreak") {
        e.preventDefault();
        this.submit();
      }
    });
    this.input.addEventListener("input", () => this.onType());

    panel.append(head, this.people, this.settings, this.log, this.typingEl, this.lockEl, reacts, compose);
    this.panel = panel;

    this.tab = h("button", "tab", "Backrow");
    this.tab.onclick = () => this.setOpen(true);
    this.floats = h("div", this.opts.docked ? "floats full" : "floats");
    if (this.opts.docked) this.floats.style.right = "var(--panel-w)";
    this.host.append(this.floats, panel, this.tab);
    this.renderStatus("connecting");
    this.renderEmpty();
  }

  private buildSettings(): El {
    const box = h("div", "settings");
    const nameLabel = h("label", "label", "Name");
    this.nameInput = h("input", "field");
    this.nameInput.maxLength = NAME_MAX;
    this.nameInput.value = this.profile.name;
    this.nameInput.addEventListener("keydown", (e) => e.stopPropagation());
    this.nameInput.addEventListener("change", () => this.saveProfile());
    const sw = h("div", "swatches");
    this.swatches = AVATAR_COLORS.map((color, i) => {
      const b = h("button", "swatch");
      b.style.background = color;
      b.setAttribute("aria-label", `Color ${i + 1}`);
      b.setAttribute("aria-pressed", String(i === this.profile.color));
      b.onclick = () => {
        this.profile = { ...this.profile, color: i };
        this.saveProfile();
      };
      sw.append(b);
      return b;
    });
    const toggle = h("label", "toggle");
    this.controlToggle = h("input");
    this.controlToggle.type = "checkbox";
    this.controlToggle.onchange = () => this.actions.setControl(this.controlToggle.checked ? "host" : "everyone");
    toggle.append(this.controlToggle, document.createTextNode("Only I can control playback"));
    const leave = h("button", "icon-btn", "Leave party");
    leave.style.alignSelf = "flex-start";
    leave.style.paddingLeft = "0";
    leave.onclick = () => this.actions.leave();
    box.append(nameLabel, this.nameInput, h("span", "label", "Color"), sw, toggle, leave);
    return box;
  }

  private saveProfile(): void {
    const name = this.nameInput.value.trim().slice(0, NAME_MAX) || this.profile.name;
    this.profile = { ...this.profile, name };
    this.nameInput.value = name;
    this.swatches.forEach((b, i) => b.setAttribute("aria-pressed", String(i === this.profile.color)));
    this.actions.setProfile(this.profile);
  }

  setOpen(open: boolean): void {
    this.panel.classList.toggle("hidden", !open);
    this.tab.classList.toggle("show", !open);
    this.floats.classList.toggle("full", !open || this.opts.docked);
    if (open) {
      this.unread = 0;
      this.renderTab();
    }
  }

  get isOpen(): boolean {
    return !this.panel.classList.contains("hidden");
  }

  private renderTab(): void {
    this.tab.textContent = "Backrow";
    if (this.unread > 0) this.tab.append(h("span", "badge", String(this.unread)));
  }

  private submit(): void {
    const text = this.input.value.trim();
    if (!text) return;
    this.actions.sendChat(text);
    this.input.value = "";
    this.stopTyping();
  }

  private onType(): void {
    const now = Date.now();
    if (now - this.typingSent > 2500) {
      this.typingSent = now;
      this.actions.typing(true);
    }
    if (this.typingStop) clearTimeout(this.typingStop);
    this.typingStop = setTimeout(() => this.stopTyping(), 3000);
  }

  private stopTyping(): void {
    if (this.typingSent === 0) return;
    this.typingSent = 0;
    if (this.typingStop) clearTimeout(this.typingStop);
    this.actions.typing(false);
  }

  private async copyInvite(): Promise<void> {
    const url = this.actions.inviteUrl();
    try {
      await navigator.clipboard.writeText(url);
      this.toast("Invite link copied");
    } catch {
      window.prompt("Copy this invite link", url);
    }
  }

  toast(text: string): void {
    const t = h("div", "toast", text);
    this.host.append(t);
    setTimeout(() => t.remove(), 2200);
  }

  renderStatus(status: ConnectionStatus): void {
    const label = { connecting: "connecting", open: "live", reconnecting: "reconnecting", closed: "ended" }[status];
    this.statusEl.replaceChildren(h("span", `dot ${status}`), document.createTextNode(label));
  }

  private renderEmpty(): void {
    if (this.log.children.length === 0) {
      this.log.append(h("p", "empty", "Messages are end-to-end encrypted. Only people with the invite link can read them."));
    }
  }

  private renderPeople(): void {
    const s = this.snap;
    if (!s) return;
    const shown = s.members.slice(0, 12).map((m) => avatar(m, m.id === s.host));
    const count = h("span", "count", `${s.members.length} watching`);
    this.people.replaceChildren(...shown, count);
    const isHost = s.host === s.you;
    this.controlToggle.checked = s.control === "host";
    this.controlToggle.disabled = !isHost;
    this.controlToggle.parentElement!.title = isHost ? "" : "Only the host can change this";
    this.lockEl.textContent = s.control === "host" && !isHost ? "The host controls playback" : "";
  }

  private appendChat(entry: ChatEntry): void {
    this.log.querySelector(".empty")?.remove();
    const cont = this.lastFrom === entry.from;
    const row = h("div", cont ? "msg cont" : "msg");
    row.append(avatar(entry));
    if (!cont) {
      const who = h("div", "who");
      who.append(h("span", "name", entry.name), h("span", "time", clock(entry.at)));
      row.append(who);
    }
    row.append(h("div", "text", entry.text));
    this.lastFrom = entry.from;
    this.push(row);
  }

  notice(parts: Array<string | { b: string }>): void {
    this.log.querySelector(".empty")?.remove();
    const p = h("p", "notice");
    for (const part of parts) p.append(typeof part === "string" ? document.createTextNode(part) : h("b", undefined, part.b));
    this.lastFrom = null;
    this.push(p);
  }

  private push(el: El): void {
    const atBottom = this.log.scrollHeight - this.log.scrollTop - this.log.clientHeight < 60;
    this.log.append(el);
    while (this.log.children.length > 300) this.log.firstElementChild?.remove();
    if (atBottom) this.log.scrollTop = this.log.scrollHeight;
  }

  private floatReaction(emoji: string, name: string): void {
    const f = h("div", "float");
    f.style.left = `${10 + Math.random() * 70}%`;
    f.append(h("span", "e", emoji), h("span", "n", name));
    this.floats.append(f);
    setTimeout(() => f.remove(), 2700);
  }

  private renderTyping(): void {
    const names = [...this.typers.values()].map((t) => t.name);
    this.typingEl.textContent =
      names.length === 0 ? "" : names.length === 1 ? `${names[0]} is typing` : `${names.length} people are typing`;
  }

  private describeState(prev: PlaybackState | null, next: PlaybackState, by: Member): void {
    const at = formatTime(next.position);
    if (!prev || prev.playing !== next.playing) {
      this.notice([{ b: by.name }, next.playing ? ` played from ${at}` : ` paused at ${at}`]);
    } else if (Math.abs(prev.rate - next.rate) > 0.01) {
      this.notice([{ b: by.name }, ` set speed to ${next.rate}x`]);
    } else if (Math.abs(expectedPosition(prev, next.at) - next.position) > 3) {
      this.notice([{ b: by.name }, ` jumped to ${at}`]);
    }
  }

  /** Full room snapshot, on join or after reconnecting. */
  setSnapshot(snapshot: RoomSnapshot): void {
    const first = this.snap === null;
    this.snap = snapshot;
    if (first) {
      for (const entry of snapshot.chat) this.appendChat(entry);
      this.notice(["You joined. ", { b: `${snapshot.members.length}` }, snapshot.members.length === 1 ? " person here." : " people here."]);
    }
    this.renderPeople();
  }

  handle(e: PartyEvent): void {
    const prev = this.snap;
    if (e.type === "snapshot") {
      this.setSnapshot(e.snapshot);
      return;
    }
    this.snap = applyEvent(prev, e);
    switch (e.type) {
      case "status":
        this.renderStatus(e.status);
        break;
      case "member-join":
        this.renderPeople();
        this.notice([{ b: e.member.name }, " joined"]);
        break;
      case "member-leave":
        this.typers.delete(e.member.id);
        this.renderTyping();
        this.renderPeople();
        this.notice([{ b: e.member.name }, " left"]);
        break;
      case "member-update":
        this.renderPeople();
        break;
      case "state":
        this.describeState(prev?.state ?? null, e.state, e.by);
        break;
      case "video":
        this.notice([{ b: e.by.name }, " changed the video"]);
        break;
      case "chat": {
        const typer = this.typers.get(e.entry.from);
        if (typer) clearTimeout(typer.timer);
        this.typers.delete(e.entry.from);
        this.renderTyping();
        this.appendChat(e.entry);
        if (!this.isOpen && e.entry.from !== prev?.you) {
          this.unread++;
          this.renderTab();
        }
        break;
      }
      case "react":
        this.floatReaction(e.emoji, e.from.name);
        break;
      case "typing": {
        const old = this.typers.get(e.member.id);
        if (old) clearTimeout(old.timer);
        if (e.on) {
          const timer = setTimeout(() => {
            this.typers.delete(e.member.id);
            this.renderTyping();
          }, 6000);
          this.typers.set(e.member.id, { name: e.member.name, timer });
        } else {
          this.typers.delete(e.member.id);
        }
        this.renderTyping();
        break;
      }
      case "control":
        this.renderPeople();
        this.notice([e.mode === "host" ? "Only the host can control playback now" : "Everyone can control playback now"]);
        break;
      case "host": {
        this.renderPeople();
        const mine = e.id === prev?.you;
        const who = prev?.members.find((m) => m.id === e.id);
        if (who) this.notice([{ b: mine ? "You" : who.name }, mine ? " are the host now" : " is the host now"]);
        break;
      }
      case "error":
        if (e.code === "host-only") this.toast(e.message);
        else if (e.code === "slow-down") this.toast("Slow down a little");
        break;
    }
  }

  /** Mirror a state change this client made itself, so notices stay accurate. */
  noteOwnState(state: PlaybackState): void {
    if (this.snap) this.snap = { ...this.snap, state: { ...state, by: this.snap.you } };
  }

  destroy(): void {
    this.stopTyping();
    this.root.replaceChildren();
  }
}
