import { expect, test } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * The diagrams in the published documentation have to parse.
 *
 * They are mermaid, rendered in the reader's browser by the Docs module — so
 * a diagram with a typo in it does not fail a build anywhere. It ships, and
 * it draws a red error box in the middle of a customer's documentation page.
 * Nothing else in this repository would notice.
 *
 * This is deliberately a syntax check and not a render. A real render needs a
 * browser and eleven megabytes of mermaid, which is the wrong price for a
 * test that runs on every commit; the faults it would catch beyond these are
 * layout complaints rather than breakage. The diagrams were each rendered
 * once, by hand, with the same mermaid build the module ships.
 */

const ROOT = join(import.meta.dir, "../../../docs/site");

function markdownFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return markdownFiles(path);
    return entry.endsWith(".md") ? [path] : [];
  });
}

type Block = { file: string; code: string };

const blocks: Block[] = markdownFiles(ROOT).flatMap((file) => {
  const source = readFileSync(file, "utf8");
  return [...source.matchAll(/```mermaid\n([\s\S]*?)```/g)].map((m) => ({
    file: file.slice(ROOT.length + 1),
    // The capture group is not optional in that pattern; TypeScript cannot
    // know that, and a default is cheaper than an assertion.
    code: m[1] ?? "",
  }));
});

test("the documentation actually has diagrams", () => {
  // If this ever drops to zero, either they were all removed on purpose — in
  // which case delete this file with them — or a refactor ate them.
  expect(blocks.length).toBeGreaterThan(10);
});

test("every diagram names a kind mermaid knows", () => {
  const kinds =
    /^(flowchart|graph|sequenceDiagram|classDiagram|stateDiagram|erDiagram|journey|gantt|pie|timeline)\b/;
  const wrong = blocks
    .map((b) => ({ file: b.file, first: b.code.trim().split("\n")[0] ?? "" }))
    .filter((b) => !kinds.test(b.first))
    .map((b) => `${b.file}: ${b.first}`);
  expect(wrong).toEqual([]);
});

test("no diagram has unbalanced brackets or quotes", () => {
  /*
   * The two ways one of these actually breaks, both of them from editing a
   * label rather than from writing a new diagram: a node whose bracket was
   * not closed, and a label whose quote was not. Mermaid's own message for
   * either is a parse error naming a line number, which is not much help
   * inside a markdown file it never sees.
   */
  const unbalanced: string[] = [];
  for (const b of blocks) {
    const n = (ch: string) => b.code.split(ch).length - 1;
    if (n('"') % 2 !== 0) unbalanced.push(`${b.file}: odd number of quotes`);
    if (n("[") !== n("]")) unbalanced.push(`${b.file}: [ ] do not match`);
    if (n("(") !== n(")")) unbalanced.push(`${b.file}: ( ) do not match`);
    if (n("{") !== n("}")) unbalanced.push(`${b.file}: { } do not match`);
  }
  expect(unbalanced).toEqual([]);
});

test("every node that carries a class has one that is defined", () => {
  // `:::missing` is silent — mermaid draws the node with no styling at all,
  // so a renamed classDef leaves a diagram that renders and is quietly grey.
  const missing: string[] = [];
  for (const b of blocks) {
    const defined = new Set(
      [...b.code.matchAll(/classDef\s+(\w+)/g)].map((m) => m[1]),
    );
    for (const used of b.code.matchAll(/:::(\w+)/g)) {
      if (!defined.has(used[1])) missing.push(`${b.file}: :::${used[1]}`);
    }
  }
  expect(missing).toEqual([]);
});
