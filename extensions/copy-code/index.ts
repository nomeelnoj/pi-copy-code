import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  Theme,
} from "@earendil-works/pi-coding-agent";
import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { Markdown, matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { MarkdownTheme, TUI } from "@earendil-works/pi-tui";
import { Buffer } from "node:buffer";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

type AnyContext = ExtensionCommandContext | ExtensionContext;

export type CodeBlock = {
  index: number;
  lang: string;
  code: string;
};

export type CopyChoice = {
  label: string;
  code: string;
  lang: string;
};

type CopyAction = "copy" | "edit";

type PickerResult = {
  action: CopyAction;
  code: string;
} | undefined;

function latestAssistantMarkdown(ctx: AnyContext): string | undefined {
  const sessionManager = ctx.sessionManager as any;
  const entries =
    typeof sessionManager.getBranch === "function"
      ? sessionManager.getBranch()
      : sessionManager.getEntries();

  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    const message = entry?.type === "message" ? entry.message : undefined;
    if (message?.role !== "assistant" || !Array.isArray(message.content)) {
      continue;
    }

    const text = message.content
      .filter((content: any) => content?.type === "text" && typeof content.text === "string")
      .map((content: any) => content.text)
      .join("\n");

    if (text.trim()) {
      return text;
    }
  }

  return undefined;
}

