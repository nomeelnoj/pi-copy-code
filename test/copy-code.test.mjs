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
