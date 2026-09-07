import { defineModule } from "@sentrello/module-sdk";
import { registerAccess } from "./access";
import { registerAuthentication } from "./authentication";
import { registerDiagnostics } from "./diagnostics";
import { registerEvents } from "./events";
import { registerGroups } from "./groups";
import { registerPeople } from "./people";
import { pruneAllEvents } from "./retention";
import { registerRolePolicy } from "./roles";
import { registerSessions } from "./sessions";
import { registerSso } from "./sso";

/**
 * Who is on this instance, and what each of them may do.
 *
 * This was a screen for editing roles, which is half the job: an administrator
 * whose bookkeeper has left, or whose foreman has locked himself out, or who
 * has just watched somebody lose their phone with the authenticator on it, was
 * sent to a terminal. On a self-hosted instance the administrator is usually
 * the owner of the business, and "ssh in and run a command" is not a thing
 * they are going to do at half past four on a Friday.
 *
 * Everything here is deliberately behind `settings:update` — the same
 * permission that renames the business — because these are the actions that
 * can hand somebody else's account away.
 */
export default defineModule({
  id: "users",
  tier: "free",
  register(ctx) {
    /**
     * One console, seven screens, rather than one page trying to be all of
     * them.
     *
     * The heading is `users-console` and not `users`, because `users` stays
     * the id of the people screen: it is what existing links and bookmarks
     * name, and repointing it at a heading would land them on a section
     * label instead of the list they asked for.
     *
     * Every entry requires `settings: ["update"]`, including the two the plan
     * had at `read`. That reasoning — reading who did what is not the same
     * authority as changing who may do it — is sound in the abstract and
     * wrong about these routes: `GET /api/users/events` and
     * `GET /api/users/sessions` are both `settings:["update"]` themselves
     * (Ruling 33 raised the first; the second shipped that way), because each
     * aggregates every person in the business into one read. A nav entry
     * gated below the route it opens is a menu item that answers 403, which
     * is worse than not showing it at all.
     */
    ctx.registerNav({
      id: "users-console",
      icon: "users",
      label: "Users",
      order: 91,
      group: "Configure",
      // Adding and removing people is an owner's job, and somebody who cannot
      // do it learns nothing useful from being shown the screen.
      requires: { settings: ["update"] },
    });
    ctx.registerNav({
      id: "users",
      label: "People",
      order: 1,
      parent: "users-console",
      icon: "user",
      requires: { settings: ["update"] },
    });
    ctx.registerNav({
      id: "user-groups",
      label: "Groups",
      order: 2,
      parent: "users-console",
      icon: "users",
      requires: { settings: ["update"] },
    });
    ctx.registerNav({
      id: "user-policies",
      label: "Policies",
      order: 3,
      parent: "users-console",
      icon: "check-square",
      requires: { settings: ["update"] },
    });
    ctx.registerNav({
      id: "user-sessions",
      label: "Sessions",
      order: 4,
      parent: "users-console",
      icon: "clock",
      requires: { settings: ["update"] },
    });
    ctx.registerNav({
      id: "user-auth",
      label: "Authentication",
      order: 5,
      parent: "users-console",
      icon: "key",
      requires: { settings: ["update"] },
    });
    ctx.registerNav({
      id: "user-providers",
      label: "Providers",
      order: 6,
      parent: "users-console",
      icon: "share",
      requires: { settings: ["update"] },
    });
    ctx.registerNav({
      id: "user-events",
      label: "Events",
      order: 7,
      parent: "users-console",
      icon: "clipboard",
      requires: { settings: ["update"] },
    });

    registerGroups(ctx);
    registerSessions(ctx);
    registerSso(ctx);
    // `registerAuthentication` registers `GET`/`PUT /api/users/policy` — two
    // segments, static — and `POST /api/users/:userId/unlock`, three
    // segments and safe either way round. The two-segment pair must stay
    // ahead of `registerPeople`, exactly as it had to when it lived in
    // `registerGroups` above, which this call replaces for that route.
    registerAuthentication(ctx);
    // `registerEvents` registers `GET /api/users/events` — two segments,
    // static, and shadowed by `registerPeople`'s `GET /api/users/:userId` if
    // it were registered after it: `events` would never reach here, because
    // `:userId` already matched it first. Same reasoning as
    // `registerAuthentication` just above, and as `registerSessions` above
    // that — `GET /api/users/:userId/sessions` is three segments and safe
    // either way, but its instance-wide sibling `GET /api/users/sessions` is
    // two and is not, which is why `registerSessions` also sits ahead of
    // `registerPeople`.
    registerEvents(ctx);
    // `registerDiagnostics` registers `GET /api/users/diagnostics` — two
    // segments, static, and shadowed by `registerPeople`'s
    // `GET /api/users/:userId` if it were registered after it, the same
    // reasoning as `registerEvents` and `registerAuthentication` above.
    registerDiagnostics(ctx);
    // `registerRolePolicy` registers `GET /api/users/roles/:role` — three
    // segments, so it cannot collide with `registerPeople`'s two-segment
    // `GET /api/users/:userId` either way round, the same as `registerAccess`
    // just below. It shares its shape with `registerAccess`'s
    // `GET /api/users/:userId/access`, though, and the two patterns collide
    // on the one literal path both could match: a role named `access` (see
    // the comment on the route itself, in `roles.ts`).
    registerRolePolicy(ctx);
    // `registerAccess` registers `GET /api/users/:userId/access` — three
    // segments, so it cannot collide with `registerPeople`'s two-segment
    // `GET /api/users/:userId` either way round. Verified by running this
    // module's suite with the registration in this order.
    registerAccess(ctx);
    // Last, and it has to stay last: `registerPeople` registers
    // `GET /api/users/:userId`, and Hono matches routes in registration
    // order — a static route registered after it, say `GET /api/users/access`
    // for a future task, would never be reached, because `:userId` already
    // matched "access" first. Verified by measurement, not reasoning: moving
    // this call to the front of the list breaks twelve tests in this module's
    // own suite outright. Re-measure rather than trusting that number if you
    // change what is registered — it was four when this comment was first
    // written, and every static route added since has raised it.
    registerPeople(ctx);

    ctx.registerJob({
      name: "prune-events",
      // Nightly, off the hour: nothing else runs at 03:41.
      cron: "41 3 * * *",
      handler: async () => ({ pruned: await pruneAllEvents() }),
    });
  },
});

export { temporaryPassword } from "./password";
