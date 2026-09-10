/**
 * How a plugin reaches the module it plugs into.
 *
 * Modules cooperate through the database wherever they can: Shop's orders reach
 * Accounting because both read the same ledger, and neither knows the other
 * exists. That is the right default and it covers most of what modules do to
 * each other, which is *read*.
 *
 * A plugin is the case it does not cover. A till sells the same catalogue at
 * the same prices against the same stock, and its sale has to become the same
 * order a website sale becomes. Rewriting that against the tables would copy
 * the part of the host that is hardest to get right — a price computed twice is
 * a price that eventually differs — so a plugin needs the host's own functions.
 *
 * **It cannot import them.** A bundle is shipped on its own and the container
 * links only the platform's packages; one bundle importing another resolves on
 * a developer's machine and fails on a customer's. `bundle-contract.test.ts`
 * refuses it, correctly, and refused this.
 *
 * So a host *offers* and a plugin *asks*, at run time. `requires` guarantees
 * the order: the loader will not start a plugin whose host is absent, so
 * anything registered by the host is there before the plugin's first request.
 *
 * The name is the contract. `provide("shop", …)` and `moduleService("shop")` have
 * to agree, and nothing checks that they do beyond the plugin finding nothing
 * and saying so — which is the honest failure, and better than a build that
 * passes and an instance that does not run.
 */

const registry = new Map<string, unknown>();

/**
 * Offer something to the modules that require this one.
 *
 * Replaced rather than refused if the name is taken, so a host reloaded in a
 * test does not have to unregister first.
 */
export function provideService(name: string, value: unknown): void {
  registry.set(name, value);
}

/**
 * Ask for what a host offered.
 *
 * Throws when it is missing, and says which name it wanted. A plugin reaching
 * for a host that is not loaded is a mistake in `requires`, not a condition to
 * handle — returning undefined would push the same failure a few lines further
 * on, where it reads as a bug in the plugin instead.
 */
export function moduleService<T>(name: string): T {
  const found = registry.get(name);
  if (found === undefined) {
    throw new Error(
      `no module offers "${name}" — a plugin needs it in its \`requires\``,
    );
  }
  return found as T;
}

/** Whether a host is there, for the rare caller that can do without. */
export function hasService(name: string): boolean {
  return registry.has(name);
}

/** For tests, and for a host that loads its modules more than once. */
export function clearServices(): void {
  registry.clear();
}
