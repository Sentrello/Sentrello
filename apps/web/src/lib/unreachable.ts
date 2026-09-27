/**
 * When nothing answered, say why rather than blaming the software.
 *
 * "Something went wrong. Try again." is the right sentence for a request the
 * instance refused and a poor one for a request that never arrived. Two
 * cases, and this product has both more than most: it is sold to somebody
 * standing in a van or a workshop, and it runs on a server they own and
 * restart themselves.
 *
 * `navigator.onLine` is only trusted when it says **no**. False means the
 * device has no route at all, which is a fact; true means it has one, which
 * says nothing about whether the instance is at the other end of it. So a
 * failed fetch with the line apparently up is reported as the instance being
 * unreachable, which is what it is — restarting, updating, or off.
 *
 * Only reached when the server sent no sentence of its own, because a server
 * that answered is by definition reachable.
 */
export function unreachableMessage(error: unknown): string | undefined {
  if (typeof navigator !== "undefined" && navigator.onLine === false) {
    return "This device is offline. Nothing was sent — try again once you are back on.";
  }
  /*
   * A fetch that rejected rather than answering. Matched on the browsers'
   * own wording as well as the type, because a `TypeError` from a bug in a
   * screen would otherwise be dressed up as a network problem and the defect
   * would never be reported: Chrome says "Failed to fetch", Safari "Load
   * failed", Firefox "NetworkError when attempting to fetch resource".
   */
  if (
    error instanceof TypeError &&
    /failed to fetch|load failed|networkerror/i.test(error.message)
  ) {
    return "This Sentrello could not be reached. It may be restarting — try again in a moment.";
  }
  return undefined;
}
