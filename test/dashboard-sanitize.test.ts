import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createSafeWysiwygPlugin,
  DASHBOARD_SAFE_HTML_ATTRIBUTES,
  DASHBOARD_SAFE_HTML_TAGS,
  renderSafeImage,
  renderSafeLink,
  safeHref,
} from "../web/dashboard/sanitize.ts";

class FakeElement {
  readonly tagName: string;
  className = "";
  textContent = "";
  private readonly values = new Map<string, string>();

  constructor(tagName: string) {
    this.tagName = tagName;
  }

  getAttribute(name: string): string | null {
    return this.values.get(name) ?? null;
  }

  removeAttribute(name: string): void {
    this.values.delete(name);
  }

  setAttribute(name: string, value: string): void {
    this.values.set(name, value);
  }
}

class FakeDocument {
  createElement(tagName: string): FakeElement {
    return new FakeElement(tagName);
  }
}

class FakePlugin {
  readonly spec: FakePluginSpec;

  constructor(spec: FakePluginSpec) {
    this.spec = spec;
  }
}

interface FakePluginSpec {
  props: {
    markViews: Record<
      string,
      (mark: { attrs: Record<string, unknown> }) => {
        contentDOM?: FakeViewElement;
        dom: FakeViewElement;
      }
    >;
  };
}

interface FakeViewElement {
  className: string;
  textContent: string | null;
  removeAttribute(name: string): void;
  setAttribute(name: string, value: string): void;
}

function safePlugin() {
  const plugin = createSafeWysiwygPlugin(new FakeDocument())({
    pmState: { Plugin: FakePlugin },
  });
  assert.ok(plugin);
  const markPlugin = plugin.wysiwygPlugins?.[0]?.() as FakePlugin;
  assert.ok(markPlugin);
  return {
    markViews: markPlugin.spec.props.markViews as Record<
      string,
      (mark: { attrs: Record<string, unknown> }) => { contentDOM?: FakeElement; dom: FakeElement }
    >,
    nodeViews: plugin.wysiwygNodeViews ?? {},
  };
}

test("dashboard HTML policy allows Markdown structure without loading or activation surfaces", () => {
  for (const tag of [
    "a",
    "blockquote",
    "code",
    "h1",
    "li",
    "ol",
    "pre",
    "table",
    "tbody",
    "td",
    "th",
    "thead",
    "tr",
    "ul",
  ]) {
    assert.ok(DASHBOARD_SAFE_HTML_TAGS.includes(tag), `${tag} should be allowed`);
  }
  for (const tag of [
    "audio",
    "button",
    "form",
    "iframe",
    "img",
    "input",
    "link",
    "meta",
    "script",
    "style",
    "svg",
    "video",
  ]) {
    assert.equal(DASHBOARD_SAFE_HTML_TAGS.includes(tag), false, `${tag} should be excluded`);
  }
  for (const attribute of ["class", "data-task", "data-task-checked", "id", "name", "src", "srcset", "style"]) {
    assert.equal(DASHBOARD_SAFE_HTML_ATTRIBUTES.includes(attribute), false, `${attribute} should be excluded`);
  }
  for (const attribute of ["href", "colspan", "rowspan", "start"]) {
    assert.ok(DASHBOARD_SAFE_HTML_ATTRIBUTES.includes(attribute), `${attribute} should be allowed`);
  }
});

test("dashboard renderer keeps safe links and removes unsafe hrefs", () => {
  for (const href of [
    "https://example.com",
    "http://example.com",
    "mailto:test@example.com",
    "/docs",
    "./x",
    "../x",
    "#x",
    "?x",
    "readme.md",
  ]) {
    assert.equal(safeHref(href), href);
  }
  for (const href of [
    "javascript:alert(1)",
    "data:text/html,x",
    "vbscript:x",
    "//attacker.example/x",
    "/\\attacker.example/x",
    "https ://x",
  ]) {
    assert.equal(safeHref(href), null);
  }

  const unsafe = renderSafeLink(
    { destination: "javascript:alert(1)" },
    { entering: true, getChildrenText: () => "unsafe", skipChildren: () => undefined },
  );
  assert.deepEqual(unsafe, { type: "openTag", tagName: "span" });

  const safe = renderSafeLink(
    { destination: "/guide" },
    { entering: true, getChildrenText: () => "guide", skipChildren: () => undefined },
  );
  assert.deepEqual(safe, {
    type: "openTag",
    tagName: "a",
    attributes: { href: "/guide", rel: "noopener noreferrer", target: "_blank" },
  });
});

test("dashboard renderer replaces Markdown images with inert alt text", () => {
  let skipped = false;
  const token = renderSafeImage(
    { destination: "https://attacker.invalid/tracker.png", firstChild: { literal: "remote" } },
    {
      entering: true,
      getChildrenText: () => "remote",
      skipChildren: () => {
        skipped = true;
      },
    },
  );
  assert.equal(skipped, true);
  assert.deepEqual(token, { type: "text", content: "[remote]" });
});

