import Editor from "@toast-ui/editor";
import "@toast-ui/editor/dist/toastui-editor.css";
import "@toast-ui/editor/dist/theme/toastui-editor-dark.css";
import DOMPurify from "dompurify";
import "./app.css";
import { canApplyLifecycleResult, type LifecycleGuard, sameLifecycleState, sameLifecycleTarget } from "./lifecycle.ts";
import {
  createSafeWysiwygPlugin,
  DASHBOARD_SAFE_HTML_ATTRIBUTES,
  DASHBOARD_SAFE_HTML_TAGS,
  renderSafeImage,
  renderSafeLink,
  safeHref,
} from "./sanitize.ts";

type PadState = "active" | "archived" | "trash";
type Theme = "dark" | "light";

const THEME_STORAGE_KEY = "weaver-dashboard-theme";

function readTheme(): Theme {
  try {
    const stored = window.localStorage.getItem(THEME_STORAGE_KEY);
    return stored === "dark" || stored === "light" ? stored : "dark";
  } catch {
    return "dark";
  }
}

let currentTheme = readTheme();
document.documentElement.dataset.theme = currentTheme;

interface PadSummary {
  id: number;
  title: string;
  state: PadState;
  previousState: PadState | null;
  revision: number;
  createdAt: number;
  updatedAt: number;
}

interface Pad extends PadSummary {
  body: string;
}

interface Attachment {
  id: number;
  scratchpadId: number;
  sessionId: string;
  worktreeId: string;
  attachedAt: number;
}

interface Claim {
  id: number;
  scratchpadId: number | null;
  sessionId: string;
  pattern: string;
  reason: string | null;
  worktreeId?: string | null;
}

interface Activity {
  id: number;
  scratchpadId: number | null;
  sessionId: string;
  kind: string;
  summary: string | null;
  ts: number;
}

interface Session {
  id: string;
  harness: string;
  intent: string | null;
}

interface Fact {
  id: number;
  body: string;
  path: string | null;
  pinned: boolean;
}

interface Revision {
  id: number;
  revision: number;
  action: string;
  actorHarness: string | null;
  actorKind: string;
  createdAt: number;
  reason: string | null;
}

interface Snapshot {
  repo: string;
  now: number;
  pads: PadSummary[];
  sessions: Session[];
  attachments: Attachment[];
  claims: Claim[];
  activity: Activity[];
  facts: Fact[];
}

interface Detail {
  pad: Pad;
  attachments: Attachment[];
  claims: Claim[];
  activity: Activity[];
  history: Revision[];
}

interface ApiErrorBody {
  error?: string;
  message?: string;
  actualRevision?: number;
}

class ApiError extends Error {
  readonly status: number;
  readonly body: ApiErrorBody;

  constructor(status: number, body: ApiErrorBody) {
    super(body.message ?? body.error ?? `request failed (${status})`);
    this.status = status;
    this.body = body;
  }
}

const hash = new URLSearchParams(location.hash.slice(1));
const capability = hash.get("cap");
history.replaceState(null, "", `${location.pathname}${location.search}`);

const root = document.querySelector<HTMLElement>("#app");
if (!root) throw new Error("dashboard root is missing");

