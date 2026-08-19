export type HtmlToken =
  | { type: "openTag" | "closeTag"; tagName: string; attributes?: Record<string, string> }
  | { type: "text"; content: string }
  | null;

export const DASHBOARD_SAFE_HTML_ATTRIBUTES = [
  "align",
  "colspan",
  "href",
  "rel",
  "reversed",
  "rowspan",
  "scope",
  "start",
  "target",
  "title",
  "value",
];

export const DASHBOARD_SAFE_HTML_TAGS = [
  "a",
  "blockquote",
  "br",
  "code",
  "del",
  "em",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "hr",
  "li",
  "ol",
  "p",
  "pre",
  "s",
  "span",
  "strong",
  "table",
  "tbody",
  "td",
  "th",
  "thead",
  "tr",
  "ul",
];

interface MarkdownNode {
  destination?: string;
  firstChild?: { literal?: string };
}

interface MarkdownContext {
  entering: boolean;
  getChildrenText: (node: unknown) => string;
  skipChildren: () => void;
}

export function safeHref(value: string): string | null {
  const href = value.trim();
  if (!href) return null;
  if (href.includes("\\")) return null;
  if (/^(?:https?:|mailto:)/i.test(href)) return href;
  if (/^(?:#|\/(?!\/)|\.\.?\/|\?)/.test(href)) return href;
  return /^[^\s/:?#][^\s:]*$/.test(href) ? href : null;
}

interface RichEditorNode {
  attrs: Record<string, unknown>;
  type: { name: string };
}

interface RichEditorMark {
  attrs: Record<string, unknown>;
}

interface RichEditorElement {
  className: string;
  textContent: string | null;
  removeAttribute(name: string): void;
  setAttribute(name: string, value: string): void;
}

interface RichEditorDocument {
  createElement(tagName: string): RichEditorElement;
}

interface RichEditorNodeView {
  contentDOM?: RichEditorElement;
  dom: RichEditorElement;
  stopEvent?: () => boolean;
  update?: (node: RichEditorNode) => boolean;
}

interface RichEditorPluginContext {
  pmState: {
    Plugin: new (spec: {
      props: { markViews: Record<string, (mark: RichEditorMark) => RichEditorNodeView> };
    }) => unknown;
  };
}

interface RichEditorPluginInfo {
  wysiwygNodeViews?: Record<
    string,
    (node: RichEditorNode, view?: unknown, getPos?: () => number, eventEmitter?: unknown) => RichEditorNodeView
  >;
  wysiwygPlugins?: Array<(eventEmitter?: unknown) => unknown>;
}

export type RichEditorPlugin = (context: RichEditorPluginContext) => RichEditorPluginInfo | null;

function imageLabel(attrs: Record<string, unknown>): string {
  const alt = (typeof attrs.altText === "string" ? attrs.altText : "image").replace(/\s+/g, " ").trim() || "image";
  return `[${alt}]`;
}

function createImageView(node: RichEditorNode, documentObject: RichEditorDocument): RichEditorNodeView {
  const dom = documentObject.createElement("span");
  const render = (attrs: Record<string, unknown>) => {
    const label = imageLabel(attrs);
    if (dom.textContent !== label) dom.textContent = label;
  };
  render(node.attrs);
  return {
    dom,
    stopEvent: () => true,
    update(nextNode) {
      if (nextNode.type.name !== "image") return false;
      render(nextNode.attrs);
      return true;
    },
  };
}

function createLinkView(mark: RichEditorMark, documentObject: RichEditorDocument): RichEditorNodeView {
  const href = mark.attrs.rawHTML ? null : safeHref(typeof mark.attrs.linkUrl === "string" ? mark.attrs.linkUrl : "");
  const dom = documentObject.createElement(href ? "a" : "span");
  if (href) {
    dom.setAttribute("href", href);
    dom.setAttribute("rel", "noopener noreferrer");
    dom.setAttribute("target", "_blank");
  }
  return { contentDOM: dom, dom };
}

function createListItemView(node: RichEditorNode, documentObject: RichEditorDocument): RichEditorNodeView {
  const dom = documentObject.createElement("li");
  const render = (attrs: Record<string, unknown>) => {
    const task = !attrs.rawHTML && Boolean(attrs.task);
    const checked = task && Boolean(attrs.checked);
    const className = task ? `task-list-item${checked ? " checked" : ""}` : "";
    if (dom.className !== className) dom.className = className;
    if (task) dom.setAttribute("data-task", "true");
    else dom.removeAttribute("data-task");
    if (checked) dom.setAttribute("data-task-checked", "true");
    else dom.removeAttribute("data-task-checked");
  };
  render(node.attrs);
  return {
    contentDOM: dom,
    dom,
    update(nextNode) {
      if (nextNode.type.name !== "listItem") return false;
      render(nextNode.attrs);
      return true;
    },
  };
}

export function createSafeWysiwygPlugin(documentObject: RichEditorDocument): RichEditorPlugin {
  return ({ pmState }) => ({
    wysiwygNodeViews: {
      image: (node) => createImageView(node, documentObject),
      listItem: (node) => createListItemView(node, documentObject),
    },
    wysiwygPlugins: [
      () =>
        new pmState.Plugin({
          props: {
            markViews: {
              link: (mark) => createLinkView(mark, documentObject),
            },
          },
        }),
    ],
  });
}

export function renderSafeImage(node: MarkdownNode, context: MarkdownContext): HtmlToken {
  if (context.entering) context.skipChildren();
  const alt = context.getChildrenText(node) || node.firstChild?.literal || "image";
  return context.entering ? { type: "text", content: `[${alt}]` } : null;
}

export function renderSafeLink(node: MarkdownNode, context: MarkdownContext): HtmlToken {
  const href = safeHref(node.destination ?? "");
  if (!href) return { type: context.entering ? "openTag" : "closeTag", tagName: "span" };
  return context.entering
    ? {
        type: "openTag",
        tagName: "a",
        attributes: { href, rel: "noopener noreferrer", target: "_blank" },
      }
    : { type: "closeTag", tagName: "a" };
}
