/**
 * Finding anything, from anywhere.
 *
 * The commonest thing somebody does in a business system after looking at
 * today's figures is look for one particular thing — a customer, an invoice
 * number half-remembered, the deal that was called something like Henderson.
 * Every list screen here could already filter itself, which answers the
 * question only if you are already on the right screen, and knowing which
 * screen is most of the work.
 *
 * A module says what it can find. Core asks whatever this instance loaded and
 * puts the answers in one list. Core cannot name the modules in other
 * repositories, so a shop's products and a booking's diary reach the same box
 * as a contact does, by the same mechanism, without Core knowing either exists.
 *
 * **Permission is checked before a provider is asked, not after.** Filtering
 * results afterwards means the rows were read, which is the part that matters
 * when the reason somebody may not see contacts is that they are a contractor
 * with access to one project.
 */

export interface SearchHit {
  /** What kind of thing this is, in the word somebody would say: "Contact". */
  kind: string;
  /** What to show: a person's name, an invoice number, a product. */
  title: string;
  /** The line under it — an email, a company, a total. */
  subtitle?: string | null;
  /** Where pressing it goes: the nav entry and the record. */
  opens: { moduleId: string; recordId?: string };
  /**
   * How well it matched, 0 to 1.
   *
   * Set by the provider, which is the only thing that knows whether "Ruth" was
   * the whole of a name or a fragment of an address. Results are ordered by it
   * across every module, so a exact invoice number beats a contact whose notes
   * happen to mention the same digits.
   */
  score?: number;
}

export interface SearchProvider {
  /** The module offering it, filled in by the host. */
  moduleId?: string;
  /**
   * What a reader needs before this is asked at all.
   *
   * Checked before the provider runs. A person who may not read the customer
   * book does not cause a query against it.
   */
  requires?: Record<string, string[]>;
  find: (args: {
    organizationId: string;
    q: string;
    /** How many to bother returning; more than this is thrown away anyway. */
    limit: number;
  }) => Promise<SearchHit[]>;
}

const providers: SearchProvider[] = [];

export function addSearchProvider(provider: SearchProvider): void {
  providers.push(provider);
}

export function searchProviders(): SearchProvider[] {
  return [...providers];
}

/** For tests, which register modules repeatedly in one process. */
export function clearSearchProviders(): void {
  providers.length = 0;
}

/**
 * Ask everything that may be asked, and put the answers in one order.
 *
 * **One provider failing does not lose the rest.** A search that returns
 * nothing because one module's query was slow or wrong is a search nobody
 * trusts, and the one thing worse than not finding something is not finding it
 * silently.
 */
export async function searchEverything(args: {
  organizationId: string;
  q: string;
  limit?: number;
  /** Whether this reader is allowed what a provider requires. */
  may: (requires: Record<string, string[]> | undefined) => boolean;
}): Promise<SearchHit[]> {
  const q = args.q.trim();
  if (q.length < 2) return [];

  const limit = args.limit ?? 20;
  const allowed = providers.filter((provider) => args.may(provider.requires));

  const answers = await Promise.all(
    allowed.map(async (provider) => {
      try {
        return await provider.find({
          organizationId: args.organizationId,
          q,
          limit,
        });
      } catch {
        return [];
      }
    }),
  );

  return answers
    .flat()
    .sort((a, b) => (b.score ?? 0.5) - (a.score ?? 0.5))
    .slice(0, limit);
}

/**
 * A score from how much of the title the match accounts for.
 *
 * Shared so providers rank the same way as each other — "Ruth" against a
 * contact called Ruth should beat "Ruth" against a note mentioning her, and
 * that is not a judgement each module should make differently.
 */
export function scoreFor(q: string, title: string): number {
  const needle = q.trim().toLowerCase();
  const hay = title.trim().toLowerCase();
  if (!needle || !hay) return 0;
  if (hay === needle) return 1;
  if (hay.startsWith(needle)) return 0.8;
  if (hay.includes(needle)) return 0.6;
  return 0.4;
}
