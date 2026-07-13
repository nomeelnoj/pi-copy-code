import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const extension = await jiti.import("../extensions/copy-code/index.ts");

test("extractCodeBlocks preserves whitespace and language", () => {
  const markdown = [
    "Before",
    "",
    "```yaml",
    "apiVersion: v1",
    "metadata:",
    "  name: test",
    "```",
    "",
    "~~~python",
    "def hello():",
    "    return \"world\"",
    "~~~",
    "",
  ].join("\n");

  const blocks = extension.extractCodeBlocks(markdown);

  assert.deepEqual(blocks, [
    {
      index: 1,
      lang: "yaml",
      code: "apiVersion: v1\nmetadata:\n  name: test",
    },
    {
      index: 2,
      lang: "python",
      code: "def hello():\n    return \"world\"",
    },
  ]);
});

test("createCopyChoices adds an All option for multiple blocks", () => {
  const blocks = [
    { index: 1, lang: "bash", code: "echo one" },
    { index: 2, lang: "python", code: "print('two')" },
  ];

  const choices = extension.createCopyChoices(blocks);

  assert.equal(choices.length, 3);
  assert.equal(choices[0].label, "All code blocks (2 blocks)");
  assert.equal(choices[0].code, "echo one\n\nprint('two')");
  assert.match(choices[1].label, /^1\. bash/);
  assert.match(choices[2].label, /^2\. python/);
});

test("wrapIndex loops around both directions", () => {
  assert.equal(extension.wrapIndex(0, -1, 8), 7);
  assert.equal(extension.wrapIndex(7, 1, 8), 0);
  assert.equal(extension.wrapIndex(3, 1, 8), 4);
  assert.equal(extension.wrapIndex(3, -1, 8), 2);
  assert.equal(extension.wrapIndex(0, -1, 0), 0);
});

test("filterCopyChoices preserves original order for empty query", () => {
  const choices = extension.createCopyChoices([
    { index: 1, lang: "bash", code: "echo one" },
    { index: 2, lang: "python", code: "print('two')" },
  ]);

  const filtered = extension.filterCopyChoices(choices, "");
  assert.deepEqual(filtered, choices);
});

test("filterCopyChoices fuzzy-searches code content case-insensitively", () => {
  const choices = extension.createCopyChoices([
    { index: 1, lang: "bash", code: "echo one" },
    { index: 2, lang: "python", code: "print('two')" },
  ]);

  const filtered = extension.filterCopyChoices(choices, "PRINT TWO");
  assert.equal(filtered.length, 1);
  assert.match(filtered[0].label, /^2\. python/);
});

test("fuzzyScore returns non-negative for distant valid matches", () => {
  assert.ok(extension.fuzzyScore(`${"a".repeat(80)}z`, "z") >= 0);
  assert.equal(extension.fuzzyScore("hello", "z"), -1);
});

test("filterCopyChoices finds distant code content matches", () => {
  const choices = extension.createCopyChoices([
    { index: 1, lang: "text", code: `${"a".repeat(80)}z` },
  ]);

  const filtered = extension.filterCopyChoices(choices, "z");

  assert.equal(filtered.length, 1);
  assert.match(filtered[0].label, /^1\. text/);
});

test("filterCopyChoices does not let the aggregate option steal code searches", () => {
  const choices = extension.createCopyChoices([
    { index: 1, lang: "bash", code: "echo one" },
    { index: 2, lang: "python", code: "print('two')" },
  ]);

  assert.equal(choices[0].label, "All code blocks (2 blocks)");

  const filtered = extension.filterCopyChoices(choices, "print");
  assert.equal(filtered.length, 1);
  assert.match(filtered[0].label, /^2\. python/);
});

function assistantEntry(text) {
  return { type: "message", message: { role: "assistant", content: [{ type: "text", text }] } };
}

function userEntry(text) {
  return { type: "message", message: { role: "user", content: [{ type: "text", text }] } };
}

test("extractMessageBlocks returns chronological ordinals for code messages", () => {
  const entries = [
    assistantEntry("first\n```bash\necho one\n```"),
    userEntry("a question"),
    assistantEntry("second\n```python\nprint('two')\n```"),
  ];

  const messages = extension.extractMessageBlocks(entries);

  assert.equal(messages.length, 2);
  assert.deepEqual(messages.map((m) => m.ordinal), [1, 2]);
  assert.equal(messages[0].blocks[0].code, "echo one");
  // Newest surfaced message is last.
  assert.equal(messages.at(-1).blocks[0].code, "print('two')");
});

