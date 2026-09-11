/**
 * Holding the application itself, so a reload with no connection still opens.
 *
 * This exists for the till. Everything else in Sentrello is something you do at
 * a desk, and a desk with no internet has bigger problems than a blank page —
 * but a counter serving people does not stop because a router did. The till
 * already keeps its menu and queues what it sells; none of that survived
 * somebody pressing reload, because the application is served by the instance
 * and there was nothing to serve it.
 *
 * Three rules, and the reasoning matters more than the code:
 *
 * **The page itself: try the network, fall back to what we have.** A business
 * that updates its instance must get the new application the next time it
 * opens one, so the network wins whenever it answers.
 *
 * **Built assets: what we have, and only ask if we have nothing.** Their names
 * carry a hash of their contents, so a file that is in the cache is the right
 * file for ever. Asking about it is a round trip that can only return the same
 * bytes.
 *
 * **Nothing under /api is ever kept.** A cached answer about money is worse
 * than no answer: a till showing yesterday's stock, or a drawer showing a
 * figure from before the last payout, is a wrong number presented as a fact.
 * Modules that work offline do it deliberately, with their own store, knowing
 * what is stale and saying so.
 *
 * **It does not take over from a running copy.** A new version waits until
 * every tab is closed rather than swapping the code under somebody mid-sale.
 * Coming back tomorrow is soon enough; changing the application between ringing
 * a coffee and taking the money is not.
 */

const CACHE = "sentrello-app-v1";

/**
 * The one key the application itself is kept under.
 *
 * Every path in Sentrello is the same document — the client owns routing — so
 * caching each navigation under its own address would fill the cache with
 * copies and, worse, answer a reload of a page nobody had visited before with
 * nothing at all. One copy, under a name of our own, answers every path.
 *
 * It is a name rather than "/index.html": that file is never requested by that
 * address, so a fallback looking for it found nothing and the reload failed
 * with the worker installed and apparently working. Which is exactly the kind
 * of thing that is only ever found by cutting the line and pressing reload.
 */
const SHELL = "/__app-shell";

self.addEventListener("install", (event) => {
  /*
   * One thing is fetched here: the application itself.
   *
   * It has to be. A worker installs *after* the page that registered it has
   * loaded, so the very first visit is never intercepted and nothing is kept —
   * and the first reload with the line down then failed, with the worker
   * installed and every appearance of working. Asking for it once at install is
   * what makes the first shift the till has after an update survive an outage
   * rather than the second.
   *
   * Nothing else is listed. Asset names are decided by the bundler and this
   * file is not built, so a list here would be a list to keep in step — and a
   * precache list that drifts fails the install, taking the offline support
   * with it. Everything else is kept as the application asks for it, which is
   * by definition the right set.
   */
  event.waitUntil(
    (async () => {
      try {
        const shell = await fetch("/", { cache: "reload" });
        if (shell.ok) (await caches.open(CACHE)).put(SHELL, shell);
      } catch (unreachable) {
        // Installed with no connection: there is nothing to keep and nothing
        // to be done about it. The next load with a line will fill it.
      }
    })(),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(
        names
          .filter((name) => name !== CACHE)
          .map((name) => caches.delete(name)),
      );
      await self.clients.claim();
    })(),
  );
});

/** Content-hashed, so a hit is correct for ever. */
function isBuiltAsset(url) {
  return url.pathname.startsWith("/assets/");
}

/** A page being opened, as opposed to something the page then fetches. */
function isPageLoad(request) {
  return request.mode === "navigate";
}

async function fromCacheFirst(request) {
  const cached = await caches.match(request);
  if (cached) return cached;
  const answer = await fetch(request);
  if (answer.ok) (await caches.open(CACHE)).put(request, answer.clone());
  return answer;
}

async function fromNetworkFirst(request, keepAs) {
  try {
    const answer = await fetch(request);
    if (answer.ok) {
      (await caches.open(CACHE)).put(keepAs ?? request, answer.clone());
    }
    return answer;
  } catch (unreachable) {
    const cached = await caches.match(keepAs ?? request);
    if (cached) return cached;
    throw unreachable;
  }
}

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  // Somebody else's server is their business, not ours to keep.
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith("/api/")) return;

  if (isPageLoad(request)) {
    // Every path in this application is the same document — the client owns
    // routing — so a reload of /pos with no connection is answered with the
    // application, which then finds its own way back to the till.
    event.respondWith(fromNetworkFirst(request, SHELL));
    return;
  }

  if (isBuiltAsset(url)) {
    event.respondWith(fromCacheFirst(request));
    return;
  }

  // A module's screens, and anything else the application asks for: fresh when
  // there is a connection, and what we had when there is not.
  event.respondWith(fromNetworkFirst(request));
});