test("rich editor node views converge without loading images or changing source attributes", () => {
  const { nodeViews } = safePlugin();
  const attrs = { altText: " remote   tracker ", imageUrl: "https://attacker.invalid/tracker.png", rawHTML: "img" };
  const node = { attrs, type: { name: "image" } };
  const view = nodeViews.image?.(node);
  assert.ok(view);
  const dom = view.dom as unknown as FakeElement;

  assert.equal(dom.tagName, "span");
  assert.equal(dom.textContent, "[remote tracker]");
  assert.equal(dom.getAttribute("src"), null);
  assert.equal(dom.getAttribute("href"), null);
  assert.equal(view.update?.(node), true);
  assert.equal(view.update?.(node), true);
  assert.equal(dom.textContent, "[remote tracker]");
  assert.deepEqual(attrs, {
    altText: " remote   tracker ",
    imageUrl: "https://attacker.invalid/tracker.png",
    rawHTML: "img",
  });
});

test("rich editor link views keep unsafe and raw HTML destinations inert while preserving source attributes", () => {
  const { markViews } = safePlugin();
  const unsafeAttrs = { linkUrl: "javascript:alert(1)", title: "source title" };
  const unsafe = markViews.link?.({ attrs: unsafeAttrs });
  assert.ok(unsafe);
  assert.equal(unsafe.dom.tagName, "span");
  assert.equal(unsafe.dom.getAttribute("href"), null);
  assert.deepEqual(unsafeAttrs, { linkUrl: "javascript:alert(1)", title: "source title" });

  const rawAttrs = { linkUrl: "https://example.com/safe", rawHTML: "a", title: "raw source title" };
  const raw = markViews.link?.({ attrs: rawAttrs });
  assert.ok(raw);
  assert.equal(raw.dom.tagName, "span");
  assert.equal(raw.dom.getAttribute("href"), null);
  assert.equal(raw.contentDOM, raw.dom);
  assert.deepEqual(rawAttrs, { linkUrl: "https://example.com/safe", rawHTML: "a", title: "raw source title" });

  const safeAttrs = { linkUrl: " https://example.com/path " };
  const safe = markViews.link?.({ attrs: safeAttrs });
  assert.ok(safe);
  assert.equal(safe.dom.tagName, "a");
  assert.equal(safe.dom.getAttribute("href"), "https://example.com/path");
  assert.equal(safe.dom.getAttribute("rel"), "noopener noreferrer");
  assert.equal(safe.dom.getAttribute("target"), "_blank");
  assert.deepEqual(safeAttrs, { linkUrl: " https://example.com/path " });
});

test("rich editor list item views keep raw HTML tasks inert and source attributes unchanged", () => {
  const { nodeViews } = safePlugin();
  const attrs = { task: true, checked: true, rawHTML: "li" };
  const node = { attrs, type: { name: "listItem" } };
  const view = nodeViews.listItem?.(node);
  assert.ok(view);
  const dom = view.dom as FakeElement;

  assert.equal(view.contentDOM, dom);
  assert.equal(dom.tagName, "li");
  assert.equal(dom.className, "");
  assert.equal(dom.getAttribute("data-task"), null);
  assert.equal(dom.getAttribute("data-task-checked"), null);
  assert.equal(view.update?.(node), true);
  assert.deepEqual(attrs, { task: true, checked: true, rawHTML: "li" });
});

test("rich editor list item views preserve ordinary Markdown tasks and converge across updates", () => {
  const { nodeViews } = safePlugin();
  const attrs = { task: true, checked: false, rawHTML: null };
  const view = nodeViews.listItem?.({ attrs, type: { name: "listItem" } });
  assert.ok(view);
  const dom = view.dom as FakeElement;

  assert.equal(view.contentDOM, dom);
  assert.equal(dom.className, "task-list-item");
  assert.equal(dom.getAttribute("data-task"), "true");
  assert.equal(dom.getAttribute("data-task-checked"), null);

  const checkedAttrs = { task: true, checked: true, rawHTML: null };
  const checked = { attrs: checkedAttrs, type: { name: "listItem" } };
  assert.equal(view.update?.(checked), true);
  assert.equal(view.update?.(checked), true);
  assert.equal(dom.className, "task-list-item checked");
  assert.equal(dom.getAttribute("data-task"), "true");
  assert.equal(dom.getAttribute("data-task-checked"), "true");

  const rawAttrs = { task: true, checked: true, rawHTML: "li" };
  const raw = { attrs: rawAttrs, type: { name: "listItem" } };
  assert.equal(view.update?.(raw), true);
  assert.equal(view.update?.(raw), true);
  assert.equal(dom.className, "");
  assert.equal(dom.getAttribute("data-task"), null);
  assert.equal(dom.getAttribute("data-task-checked"), null);

  assert.equal(view.update?.({ attrs, type: { name: "listItem" } }), true);
  assert.equal(dom.className, "task-list-item");
  assert.equal(dom.getAttribute("data-task"), "true");
  assert.deepEqual(attrs, { task: true, checked: false, rawHTML: null });
  assert.deepEqual(checkedAttrs, { task: true, checked: true, rawHTML: null });
  assert.deepEqual(rawAttrs, { task: true, checked: true, rawHTML: "li" });
  assert.equal(view.update?.({ attrs: {}, type: { name: "paragraph" } }), false);
});
