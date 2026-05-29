/** The dashboard SPA, inlined so it ships with the compiled output (no asset-copy step). */

export const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Weaver</title>
<style>
  :root {
    --bg: #0e1116; --panel: #161b22; --line: #232b36; --fg: #e6edf3;
    --dim: #8b949e; --accent: #4cc4b0; --warn: #e3b341; --pin: #d29922;
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--fg); font-size: 13px; }
  header {
    display: flex; align-items: baseline; gap: 12px; padding: 14px 18px;
    border-bottom: 1px solid var(--line); position: sticky; top: 0; background: var(--bg);
  }
  header h1 { margin: 0; font-size: 15px; letter-spacing: .5px; }
  header .repo { color: var(--dim); }
  header .status { margin-left: auto; color: var(--dim); }
  header .dot { color: var(--accent); }
  main { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; padding: 16px 18px; }
  section { background: var(--panel); border: 1px solid var(--line); border-radius: 8px; padding: 12px 14px; }
  section h2 { margin: 0 0 10px; font-size: 11px; text-transform: uppercase; letter-spacing: 1px; color: var(--dim); }
  .span2 { grid-column: 1 / -1; }
  .empty { color: var(--dim); font-style: italic; }
  .card { padding: 8px 0; border-top: 1px solid var(--line); }
  .card:first-of-type { border-top: 0; }
  .row { display: flex; gap: 8px; align-items: baseline; }
  .who { color: var(--accent); font-weight: 600; }
  .ago { color: var(--dim); margin-left: auto; white-space: nowrap; }
  .intent { color: var(--fg); }
  .meta { color: var(--dim); }
  .pat { color: var(--warn); }
  .kind { color: var(--accent); }
  .pin { color: var(--pin); }
  .feed div { padding: 3px 0; color: var(--dim); }
  .feed .t { color: var(--fg); }
  code { color: var(--fg); }
</style>
</head>
<body>
<header>
  <h1>🧵 Weaver</h1>
  <span class="repo" id="repo"></span>
  <span class="status"><span class="dot" id="dot">●</span> <span id="conn">connecting…</span></span>
</header>
<main>
  <section><h2>Active sessions</h2><div id="sessions" class="empty">—</div></section>
  <section><h2>Claims</h2><div id="claims" class="empty">—</div></section>
  <section class="span2"><h2>Activity</h2><div id="activity" class="feed empty">—</div></section>
  <section class="span2"><h2>Notes</h2><div id="notes" class="empty">—</div></section>
</main>
<script>
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? "").replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
  function ago(ms) {
    const s = Math.max(0, Math.round(ms / 1000));
    if (s < 60) return s + "s ago";
    const m = Math.round(s / 60); if (m < 60) return m + "m ago";
    const h = Math.round(m / 60); if (h < 24) return h + "h ago";
    return Math.round(h / 24) + "d ago";
  }
  function render(d) {
    $("repo").textContent = "repo " + d.repo;
    const sessions = d.sessions || [];
    $("sessions").className = sessions.length ? "" : "empty";
    $("sessions").innerHTML = sessions.length ? sessions.map((s) =>
      '<div class="card"><div class="row"><span class="who">' + esc(s.harness) + '</span>' +
      '<span class="ago">' + ago(s.lastSeenMsAgo) + '</span></div>' +
      '<div class="intent">' + esc(s.intent || "(no stated intent)") + '</div>' +
      '<div class="meta">' + esc(s.source) + '</div></div>').join("") : "no active sessions";

    const claims = d.claims || [];
    $("claims").className = claims.length ? "" : "empty";
    $("claims").innerHTML = claims.length ? claims.map((c) =>
      '<div class="card"><div class="row"><span class="pat">' + esc(c.pattern) + '</span>' +
      '<span class="ago">' + ago(c.createdMsAgo) + '</span></div>' +
      '<div class="meta">' + esc(c.by || "?") + (c.reason ? " — " + esc(c.reason) : "") + '</div></div>').join("") : "no active claims";

    const act = d.recentActivity || [];
    $("activity").className = act.length ? "feed" : "feed empty";
    $("activity").innerHTML = act.length ? act.map((a) =>
      '<div><span class="ago" style="float:right">' + ago(a.tsMsAgo) + '</span>' +
      '<span class="kind">' + esc(a.kind) + '</span> ' + esc(a.by || "?") + " " +
      '<code>' + esc(a.target || "") + '</code>' + (a.summary ? ' <span class="t">— ' + esc(a.summary) + "</span>" : "") + "</div>").join("") : "no activity yet";

    const notes = d.notes || [];
    $("notes").className = notes.length ? "" : "empty";
    $("notes").innerHTML = notes.length ? notes.map((n) =>
      '<div class="card">' + (n.pinned ? '<span class="pin">📌 </span>' : "") + esc(n.body) +
      (n.path ? ' <code>[' + esc(n.path) + "]</code>" : "") + "</div>").join("") : "no notes yet";
  }
  const ev = new EventSource("/events");
  ev.onmessage = (e) => { $("conn").textContent = "live"; $("dot").style.color = "var(--accent)"; render(JSON.parse(e.data)); };
  ev.onerror = () => { $("conn").textContent = "reconnecting…"; $("dot").style.color = "var(--warn)"; };
</script>
</body>
</html>`;