root.innerHTML = `
  <header class="topbar">
    <div><span class="mark">W</span><strong>Scratchpads</strong><span id="repo" class="repo"></span></div>
    <div class="global-controls">
      <label class="theme-control" for="theme"><span>Theme</span><select id="theme" aria-label="Dashboard theme"><option value="dark">Dark</option><option value="light">Light</option></select></label>
      <div class="connection"><span id="connection-dot" class="dot"></span><span id="connection">connecting</span></div>
    </div>
  </header>
  <main class="workspace">
    <aside class="library">
      <div class="library-head"><h1>Scratchpads</h1><button id="create" class="primary" type="button">New</button></div>
      <label class="search"><span>Search</span><input id="search" type="search" placeholder="Title or Markdown…" autocomplete="off"></label>
      <div id="tabs" class="tabs" role="tablist">
        <button type="button" data-state="active" class="selected">Active <span id="active-count">0</span></button>
        <button type="button" data-state="archived">Archived <span id="archived-count">0</span></button>
        <button type="button" data-state="trash">Trash <span id="trash-count">0</span></button>
      </div>
      <div id="pad-list" class="pad-list"></div>
    </aside>
    <section class="document">
      <div id="empty" class="empty-state"><strong>No scratchpad selected</strong><span>Create one or choose one from the library.</span></div>
      <div id="document-body" hidden>
        <div class="document-head">
          <input id="title" class="title" maxlength="200" aria-label="Scratchpad title">
          <div class="document-actions">
            <span id="save-state" class="save-state"></span>
            <button id="undo" type="button" title="Undo">Undo</button>
            <button id="redo" type="button" title="Redo">Redo</button>
            <button id="source" type="button">Source</button>
            <button id="lifecycle" type="button"></button>
            <button id="trash" class="danger" type="button">Trash</button>
          </div>
        </div>
        <div id="conflict" class="conflict" hidden>
          <div><strong>Revision conflict.</strong> Your local draft is preserved and autosave is paused.</div>
          <div><button id="copy-draft" type="button">Copy draft</button><button id="reload" type="button">Reload remote</button></div>
        </div>
        <div id="editor" class="editor"></div>
      </div>
    </section>
    <aside class="context">
      <section><h2>Attached agents</h2><div id="agents" class="stack muted">Select a scratchpad</div></section>
      <section><h2>Claims</h2><div id="claims" class="stack muted">Select a scratchpad</div></section>
      <section><h2>Recent pad activity</h2><div id="activity" class="stack muted">Select a scratchpad</div></section>
      <section><h2>Revision history</h2><div id="history" class="stack muted">Select a scratchpad</div></section>
      <section><h2>Repository Facts</h2><div id="facts" class="stack muted">No facts yet</div></section>
    </aside>
  </main>`;

function byId<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`missing element #${id}`);
  return element as T;
}

const repo = byId<HTMLSpanElement>("repo");
const connection = byId<HTMLSpanElement>("connection");
const connectionDot = byId<HTMLSpanElement>("connection-dot");
const themeSelect = byId<HTMLSelectElement>("theme");
const list = byId<HTMLDivElement>("pad-list");
const search = byId<HTMLInputElement>("search");
const title = byId<HTMLInputElement>("title");
const saveState = byId<HTMLSpanElement>("save-state");
const empty = byId<HTMLDivElement>("empty");
const documentBody = byId<HTMLDivElement>("document-body");
const conflictBox = byId<HTMLDivElement>("conflict");
const editorElement = byId<HTMLDivElement>("editor");
const lifecycleButton = byId<HTMLButtonElement>("lifecycle");
const trashButton = byId<HTMLButtonElement>("trash");
const sourceButton = byId<HTMLButtonElement>("source");

function safeHtml(input: string): string {
  const cleaned = DOMPurify.sanitize(input, {
    ALLOW_ARIA_ATTR: false,
    ALLOW_DATA_ATTR: false,
    ALLOWED_ATTR: DASHBOARD_SAFE_HTML_ATTRIBUTES,
    ALLOWED_TAGS: DASHBOARD_SAFE_HTML_TAGS,
    RETURN_TRUSTED_TYPE: false,
  });
  const template = document.createElement("template");
  template.innerHTML = String(cleaned);
  for (const anchor of template.content.querySelectorAll("a")) {
    const href = safeHref(anchor.getAttribute("href") ?? "");
    if (href) anchor.setAttribute("href", href);
    else anchor.removeAttribute("href");
    anchor.setAttribute("rel", "noopener noreferrer");
    anchor.setAttribute("target", "_blank");
  }
  return template.innerHTML;
}

const editor = new Editor({
  el: editorElement,
  height: "100%",
  hideModeSwitch: true,
  initialEditType: "wysiwyg",
  initialValue: "",
  linkAttributes: { rel: "noopener noreferrer", target: "_blank" },
  customHTMLRenderer: {
    image: renderSafeImage,
    link: renderSafeLink,
  },
  plugins: [createSafeWysiwygPlugin(document)],
  previewStyle: "vertical",
  toolbarItems: [
    ["heading", "bold", "italic", "strike"],
    ["quote", "ul", "ol", "task", "indent", "outdent"],
    ["table", "link", "code", "codeblock"],
  ],
  theme: currentTheme,
  usageStatistics: false,
  customHTMLSanitizer: safeHtml,
});