test("extractMessageBlocks skips assistant messages without code blocks", () => {
  const entries = [
    assistantEntry("just prose, no fences"),
    assistantEntry("```bash\necho hi\n```"),
  ];

  const messages = extension.extractMessageBlocks(entries);

  assert.equal(messages.length, 1);
  assert.equal(messages[0].ordinal, 1);
  assert.equal(messages[0].blocks[0].code, "echo hi");
});

test("extractMessageBlocks caps at the most recent messages and relabels ordinals", () => {
  const entries = Array.from({ length: 15 }, (_, i) =>
    assistantEntry(`msg ${i}\n\`\`\`bash\necho ${i}\n\`\`\``),
  );

  const messages = extension.extractMessageBlocks(entries, 10);

  assert.equal(messages.length, 10);
  // Ordinals restart at 1 after the cap slice; newest message wins the last slot.
  assert.deepEqual(messages.map((m) => m.ordinal), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  assert.equal(messages[0].blocks[0].code, "echo 5");
  assert.equal(messages.at(-1).blocks[0].code, "echo 14");
});

test("extractMessageBlocks tolerates non-array and empty input", () => {
  assert.deepEqual(extension.extractMessageBlocks([]), []);
  assert.deepEqual(extension.extractMessageBlocks([userEntry("hi")]), []);
});

test("responseTabLabels label newest as Current, older as Prev N (display order)", () => {
  assert.deepEqual(extension.responseTabLabels(1), ["Current"]);
  assert.deepEqual(extension.responseTabLabels(3), ["Current", "Prev 1", "Prev 2"]);
});

test("tabWindow shows every tab when they all fit", () => {
  const win = extension.tabWindow([10, 10, 10], 2, 100);
  assert.deepEqual(win, { start: 0, end: 3, leftMore: false, rightMore: false });
});

test("tabWindow keeps the active tail tab visible and scrolls older ones off", () => {
  // 6 tabs of width 12 (+ separators) cannot fit in 30 cols; active is newest (5).
  const widths = Array.from({ length: 6 }, () => 12);
  const win = extension.tabWindow(widths, 5, 30);

  assert.ok(win.start <= 5 && win.end === 6, "active tail tab stays in window");
  assert.equal(win.leftMore, true, "older tabs are off-screen to the left");
  assert.equal(win.rightMore, false, "newest is already the rightmost");
});

test("tabWindow keeps a mid-list active tab within the window", () => {
  const widths = Array.from({ length: 8 }, () => 12);
  const win = extension.tabWindow(widths, 3, 30);

  assert.ok(win.start <= 3 && 3 < win.end, "active index is inside [start, end)");
  assert.ok(win.end - win.start >= 1);
});

test("tabWindow handles a single tab", () => {
  const win = extension.tabWindow([12], 0, 30);
  assert.deepEqual(win, { start: 0, end: 1, leftMore: false, rightMore: false });
});

test("splitEditorCommand preserves quoted editor commands", () => {
  assert.deepEqual(extension.splitEditorCommand('"/Applications/MacVim.app/Contents/bin/mvim" --wait'), [
    "/Applications/MacVim.app/Contents/bin/mvim",
    "--wait",
  ]);
  assert.deepEqual(extension.splitEditorCommand('nvim --cmd "set background=dark"'), [
    "nvim",
    "--cmd",
    "set background=dark",
  ]);
  assert.deepEqual(extension.splitEditorCommand('"C:\\Program Files\\Neovim\\bin\\nvim.exe"'), [
    "C:\\Program Files\\Neovim\\bin\\nvim.exe",
  ]);
});

test("extension registers /copy-code and ctrl+alt+c", () => {
  const registered = { commands: [], shortcuts: [] };

  extension.default({
    registerCommand(name, options) {
      registered.commands.push({ name, options });
    },
    registerShortcut(shortcut, options) {
      registered.shortcuts.push({ shortcut, options });
    },
  });

  assert.equal(registered.commands[0].name, "copy-code");
  assert.equal(registered.shortcuts[0].shortcut, "ctrl+alt+c");
});