export function extractCodeBlocks(markdown: string): CodeBlock[] {
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  const blocks: CodeBlock[] = [];

  let fenceChar: "`" | "~" | undefined;
  let fenceLength = 0;
  let lang = "";
  let buffer: string[] = [];

  for (const line of lines) {
    if (!fenceChar) {
      const open = line.match(/^[ \t]*(`{3,}|~{3,})([^\r\n]*)$/);
      if (!open) {
        continue;
      }

      fenceChar = open[1][0] as "`" | "~";
      fenceLength = open[1].length;
      lang = (open[2] || "").trim().split(/\s+/)[0] || "";
      buffer = [];
      continue;
    }

    const fenceLiteral = fenceChar === "`" ? "`" : "~";
    const close = new RegExp(`^[ \\t]*${fenceLiteral}{${fenceLength},}[ \\t]*$`);
    if (close.test(line)) {
      blocks.push({ index: blocks.length + 1, lang, code: buffer.join("\n") });
      fenceChar = undefined;
      fenceLength = 0;
      lang = "";
      buffer = [];
      continue;
    }

    buffer.push(line);
  }

  return blocks;
}

function copyNative(text: string): string | undefined {
  const attempts: [string, string[]][] =
    process.platform === "darwin"
      ? [["pbcopy", []]]
      : process.platform === "win32"
        ? [["clip.exe", []]]
        : process.env.WAYLAND_DISPLAY
          ? [
              ["wl-copy", []],
              ["xclip", ["-selection", "clipboard"]],
              ["xsel", ["--clipboard", "--input"]],
            ]
          : [
              ["xclip", ["-selection", "clipboard"]],
              ["xsel", ["--clipboard", "--input"]],
              ["wl-copy", []],
            ];

  for (const [command, args] of attempts) {
    const result = spawnSync(command, args, {
      input: text,
      encoding: "utf8",
      stdio: ["pipe", "ignore", "ignore"],
    });

    if (!result.error && result.status === 0) {
      return command;
    }
  }

  return undefined;
}

function copyOsc52(text: string): boolean {
  const encoded = Buffer.from(text, "utf8").toString("base64");
  if (encoded.length > 100_000) {
    return false;
  }

  process.stdout.write(`\x1b]52;c;${encoded}\x07`);
  return true;
}

function copyToClipboard(text: string): string {
  const native = copyNative(text);
  if (native) {
    return native;
  }

  if (copyOsc52(text)) {
    return "OSC 52";
  }

  throw new Error("Clipboard unavailable: no native command found and text is too large for terminal copy");
}

function lineCount(text: string): number {
  return text === "" ? 0 : text.split("\n").length;
}

function describeBlock(block: CodeBlock): string {
  const codeLines = block.code.split("\n");
  const first = codeLines.find((line) => line.trim())?.trim().slice(0, 60) || "(blank)";
  const lines = block.code === "" ? 0 : codeLines.length;
  return `${block.index}. ${block.lang || "text"} (${lines} line${lines === 1 ? "" : "s"}) ${first}`;
}

export function wrapIndex(index: number, delta: number, count: number): number {
  if (count <= 0) {
    return 0;
  }
  return ((index + delta) % count + count) % count;
}

// Case-insensitive subsequence fuzzy score. Returns -1 when the query does not
// match. Higher scores reward earlier matches and contiguous runs.
export function fuzzyScore(text: string, query: string): number {
  if (!query) {
    return 0;
  }

  const haystack = text.toLowerCase();
  const needle = query.toLowerCase();

  let cursor = 0;
  let score = 0;
  let streak = 0;

  for (const char of needle) {
    const found = haystack.indexOf(char, cursor);
    if (found === -1) {
      return -1;
    }
    if (found === cursor) {
      streak += 1;
      score += 5 + streak;
    } else {
      streak = 0;
      score += 1;
    }
    score -= Math.min(found, 20) * 0.1;
    cursor = found + 1;
  }

  // A matched query never returns the -1 no-match sentinel: the gap penalty
  // above can otherwise drive a valid (but distant) match below zero.
  return Math.max(0, score);
}

// Filters choices by a whitespace-delimited query where every token must match.
// Empty queries preserve the original order. The aggregate "All code blocks"
// choice (index 0 with that label) is matched on its label only, so a code
// search does not always surface it at the top via its concatenated contents.
export function filterCopyChoices(items: CopyChoice[], query: string): CopyChoice[] {
  const trimmed = query.trim();
  if (!trimmed) {
    return items.slice();
  }

  const tokens = trimmed.split(/\s+/);

  const scored: { item: CopyChoice; score: number; order: number }[] = [];
  items.forEach((item, order) => {
    const isAggregate = order === 0 && item.label.startsWith("All code blocks");
    const haystack = isAggregate ? item.label : `${item.label}\n${item.lang}\n${item.code}`;

    let total = 0;
    let matched = true;
    for (const token of tokens) {
      const score = fuzzyScore(haystack, token);
      if (score < 0) {
        matched = false;
        break;
      }
      total += score;
    }

    if (matched) {
      scored.push({ item, score: total, order });
    }
  });

  scored.sort((a, b) => b.score - a.score || a.order - b.order);
  return scored.map((entry) => entry.item);
}

export function createCopyChoices(blocks: CodeBlock[]): CopyChoice[] {
  if (blocks.length <= 1) {
    return blocks.map((block) => ({ label: describeBlock(block), code: block.code, lang: block.lang }));
  }

  return [
    { label: `All code blocks (${blocks.length} blocks)`, code: blocks.map((b) => b.code).join("\n\n"), lang: "" },
    ...blocks.map((block) => ({ label: describeBlock(block), code: block.code, lang: block.lang })),
  ];
}

function isBackspace(data: string): boolean {
  return data === "\x7f" || data === "\b" || matchesKey(data, "backspace");
}

function isPrintable(data: string): boolean {
  return data.length === 1 && data >= " " && data !== "\x7f";
}

class CodeBlockPickerComponent {
  private selected = 0;
  private items: CopyChoice[];
  private query = "";
  private searching = false;

  constructor(
    blocks: CodeBlock[],
    private theme: Theme,
    private mdTheme: MarkdownTheme,
    private tui: TUI,
    private enterAction: CopyAction,
    private done: (result: PickerResult) => void,
  ) {
    this.items = createCopyChoices(blocks);
  }

  private activeQuery(): string {
    return this.searching ? this.query : "";
  }

  private visibleItems(): CopyChoice[] {
    return filterCopyChoices(this.items, this.activeQuery());
  }

  private exitSearch(): void {
    this.searching = false;
    this.query = "";
    this.selected = 0;
    this.tui.requestRender();
  }

  render(width: number): string[] {
    const listWidth = Math.min(36, Math.floor(width * 0.38));
    const previewWidth = Math.max(10, width - listWidth - 3);
    const maxHeight = Math.min(28, Math.max(this.items.length + 6, 14));

    const visibleItems = this.visibleItems();
    if (this.selected >= visibleItems.length) {
      this.selected = Math.max(0, visibleItems.length - 1);
    }

    const boxRows = maxHeight - 2;
    const showSearch = this.searching;
    const searchRows = showSearch ? 1 : 0;
    const itemRows = Math.max(1, boxRows - searchRows);

    const offset = Math.min(
      Math.max(0, this.selected - itemRows + 1),
      Math.max(0, visibleItems.length - itemRows),
    );

    const leftLines: string[] = [];
    if (showSearch) {
      const counter = `${visibleItems.length}/${this.items.length}`;
      const searchLine = `/${this.query}█  ${counter}`;
      leftLines.push(truncateToWidth(this.theme.fg("accent", searchLine), listWidth, undefined, true));
    }

    if (visibleItems.length === 0) {
      leftLines.push(truncateToWidth(this.theme.fg("dim", "  (no matches)"), listWidth, undefined, true));
    } else {
      for (let i = offset; i < Math.min(visibleItems.length, offset + itemRows); i++) {
        const item = visibleItems[i];
        const prefix = i === this.selected ? "> " : "  ";
        const text = prefix + item.label;
        const styled =
          i === this.selected ? this.theme.fg("accent", text) : this.theme.fg("dim", text);
        leftLines.push(truncateToWidth(styled, listWidth, undefined, true));
      }
    }

    const selected = visibleItems[this.selected];
    let previewLines: string[] = [];
    if (selected) {
      const mdText = selected.lang
        ? `\`\`\`${selected.lang}\n${selected.code}\n\`\`\``
        : selected.code;
      const md = new Markdown(mdText, 0, 1, this.mdTheme);
      previewLines = md.render(previewWidth).slice(0, maxHeight - 4);
    }

    const border = (s: string) => this.theme.fg("border", s);
    const divider = border("│");
    const lines: string[] = [];

    lines.push(
      border("┌") +
        border("─".repeat(listWidth)) +
        border("┬") +
        border("─".repeat(previewWidth)) +
        border("┐"),
    );

    for (let i = 0; i < boxRows; i++) {
      const left = leftLines[i] || " ".repeat(listWidth);
      const right = truncateToWidth(previewLines[i] || "", previewWidth, undefined, true);
      lines.push(divider + left + divider + right + divider);
    }

    lines.push(
      border("└") +
        border("─".repeat(listWidth)) +
        border("┴") +
        border("─".repeat(previewWidth)) +
        border("┘"),
    );

    const enterLabel = this.enterAction === "edit" ? "enter edit" : "enter copy";
    const hint = this.searching
      ? ` ↑↓ navigate • ${enterLabel} • ⌫/esc back `
      : ` ↑↓/j/k navigate • ${enterLabel} • e edit • / search • esc/q cancel `;
    const hintWidth = visibleWidth(hint);
    const pad = Math.max(0, width - hintWidth);
    lines.push(this.theme.fg("dim", " ".repeat(Math.floor(pad / 2)) + hint));

    return lines;
  }

  handleInput(data: string): void {
    const visibleItems = this.visibleItems();

    if (this.searching) {
      if (matchesKey(data, "escape")) {
        this.exitSearch();
      } else if (isBackspace(data)) {
        // Deleting past an empty query leaves search, like esc.
        if (this.query.length === 0) {
          this.exitSearch();
        } else {
          this.query = this.query.slice(0, -1);
          this.selected = 0;
          this.tui.requestRender();
        }
      } else if (matchesKey(data, "enter")) {
        const item = visibleItems[this.selected];
        if (item) {
          this.done({ action: this.enterAction, code: item.code });
        }
      } else if (matchesKey(data, "up")) {
        this.selected = wrapIndex(this.selected, -1, visibleItems.length);
        this.tui.requestRender();
      } else if (matchesKey(data, "down")) {
        this.selected = wrapIndex(this.selected, 1, visibleItems.length);
        this.tui.requestRender();
      } else if (isPrintable(data)) {
        this.query += data;
        this.selected = 0;
        this.tui.requestRender();
      }
      return;
    }

    if (data === "/") {
      this.searching = true;
      this.query = "";
      this.selected = 0;
      this.tui.requestRender();
    } else if (matchesKey(data, "up") || data === "k") {
      this.selected = wrapIndex(this.selected, -1, visibleItems.length);
      this.tui.requestRender();
    } else if (matchesKey(data, "down") || data === "j") {
      this.selected = wrapIndex(this.selected, 1, visibleItems.length);
      this.tui.requestRender();
    } else if (matchesKey(data, "enter")) {
      const item = visibleItems[this.selected];
      if (item) {
        this.done({ action: this.enterAction, code: item.code });
      }
    } else if (data === "e") {
      const item = visibleItems[this.selected];
      if (item) {
        this.done({ action: "edit", code: item.code });
      }
    } else if (matchesKey(data, "escape") || data === "q") {
      this.done(undefined);
    }
  }

  invalidate(): void {}
}

async function chooseCopyAction(
  blocks: CodeBlock[],
  ctx: AnyContext,
  enterAction: CopyAction,
): Promise<PickerResult> {
  if (blocks.length === 1) {
    return { action: enterAction, code: blocks[0].code };
  }

  const mdTheme = { ...getMarkdownTheme(), codeBlockIndent: "" };

  return await ctx.ui.custom<PickerResult>(
    (tui, theme, _keybindings, done) =>
      new CodeBlockPickerComponent(blocks, theme, mdTheme, tui, enterAction, done),
    { overlay: true },
  );
}

export function splitEditorCommand(command: string): string[] {
  const parts: string[] = [];
  let current = "";
  let quote: "'" | '"' | undefined;

  for (let i = 0; i < command.length; i++) {
    const char = command[i];

    if (quote) {
      if (char === quote) {
        quote = undefined;
      } else if (
        quote === '"' &&
        char === "\\" &&
        i + 1 < command.length &&
        ['\\', '"', "$", "`"].includes(command[i + 1])
      ) {
        current += command[++i];
      } else {
        current += char;
      }
      continue;
    }

    if (char === "'" || char === '"') {
      quote = char;
    } else if (/\s/.test(char)) {
      if (current) {
        parts.push(current);
        current = "";
      }
    } else {
      current += char;
    }
  }

  if (current) {
    parts.push(current);
  }

  return parts;
}

class ExternalEditorComponent {
  private started = false;

  constructor(
    private code: string,
    private tui: TUI,
    private done: (result: string | undefined) => void,
  ) {}

  render(width: number): string[] {
    if (!this.started) {
      this.started = true;
      setTimeout(() => this.openExternalEditor(), 0);
    }

    return [truncateToWidth("Opening external editor…", width, undefined, true)];
  }

  handleInput(data: string): void {
    if (matchesKey(data, "escape") || data === "q") {
      this.done(undefined);
    }
  }

  invalidate(): void {}

  private openExternalEditor(): void {
    const editorCommand = process.env.VISUAL || process.env.EDITOR;
    if (!editorCommand) {
      this.done(undefined);
      return;
    }

    const tmpFile = path.join(os.tmpdir(), `pi-copy-code-${Date.now()}.txt`);

    let edited: string | undefined;

    try {
      fs.writeFileSync(tmpFile, this.code, "utf-8");
      this.tui.stop();

      const [editor, ...editorArgs] = splitEditorCommand(editorCommand);
      if (!editor) {
        this.done(undefined);
        return;
      }

      const result = spawnSync(editor, [...editorArgs, tmpFile], {
        stdio: "inherit",
        shell: process.platform === "win32",
      });

      if (result.status === 0) {
        edited = fs.readFileSync(tmpFile, "utf-8").replace(/\n$/, "");
      }
    } finally {
      try {
        fs.unlinkSync(tmpFile);
      } catch {}

      this.tui.start();
      this.tui.requestRender(true);
    }

    this.done(edited);
  }
}

async function editCodeBeforeCopy(
  code: string,
  ctx: AnyContext,
): Promise<string | undefined> {
  if (!(process.env.VISUAL || process.env.EDITOR)) {
    ctx.ui.notify("No external editor configured. Set $VISUAL or $EDITOR.", "warning");
    return undefined;
  }

  return await ctx.ui.custom<string | undefined>(
    (tui, _theme, _keybindings, done) => new ExternalEditorComponent(code, tui, done),
    { overlay: true },
  );
}

export default function copyCodeExtension(pi: ExtensionAPI) {
  async function run(args: string, ctx: AnyContext): Promise<void> {
    if ("waitForIdle" in ctx) {
      await ctx.waitForIdle();
    }

    const markdown = latestAssistantMarkdown(ctx);
    if (!markdown) {
      ctx.ui.notify("No assistant message found", "warning");
      return;
    }

    const blocks = extractCodeBlocks(markdown);
    if (blocks.length === 0) {
      ctx.ui.notify("No code blocks found in the last assistant message", "warning");
      return;
    }

    const arg = args.trim().toLowerCase();
    let text: string | undefined;

    if (!arg || arg === "edit") {
      const result = await chooseCopyAction(blocks, ctx, arg === "edit" ? "edit" : "copy");
      if (result === undefined) {
        ctx.ui.notify("Copy cancelled", "info");
        return;
      }

      if (result.action === "edit") {
        const edited = await editCodeBeforeCopy(result.code, ctx);
        if (edited === undefined) {
          ctx.ui.notify("Copy cancelled", "info");
          return;
        }
        text = edited;
      } else {
        text = result.code;
      }
    } else {
      ctx.ui.notify("Usage: /copy-code [edit]", "warning");
      return;
    }

    try {
      const via = copyToClipboard(text);
      const lines = lineCount(text);
      ctx.ui.notify(`Copied ${lines} line${lines === 1 ? "" : "s"} via ${via}`, "info");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      ctx.ui.notify(`Copy failed: ${message}`, "error");
    }
  }

  pi.registerCommand("copy-code", {
    description: "Copy code from the latest assistant message; prompts when multiple blocks",
    handler: run,
  });

  pi.registerShortcut("ctrl+alt+c", {
    description: "Copy code from the latest assistant message",
    handler: (ctx) => run("", ctx),
  });
}
