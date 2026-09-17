/**
 * Where an archive goes once it leaves the database.
 *
 * A business taking years of records off its server wants somewhere different
 * depending on who it is: the smallest one wants a file it downloads and puts
 * on a disk in a drawer; one with a NAS wants a mounted folder; one with a
 * bucket wants the bucket. So the destination is a seam rather than a setting,
 * and the core ships the one that needs no account at all.
 *
 * Four things every destination is assumed to be, because the ones that are
 * coming will be all four and a seam that assumes otherwise has to be rebuilt
 * to admit the first of them:
 *
 *  - **Credentialed with things we did not know at build time.** It declares
 *    its `fields`; the business fills them in on the module's own settings
 *    screen and the secret ones are sealed at rest. Nobody edits a file on a
 *    server to connect storage.
 *  - **Testable before it is trusted.** `test` writes a probe, reads it back
 *    and removes it. A destination nobody has proved is a destination that
 *    silently swallows a customer's only copy.
 *  - **Able to fail part-way.** `put` may throw after some of the bytes have
 *    landed. Nothing local is ever deleted on the strength of a `put`
 *    returning — only on the strength of `get` reading the archive back and
 *    it matching, which is why `get` is not optional.
 *  - **Too large to hold.** Both directions are streams. The instance this
 *    runs on may have well under a gigabyte of memory and years of rows, and
 *    a destination that wanted the whole archive as one buffer would fail
 *    first on the smallest box, which is ours.
 *
 * And one rule about what may be built against it: **nothing gets a privileged
 * path.** A hosted destination of our own, when there is one, is registered
 * here like any other, configured on the same screen, and proves itself with
 * the same `test`. Sentrello runs on Sentrello as an ordinary customer, and a
 * shortcut taken for our own instance is a feature a customer cannot have.
 */

export interface DestinationField {
  name: string;
  label: string;
  /** Sealed at rest and never read back to a screen. */
  secret?: boolean;
  required?: boolean;
  placeholder?: string;
  help?: string;
}

/** What a destination was told, once the secrets have been opened. */
export type DestinationConfig = Record<string, string>;

export interface ArchiveDestination {
  id: string;
  label: string;
  /** One line on the settings screen saying what this is for. */
  description: string;
  fields: DestinationField[];
  /**
   * Prove it works, in the business's own words.
   *
   * Never throws for an ordinary failure — a wrong key, a missing folder, a
   * host that will not answer are all answers, and a screen that shows "500"
   * has told nobody anything.
   */
  test(config: DestinationConfig): Promise<{ ok: boolean; detail: string }>;
  /**
   * Take the archive, a piece at a time. Returns the locator to read it back
   * by — a path, a key, a URL; only this destination has to understand it.
   */
  put(
    config: DestinationConfig,
    name: string,
    body: AsyncIterable<Uint8Array>,
  ): Promise<string>;
  /** Hand it back, a piece at a time. */
  get(config: DestinationConfig, locator: string): AsyncIterable<Uint8Array>;
  /** Remove it. Called only when an operator says so. */
  remove(config: DestinationConfig, locator: string): Promise<void>;
}

const destinations = new Map<string, ArchiveDestination>();

export function registerArchiveDestination(destination: ArchiveDestination) {
  destinations.set(destination.id, destination);
}

export function archiveDestinations(): ArchiveDestination[] {
  return [...destinations.values()];
}

export function archiveDestination(id: string): ArchiveDestination | undefined {
  return destinations.get(id);
}