function applyTheme(theme: Theme, persist: boolean): void {
  currentTheme = theme;
  document.documentElement.dataset.theme = theme;
  themeSelect.value = theme;
  editorElement.classList.toggle("toastui-editor-dark", theme === "dark");
  editorElement.querySelector(".toastui-editor-defaultUI")?.classList.toggle("toastui-editor-dark", theme === "dark");
  if (persist) {
    try {
      window.localStorage.setItem(THEME_STORAGE_KEY, theme);
    } catch {
      // The selected theme still applies for this session when storage is unavailable.
    }
  }
}

applyTheme(currentTheme, false);

let snapshot: Snapshot | null = null;
let visiblePads: PadSummary[] = [];
let selectedId: number | null = null;
let detail: Detail | null = null;
let base: Pad | null = null;
let selectedState: PadState = "active";
let sourceMode = false;
let applying = false;
let conflicted = false;
let saving = false;
let saveTimer: number | undefined;
let searchTimer: number | undefined;
let searchSequence = 0;
let selectionGeneration = 0;
let bodyEdited = false;
let pendingUserEdit = false;

async function api<T>(pathname: string, init: RequestInit = {}): Promise<T> {
  if (!capability) throw new ApiError(401, { error: "missing_capability" });
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${capability}`);
  if (init.body !== undefined) headers.set("content-type", "application/json");
  const response = await fetch(pathname, { ...init, cache: "no-store", headers });
  const body = (await response.json()) as T & ApiErrorBody;
  if (!response.ok) throw new ApiError(response.status, body);
  return body;
}

function textRow(parent: HTMLElement, primary: string, secondary?: string): void {
  const row = document.createElement("div");
  row.className = "context-row";
  const strong = document.createElement("strong");
  strong.textContent = primary;
  row.append(strong);
  if (secondary) {
    const span = document.createElement("span");
    span.textContent = secondary;
    row.append(span);
  }
  parent.append(row);
}

function ago(timestamp: number): string {
  const seconds = Math.max(0, Math.round((Date.now() - timestamp) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  return hours < 24 ? `${hours}h ago` : `${Math.round(hours / 24)}d ago`;
}

function renderFacts(): void {
  const container = byId<HTMLDivElement>("facts");
  container.replaceChildren();
  const facts = snapshot?.facts ?? [];
  container.classList.toggle("muted", facts.length === 0);
  if (!facts.length) {
    container.textContent = "No facts yet";
    return;
  }
  for (const fact of facts.slice(0, 12))
    textRow(container, `${fact.pinned ? "Pinned · " : ""}${fact.body}`, fact.path ?? undefined);
}

function renderContext(): void {
  const agents = byId<HTMLDivElement>("agents");
  const claims = byId<HTMLDivElement>("claims");
  const activity = byId<HTMLDivElement>("activity");
  const history = byId<HTMLDivElement>("history");
  for (const element of [agents, claims, activity, history]) element.replaceChildren();
  if (!detail || !snapshot) {
    for (const element of [agents, claims, activity, history]) {
      element.classList.add("muted");
      element.textContent = "Select a scratchpad";
    }
    return;
  }

  const sessions = new Map(snapshot.sessions.map((session) => [session.id, session]));
  agents.classList.toggle("muted", detail.attachments.length === 0);
  if (!detail.attachments.length) agents.textContent = "No attached agents";
  for (const attachment of detail.attachments) {
    const session = sessions.get(attachment.sessionId);
    textRow(agents, session?.harness ?? attachment.sessionId, session?.intent ?? attachment.worktreeId);
  }

  claims.classList.toggle("muted", detail.claims.length === 0);
  if (!detail.claims.length) claims.textContent = "No claims for this pad";
  for (const claim of detail.claims) textRow(claims, claim.pattern, claim.reason ?? claim.worktreeId ?? undefined);

  activity.classList.toggle("muted", detail.activity.length === 0);
  if (!detail.activity.length) activity.textContent = "No recent activity";
  for (const event of detail.activity.slice(0, 12)) {
    textRow(
      activity,
      event.summary ?? event.kind,
      `${sessions.get(event.sessionId)?.harness ?? event.sessionId} · ${ago(event.ts)}`,
    );
  }

  history.classList.toggle("muted", detail.history.length === 0);
  if (!detail.history.length) history.textContent = "No revisions";
  for (const revision of detail.history.slice(0, 12)) {
    textRow(
      history,
      `r${revision.revision} · ${revision.action}`,
      `${revision.actorHarness ?? revision.actorKind} · ${ago(revision.createdAt)}`,
    );
  }
}

function renderCounts(): void {
  const pads = snapshot?.pads ?? [];
  for (const state of ["active", "archived", "trash"] as const) {
    byId<HTMLSpanElement>(`${state}-count`).textContent = String(pads.filter((pad) => pad.state === state).length);
  }
}

function renderList(): void {
  list.replaceChildren();
  list.classList.remove("muted");
  const pads = visiblePads.filter((pad) => pad.state === selectedState);
  if (!pads.length) {
    const message = document.createElement("p");
    message.className = "list-empty";
    message.textContent = search.value.trim() ? "No matching scratchpads" : `No ${selectedState} scratchpads`;
    list.append(message);
    return;
  }
  for (const pad of pads) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `pad${pad.id === selectedId ? " selected" : ""}`;
    const heading = document.createElement("strong");
    heading.textContent = pad.title;
    const meta = document.createElement("span");
    meta.textContent = `r${pad.revision} · ${ago(pad.updatedAt)}`;
    button.append(heading, meta);
    button.addEventListener("click", () => void selectPad(pad.id));
    list.append(button);
  }
}

function currentBody(): string {
  return !bodyEdited && base ? base.body : editor.getMarkdown();
}

function localDirty(): boolean {
  return Boolean(base && (title.value !== base.title || currentBody() !== base.body));
}

function hasDraftToDiscard(): boolean {
  return localDirty() || conflicted;
}

function abandonPendingSave(): number {
  window.clearTimeout(saveTimer);
  saveTimer = undefined;
  return ++selectionGeneration;
}

function setSaveState(value: string, state = ""): void {
  saveState.textContent = value;
  saveState.className = `save-state ${state}`;
}

function setReadOnly(readOnly: boolean): void {
  editorElement.classList.toggle("read-only", readOnly);
  title.disabled = readOnly;
  sourceButton.disabled = readOnly;
  byId<HTMLButtonElement>("undo").disabled = readOnly;
  byId<HTMLButtonElement>("redo").disabled = readOnly;
  if (readOnly) editor.blur();
}

function renderDocumentState(): void {
  const pad = detail?.pad;
  if (!pad) return;
  const active = pad.state === "active";
  setReadOnly(!active || conflicted);
  conflictBox.hidden = !conflicted;
  trashButton.hidden = pad.state === "trash";
  lifecycleButton.textContent = pad.state === "active" ? "Archive" : pad.state === "archived" ? "Restore" : "Recover";
  if (!active) setSaveState(`${pad.state} · r${pad.revision}`);
}

function applyDetail(next: Detail): void {
  applying = true;
  detail = next;
  base = { ...next.pad };
  selectedId = next.pad.id;
  title.value = next.pad.title;
  editor.setMarkdown(next.pad.body, false);
  bodyEdited = false;
  pendingUserEdit = false;
  applying = false;
  conflicted = false;
  saving = false;
  empty.hidden = true;
  documentBody.hidden = false;
  setSaveState(`Saved · r${next.pad.revision}`, "saved");
  renderDocumentState();
  renderList();
  renderContext();
}

async function selectPad(id: number): Promise<void> {
  if (id === selectedId && detail) return;
  if (hasDraftToDiscard() && !window.confirm("Discard the unsaved local draft and open another scratchpad?")) return;
  const generation = abandonPendingSave();
  try {
    const next = await api<Detail>(`/api/scratchpads/${id}`);
    if (generation === selectionGeneration) applyDetail(next);
  } catch (error) {
    if (generation === selectionGeneration)
      setSaveState(error instanceof Error ? error.message : "Could not open scratchpad", "error");
  }
}

async function refreshSearch(): Promise<void> {
  const sequence = ++searchSequence;
  const query = search.value.trim();
  if (!query) {
    visiblePads = snapshot?.pads ?? [];
    renderList();
    return;
  }
  try {
    const result = await api<{ pads: PadSummary[] }>(`/api/scratchpads?state=all&q=${encodeURIComponent(query)}`);
    if (sequence === searchSequence) {
      visiblePads = result.pads;
      renderList();
    }
  } catch {
    if (sequence === searchSequence) {
      list.textContent = "Search unavailable";
      list.classList.add("muted");
    }
  }
}

function scheduleSave(): void {
  if (applying || conflicted || detail?.pad.state !== "active") return;
  window.clearTimeout(saveTimer);
  if (!localDirty()) {
    setSaveState(`Saved · r${base?.revision ?? detail.pad.revision}`, "saved");
    return;
  }
  setSaveState("Unsaved", "dirty");
  const padId = base?.id;
  const generation = selectionGeneration;
  saveTimer = window.setTimeout(() => {
    saveTimer = undefined;
    if (generation !== selectionGeneration || padId === undefined || selectedId !== padId || base?.id !== padId) return;
    void save(generation, padId);
  }, 700);
}

async function save(expectedGeneration = selectionGeneration, expectedPadId = base?.id): Promise<boolean> {
  if (!base || !detail || conflicted || saving || detail.pad.state !== "active") return false;
  if (expectedGeneration !== selectionGeneration || expectedPadId !== base.id || selectedId !== base.id) return false;
  const draft = { title: title.value, body: currentBody() };
  const padId = base.id;
  const generation = selectionGeneration;
  if (draft.title === base.title && draft.body === base.body) return true;
  saving = true;
  setSaveState("Saving…", "saving");
  try {
    const result = await api<{ pad: Pad; changed: boolean }>(`/api/scratchpads/${base.id}`, {
      method: "PUT",
      body: JSON.stringify({ ...draft, expectedRevision: base.revision }),
    });
    if (generation !== selectionGeneration || selectedId !== padId || detail.pad.id !== padId) {
      saving = false;
      return true;
    }
    base = { ...result.pad };
    detail.pad = result.pad;
    saving = false;
    conflicted = false;
    renderDocumentState();
    renderList();
    if (title.value === draft.title && currentBody() === draft.body) {
      setSaveState(`Saved · r${result.pad.revision}`, "saved");
    } else {
      scheduleSave();
    }
    void api<{ history: Revision[] }>(`/api/scratchpads/${result.pad.id}/history`)
      .then((historyResult) => {
        if (detail?.pad.id === result.pad.id && detail.pad.revision === result.pad.revision) {
          detail.history = historyResult.history;
          renderContext();
        }
      })
      .catch(() => undefined);
    return true;
  } catch (error) {
    if (generation !== selectionGeneration || selectedId !== padId) {
      saving = false;
      return false;
    }
    saving = false;
    if (error instanceof ApiError && error.status === 409) {
      conflicted = true;
      conflictBox.hidden = false;
      setSaveState(`Conflict · remote r${error.body.actualRevision ?? "?"}`, "error");
      renderDocumentState();
    } else {
      setSaveState(error instanceof Error ? error.message : "Save failed", "error");
    }
    return false;
  }
}

async function createPad(): Promise<void> {
  if (hasDraftToDiscard() && !window.confirm("Discard the unsaved local draft and create a new scratchpad?")) return;
  const generation = abandonPendingSave();
  try {
    const result = await api<{ pad: Pad }>("/api/scratchpads", {
      method: "POST",
      body: JSON.stringify({ title: "Untitled scratchpad", body: "" }),
    });
    if (generation !== selectionGeneration) return;
    selectedState = "active";
    search.value = "";
    const next = await api<Detail>(`/api/scratchpads/${result.pad.id}`);
    if (generation !== selectionGeneration) return;
    applyDetail(next);
    await refreshSnapshot();
    title.focus();
    title.select();
  } catch (error) {
    if (generation === selectionGeneration)
      setSaveState(error instanceof Error ? error.message : "Create failed", "error");
  }
}

function captureLifecycleGuard(): LifecycleGuard | null {
  if (!base || selectedId !== base.id) return null;
  return {
    padId: base.id,
    revision: base.revision,
    generation: selectionGeneration,
    title: title.value,
    body: currentBody(),
    conflicted,
  };
}

async function lifecycle(action: "archive" | "restore" | "trash" | "recover"): Promise<void> {
  const initiating = captureLifecycleGuard();
  if (!initiating || !detail || initiating.conflicted) return;
  if (localDirty() && !(await save(initiating.generation, initiating.padId))) return;
  if (!sameLifecycleTarget(initiating, captureLifecycleGuard()) || conflicted || localDirty()) return;
  if (action === "trash" && !window.confirm("Move this scratchpad to trash?")) return;
  const actionGuard = captureLifecycleGuard();
  if (!actionGuard) return;
  try {
    const result = await api<{ pad: Pad }>(`/api/scratchpads/${actionGuard.padId}/${action}`, {
      method: "POST",
      body: JSON.stringify({
        expectedRevision: actionGuard.revision,
        reason: action === "trash" ? "dashboard human action" : undefined,
      }),
    });
    if (!canApplyLifecycleResult(actionGuard, captureLifecycleGuard())) return;
    const next = await api<Detail>(`/api/scratchpads/${result.pad.id}`);
    if (!canApplyLifecycleResult(actionGuard, captureLifecycleGuard())) return;
    applyDetail(next);
    await refreshSnapshot();
  } catch (error) {
    if (sameLifecycleTarget(actionGuard, captureLifecycleGuard())) {
      setSaveState(error instanceof Error ? error.message : `${action} failed`, "error");
    }
  }
}

async function refreshSnapshot(): Promise<void> {
  applySnapshot(await api<Snapshot>("/api/snapshot"));
}

function applySnapshot(next: Snapshot): void {
  snapshot = next;
  repo.textContent = next.repo;
  renderCounts();
  renderFacts();
  if (!search.value.trim()) visiblePads = next.pads;
  renderList();
  if (selectedId === null) {
    const first = next.pads.find((pad) => pad.state === selectedState) ?? next.pads[0];
    if (first) void selectPad(first.id);
    return;
  }
  const remote = next.pads.find((pad) => pad.id === selectedId);
  if (!remote) return;
  if (detail) {
    detail.attachments = next.attachments.filter((attachment) => attachment.scratchpadId === selectedId);
    detail.claims = next.claims.filter((claim) => claim.scratchpadId === selectedId);
    detail.activity = next.activity.filter((event) => event.scratchpadId === selectedId).slice(0, 30);
    renderContext();
  }
  if (base && remote.revision > base.revision) {
    if (saving) {
      return;
    }
    if (localDirty()) {
      conflicted = true;
      setSaveState(`Conflict · remote r${remote.revision}`, "error");
      renderDocumentState();
    } else {
      const reloadGuard = captureLifecycleGuard();
      if (!reloadGuard) return;
      void api<Detail>(`/api/scratchpads/${remote.id}`)
        .then((next) => {
          if (canApplyLifecycleResult(reloadGuard, captureLifecycleGuard())) applyDetail(next);
        })
        .catch(() => undefined);
    }
  }
}

async function streamSnapshots(): Promise<void> {
  if (!capability) return;
  for (;;) {
    try {
      const response = await fetch("/api/events", {
        cache: "no-store",
        headers: { authorization: `Bearer ${capability}` },
      });
      if (!response.ok || !response.body) throw new Error("stream unavailable");
      connection.textContent = "live";
      connectionDot.classList.add("live");
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let pending = "";
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        pending += decoder.decode(chunk.value, { stream: true });
        const lines = pending.split("\n");
        pending = lines.pop() ?? "";
        for (const line of lines) if (line) applySnapshot(JSON.parse(line) as Snapshot);
      }
    } catch {
      connection.textContent = "reconnecting";
      connectionDot.classList.remove("live");
      await new Promise((resolve) => window.setTimeout(resolve, 1000));
    }
  }
}

editor.on("change", () => {
  if (pendingUserEdit) {
    bodyEdited = true;
    pendingUserEdit = false;
  }
  scheduleSave();
});
for (const eventName of ["beforeinput", "keydown", "paste", "drop"]) {
  editorElement.addEventListener(
    eventName,
    () => {
      pendingUserEdit = true;
      window.setTimeout(() => {
        pendingUserEdit = false;
      }, 0);
    },
    true,
  );
}
editorElement.addEventListener(
  "pointerdown",
  () => {
    pendingUserEdit = true;
    window.setTimeout(() => {
      pendingUserEdit = false;
    }, 0);
  },
  true,
);
editorElement.addEventListener(
  "click",
  (event) => {
    const anchor = (event.target as HTMLElement).closest<HTMLAnchorElement>(".toastui-editor-ww-container a");
    if (anchor && !safeHref(anchor.getAttribute("href") ?? "")) event.preventDefault();
  },
  true,
);
title.addEventListener("input", scheduleSave);
themeSelect.addEventListener("change", () => {
  applyTheme(themeSelect.value === "light" ? "light" : "dark", true);
});
search.addEventListener("input", () => {
  window.clearTimeout(searchTimer);
  searchTimer = window.setTimeout(() => void refreshSearch(), 250);
});
byId<HTMLButtonElement>("create").addEventListener("click", () => void createPad());
byId<HTMLDivElement>("tabs").addEventListener("click", (event) => {
  const button = (event.target as HTMLElement).closest<HTMLButtonElement>("button[data-state]");
  if (!button) return;
  selectedState = button.dataset.state as PadState;
  for (const candidate of document.querySelectorAll("#tabs button"))
    candidate.classList.toggle("selected", candidate === button);
  renderList();
});
byId<HTMLButtonElement>("undo").addEventListener("click", () => {
  pendingUserEdit = true;
  editor.exec("undo");
});
byId<HTMLButtonElement>("redo").addEventListener("click", () => {
  pendingUserEdit = true;
  editor.exec("redo");
});
sourceButton.addEventListener("click", () => {
  const pristineBody = currentBody();
  sourceMode = !sourceMode;
  applying = true;
  editor.changeMode(sourceMode ? "markdown" : "wysiwyg", true);
  if (!bodyEdited) editor.setMarkdown(pristineBody, false);
  applying = false;
  sourceButton.textContent = sourceMode ? "Rich text" : "Source";
  sourceButton.classList.toggle("active", sourceMode);
});
lifecycleButton.addEventListener("click", () => {
  if (!detail) return;
  const action = detail.pad.state === "active" ? "archive" : detail.pad.state === "archived" ? "restore" : "recover";
  void lifecycle(action);
});
trashButton.addEventListener("click", () => void lifecycle("trash"));
byId<HTMLButtonElement>("copy-draft").addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(currentBody());
    setSaveState("Draft copied", "saved");
  } catch {
    setSaveState("Clipboard unavailable", "error");
  }
});
byId<HTMLButtonElement>("reload").addEventListener("click", () => {
  if (!selectedId || !window.confirm("Discard the preserved local draft and load the remote revision?")) return;
  const reloadGuard = captureLifecycleGuard();
  if (!reloadGuard) return;
  void api<Detail>(`/api/scratchpads/${reloadGuard.padId}`)
    .then((next) => {
      if (sameLifecycleState(reloadGuard, captureLifecycleGuard())) applyDetail(next);
    })
    .catch(() => undefined);
});
document.addEventListener("keydown", (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
    event.preventDefault();
    void save();
  }
});

if (!capability) {
  connection.textContent = "locked";
  connectionDot.classList.remove("live");
  empty.innerHTML =
    "<strong>Launch capability missing</strong><span>Open this UI with <code>weaver scratchpads</code>.</span>";
} else {
  void refreshSnapshot().catch((error) => {
    empty.innerHTML = "";
    const strong = document.createElement("strong");
    strong.textContent = "Could not load scratchpads";
    const span = document.createElement("span");
    span.textContent = error instanceof Error ? error.message : "Unknown error";
    empty.append(strong, span);
  });
  void streamSnapshots();
}
