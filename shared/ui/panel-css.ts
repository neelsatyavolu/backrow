// Panel styles. Lives inside a shadow root on streaming sites, so it brings
// its own tokens and never leaks into (or inherits from) the host page.

export const PANEL_CSS = `
:host, .backrow-scope {
  --bg:#0E0E0D; --surface:rgba(242,240,234,.035); --surface-hover:rgba(242,240,234,.06);
  --fg:#F2F0EA; --fg-2:rgba(242,240,234,.68); --fg-3:rgba(242,240,234,.45); --fg-4:rgba(242,240,234,.28);
  --border:rgba(242,240,234,.10); --border-strong:rgba(242,240,234,.22);
  --accent:#4C8DFF; --accent-muted:rgba(76,141,255,.45); --danger:#E5483A; --ok:#4FBF85;
  --mono:"Geist Mono",ui-monospace,SFMono-Regular,Menlo,monospace;
  --sans:"Geist",ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;
  --ease:cubic-bezier(.2,0,0,1);
  --panel-w:340px;
}
* { box-sizing:border-box; margin:0; padding:0; }
.backrow-scope { height:100%; }
button { font:inherit; color:inherit; background:none; border:0; cursor:pointer; }
button:focus-visible, input:focus-visible, textarea:focus-visible { outline:2px solid var(--accent-muted); outline-offset:2px; }

.panel {
  position:fixed; top:0; right:0; bottom:0; width:var(--panel-w); z-index:2147483646;
  display:flex; flex-direction:column; background:var(--bg); color:var(--fg);
  border-left:1px solid var(--border); font:14px/1.45 var(--sans);
  -webkit-font-smoothing:antialiased; transition:transform 250ms var(--ease);
}
.panel.docked { position:relative; height:100%; width:var(--panel-w); border-left:1px solid var(--border); }
.panel.hidden { transform:translateX(100%); }

.head { display:flex; align-items:center; gap:10px; padding:14px 14px 12px; border-bottom:1px solid var(--border); }
.brand { font:500 12px/1 var(--mono); letter-spacing:.08em; text-transform:uppercase; }
.status { display:flex; align-items:center; gap:6px; font:12px/1 var(--mono); color:var(--fg-3); letter-spacing:.04em; }
.dot { width:6px; height:6px; border-radius:50%; background:var(--fg-4); }
.dot.open { background:var(--accent); }
.dot.reconnecting { background:var(--danger); }
.spacer { flex:1; }
.icon-btn { height:28px; padding:0 8px; font:12px/1 var(--mono); color:var(--fg-2); border:1px solid transparent; transition:color 150ms var(--ease), border-color 150ms var(--ease); }
.icon-btn:hover { color:var(--fg); border-color:var(--border-strong); }

.people { display:flex; align-items:center; gap:6px; padding:10px 14px; border-bottom:1px solid var(--border); flex-wrap:wrap; }
.avatar { width:24px; height:24px; border-radius:50%; display:grid; place-items:center; font:500 11px/1 var(--mono); color:#0E0E0D; flex:none; position:relative; }
.avatar .photo { width:100%; height:100%; border-radius:50%; display:block; }
.avatar.big { width:40px; height:40px; font-size:16px; }
.photo-row { display:flex; align-items:center; gap:8px; }
.photo-error { font-size:12px; color:var(--danger); min-height:0; }
.photo-error:empty { display:none; }
.avatar.host::after { content:""; position:absolute; right:-1px; bottom:-1px; width:7px; height:7px; border-radius:50%; background:var(--fg); border:2px solid var(--bg); }
.people .count { font:12px/1 var(--mono); color:var(--fg-3); margin-left:4px; }

.settings { display:none; padding:12px 14px; border-bottom:1px solid var(--border); gap:10px; flex-direction:column; }
.settings.open { display:flex; }
.label { font:12px/1 var(--mono); letter-spacing:.08em; text-transform:uppercase; color:var(--fg-3); }
.field { width:100%; background:transparent; border:1px solid var(--border); color:var(--fg); font:14px var(--sans); padding:8px 10px; caret-color:var(--accent); border-radius:0; }
.field:focus { outline:none; border-color:var(--accent); }
.swatches { display:flex; gap:8px; }
.swatch { width:20px; height:20px; border-radius:50%; border:2px solid transparent; }
.swatch[aria-pressed="true"] { border-color:var(--fg); }
.toggle { display:flex; align-items:center; gap:8px; font-size:13px; color:var(--fg-2); }
.toggle input { accent-color:var(--accent); }

.log { flex:1; overflow-y:auto; padding:12px 14px 4px; display:flex; flex-direction:column; gap:2px; scrollbar-width:thin; scrollbar-color:var(--border-strong) transparent; }
.msg { display:grid; grid-template-columns:24px 1fr; gap:0 10px; padding-top:10px; }
.msg.cont { padding-top:2px; }
.msg.cont .avatar { visibility:hidden; height:0; }
.who { display:flex; align-items:baseline; gap:8px; }
.name { font-weight:500; font-size:13px; }
.time { font:11px/1 var(--mono); color:var(--fg-3); font-variant-numeric:tabular-nums; }
.text { color:var(--fg); white-space:pre-wrap; overflow-wrap:anywhere; grid-column:2; }
.notice { font:12px/1.4 var(--mono); color:var(--fg-3); padding:8px 0 4px; letter-spacing:.01em; }
.notice b { font-weight:500; color:var(--fg-2); }
.empty { margin:auto 0; color:var(--fg-3); font-size:13px; text-align:left; padding:12px 0; }

.typing { min-height:20px; padding:0 14px; font:12px/20px var(--mono); color:var(--fg-3); }
.reacts { display:flex; gap:2px; padding:6px 10px; border-top:1px solid var(--border); }
.react { flex:1; height:32px; font-size:17px; transition:background 150ms var(--ease); }
.react:hover { background:var(--surface-hover); }
.compose { display:flex; gap:8px; padding:10px 14px 14px; }
.compose textarea { flex:1; resize:none; height:40px; max-height:120px; background:transparent; border:1px solid var(--border); color:var(--fg); font:14px/1.4 var(--sans); padding:9px 10px; caret-color:var(--accent); border-radius:0; }
.compose textarea:focus { outline:none; border-color:var(--accent); }
.send { padding:0 14px; background:var(--fg); color:var(--bg); font-weight:500; font-size:13px; }
.send:disabled { opacity:.4; cursor:default; }
.lock { padding:2px 14px 0; font:12px/1.4 var(--mono); color:var(--fg-3); }

.tab {
  position:fixed; right:0; top:50%; transform:translateY(-50%); z-index:2147483646;
  background:var(--bg); color:var(--fg); border:1px solid var(--border-strong); border-right:0;
  font:500 12px/1 var(--mono); letter-spacing:.08em; text-transform:uppercase; padding:14px 8px;
  writing-mode:vertical-rl; display:none;
}
.tab.show { display:block; }
.tab .badge { display:inline-block; margin-top:8px; color:var(--accent); }

.floats { position:fixed; left:0; top:0; bottom:0; right:var(--panel-w); pointer-events:none; z-index:2147483645; overflow:hidden; }
.floats.full { right:0; }
.float { position:absolute; bottom:72px; display:flex; flex-direction:column; align-items:center; gap:4px; animation:rise 2600ms var(--ease) forwards; }
.float .e { font-size:40px; line-height:1; }
.float .n { font:11px/1 var(--mono); color:#F2F0EA; background:rgba(14,14,13,.7); padding:3px 6px; }
@keyframes rise { 0% { transform:translateY(0); opacity:0; } 10% { opacity:1; } 80% { opacity:1; } 100% { transform:translateY(-46vh); opacity:0; } }
.chat-toasts { position:fixed; top:16px; right:16px; width:min(320px, calc(100vw - 32px)); display:flex; flex-direction:column; z-index:2147483647; }
/* Leaving toasts collapse to zero height (grid 1fr -> 0fr) so the rest glide up instead of jumping. */
.chat-toast { display:grid; grid-template-rows:1fr; margin-bottom:8px; animation:toast-in 200ms var(--ease); transition:grid-template-rows 240ms var(--ease), margin-bottom 240ms var(--ease), opacity 160ms var(--ease), transform 160ms var(--ease); }
.chat-toast.out { grid-template-rows:0fr; margin-bottom:0; opacity:0; transform:translateX(8px); pointer-events:none; }
.ct-inner { min-height:0; overflow:hidden; }
.ct-box { background:var(--bg); color:var(--fg); border:1px solid var(--border-strong); font:14px/1.45 var(--sans); -webkit-font-smoothing:antialiased; }
.ct-body { display:grid; grid-template-columns:24px 1fr; gap:0 10px; width:100%; padding:12px 12px 8px; text-align:left; transition:background 150ms var(--ease); }
.ct-body:hover { background:var(--surface-hover); }
.ct-body .text { grid-column:2; display:-webkit-box; -webkit-line-clamp:3; -webkit-box-orient:vertical; overflow:hidden; }
.ct-reply { padding:0 12px 12px 46px; }
.ct-reply .field { font-size:13px; padding:6px 8px; }
@keyframes toast-in { from { opacity:0; transform:translateY(-6px); } }
.toast { position:fixed; left:50%; bottom:24px; transform:translateX(-50%); background:var(--fg); color:var(--bg); font:500 13px var(--sans); padding:8px 14px; z-index:2147483647; }

@media (prefers-reduced-motion: reduce) {
  .panel, .chat-toast { transition:none; animation:none; }
  @keyframes rise { 0% { opacity:0; } 15% { opacity:1; } 85% { opacity:1; } 100% { opacity:0; } }
}
`;
