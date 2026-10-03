/**
 * Every test starts with a fresh rate-limit budget.
 *
 * Load it as a `[test] preload` and it registers for the whole run:
 *
 *     preload = ["@sentrello/module-sdk/fresh-rate-limit"]
 *
 * The limiter is one `Map` at module scope and `bun test` runs the whole suite
 * in one process, so every file in the run shares it. That makes a test's
 * budget depend on how many tests happened to run before it, which is the
 * definition of a test that fails for the wrong reason.
 *
 * It was survivable while few routes were limited and somebody remembered a
 * `resetRateLimits()` at the top of the ones that mattered. Then the public
 * writes that had none got one — booking's page forms, the storefront's
 * payment step, a customer sign-up — and two suites went red on tests about
 * neither: an order test refused with "basket refused: 429" because the
 * payment route had started counting against a budget earlier tests in the
 * same file had spent, and a service-area test the same way. Nothing in
 * either was wrong.
 *
 * Four files had grown a `beforeEach` of their own by then, which is four
 * copies of one rule and a fifth waiting for the next limited route. They are
 * gone; this is the rule.
 *
 * **Here rather than in each repository's `scripts/`.** The other shared
 * guards are copied into all four and checked for drift; this one is a module
 * of the SDK, which every repository already depends on, so there is one copy
 * and nothing to drift. The first attempt was a copied script and it could not
 * resolve `@sentrello/module-sdk` from a repository's `scripts/` directory at
 * all — the failure was the design telling us where the file belonged.
 *
 * **A limit is still tested, deliberately.** A test that wants to prove a
 * ceiling counts up to it inside itself, which is what every one of them
 * already does: a limit proved across two `test()` calls is a limit proved by
 * accident.
 */
import { beforeEach } from "bun:test";
import { resetRateLimits } from "./public-endpoints";

beforeEach(() => {
  resetRateLimits();
});
