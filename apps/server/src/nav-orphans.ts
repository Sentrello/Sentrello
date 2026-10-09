/**
 * A page this person may open, under a heading they may not see.
 *
 * The till's pages are filed under the Shop. A business's counter role may
 * use the till and hold nothing in the Shop, and the sidebar draws a page
 * beneath its parent, never on its own, so the parent's being hidden took
 * every till page with it: the screen opened from a bookmark and from nowhere
 * else. A page whose parent is not offered to this person stands on its own
 * instead, as the module it belongs to.
 */
export function hoistOrphans<T extends { id: string; parent?: string | null }>(
  visible: T[],
): T[] {
  const shown = new Set(visible.map((item) => item.id));
  return visible.map((item) =>
    item.parent && !shown.has(item.parent)
      ? { ...item, parent: undefined }
      : item,
  );
}
