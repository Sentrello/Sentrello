/**
 * How the platform names one module's thing, across every registry.
 *
 * A widget id, a summary id, a guide id, a retention policy id — all of them
 * are the module author's own word, chosen without seeing the catalogue. Two
 * modules by different authors calling a panel `money`, or `health`, or
 * `overview` is not a remote possibility; it is what happens the week the
 * second one ships. Every registry here used to replace by that bare word, so
 * the later module silently took the earlier one's place: no error, no
 * warning, a customer simply without a feature they had paid for and nobody
 * able to see why.
 *
 * So the key is the module and the word together, and a collision between two
 * modules is not unlikely but impossible. The same module registering the same
 * id twice still replaces — that is one author's intent, and it is what a host
 * that loads its modules twice in one process does.
 *
 * **Modules did not have to change.** A module still writes `id: "money"`; the
 * moduleId is attached by the host, at the point it already was.
 */
export function scopedId(moduleId: string, id: string): string {
  return `${moduleId}:${id}`;
}
