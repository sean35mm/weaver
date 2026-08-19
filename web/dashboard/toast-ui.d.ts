declare module "@toast-ui/editor" {
  interface EditorOptions {
    el: HTMLElement;
    height?: string;
    hideModeSwitch?: boolean;
    initialEditType?: "markdown" | "wysiwyg";
    initialValue?: string;
    linkAttributes?: Record<string, string>;
    customHTMLRenderer?: Record<
      string,
      (
        node: { destination?: string; firstChild?: { literal?: string } },
        context: { entering: boolean; getChildrenText: (node: unknown) => string; skipChildren: () => void },
      ) =>
        | { type: "openTag" | "closeTag"; tagName: string; attributes?: Record<string, string> }
        | { type: "text"; content: string }
        | null
    >;
    plugins?: Array<
      (context: {
        pmState: {
          Plugin: new (spec: {
            props: { markViews: Record<string, (mark: { attrs: Record<string, unknown> }) => EditorNodeView> };
          }) => unknown;
        };
      }) => {
        wysiwygNodeViews?: Record<
          string,
          (node: EditorNode, view?: unknown, getPos?: () => number, eventEmitter?: unknown) => EditorNodeView
        >;
        wysiwygPlugins?: Array<(eventEmitter?: unknown) => unknown>;
      } | null
    >;
    previewStyle?: "tab" | "vertical";
    toolbarItems?: string[][];
    theme?: "dark" | "light";
    usageStatistics?: boolean;
    customHTMLSanitizer?: (html: string) => string;
  }

  interface EditorNode {
    attrs: Record<string, unknown>;
    type: { name: string };
  }

  interface EditorNodeView {
    contentDOM?: EditorElement;
    dom: EditorElement;
    stopEvent?: () => boolean;
    update?: (node: EditorNode) => boolean;
  }

  interface EditorElement {
    className: string;
    textContent: string | null;
    removeAttribute(name: string): void;
    setAttribute(name: string, value: string): void;
  }

  export default class Editor {
    constructor(options: EditorOptions);
    blur(): void;
    changeMode(mode: "markdown" | "wysiwyg", withoutFocus?: boolean): void;
    exec(command: string): void;
    getEditorElements(): { mdEditor: HTMLElement; mdPreview: HTMLElement; wwEditor: HTMLElement };
    getMarkdown(): string;
    on(event: "change", callback: () => void): void;
    setMarkdown(markdown: string, cursorToEnd?: boolean): void;
  }
}
