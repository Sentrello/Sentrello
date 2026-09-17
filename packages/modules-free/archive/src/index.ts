import {
  activeOrganizationId,
  requirePermission,
  requireSession,
} from "@sentrello/auth/hono";
import {
  archiveSets,
  planArchive,
  restoreArchive,
  retentionYears,
} from "@sentrello/db/archive";
import { type RouteContext, defineModule } from "@sentrello/module-sdk";
import {
  archiveDestination,
  destinationFor,
  destinationSummary,
  saveDestination,
} from "./destinations";
import { forgetFile, runArchive, runFor, runsFor } from "./runs";

/**
 * Archive and offload — taking old data off a server without losing it.
 *
 * A self-hosted business fills its disk after a few years and the only answer
 * we had was a bigger machine. This is the second answer, and the difference
 * between it and a delete button is the whole of the work: the archive is
 * written, read back from where it was written and matched against what the
 * database says, and only then is anything removed. A business that archives
 * 2019 and finds the file corrupt still has 2019.
 *
 * **Free, not Pro, and deliberately.** The business most likely to run out of
 * disk is the one on the smallest machine, and a business that cannot archive
 * deletes instead — with a DELETE somebody found on a forum, at three in the
 * morning, with no copy of anything. Putting the safe route behind a licence
 * would make the unsafe one the free one, and we would have handed them the
 * outcome.
 *
 * `archive` is its own permission resource rather than an action on `settings`,
 * for the same reason `payments` is its own rather than an action on
 * `bookkeeping`: taking a copy of the books and destroying five years of them
 * are not the same authority. `read` looks, `create` writes a copy, `delete` is
 * the one that removes local rows, and `connect` configures where archives go.
 * Only the owner's role holds `delete` and `connect` by default.
 */

/** A period has to be whole calendar months, and this says whether it is. */
export function wholeMonths(from: Date, to: Date): boolean {
  const startsMonth =
    from.getUTCDate() === 1 &&
    from.getUTCHours() === 0 &&
    from.getUTCMinutes() === 0 &&
    from.getUTCSeconds() === 0 &&
    from.getUTCMilliseconds() === 0;
  const dayAfter = new Date(to.getTime() + 1);
  const endsMonth =
    dayAfter.getUTCDate() === 1 &&
    dayAfter.getUTCHours() === 0 &&
    dayAfter.getUTCMinutes() === 0 &&
    dayAfter.getUTCSeconds() === 0 &&
    dayAfter.getUTCMilliseconds() === 0;
  return startsMonth && endsMonth;
}

/**
 * The period from a request, as whole months.
 *
 * Whole months because that is the unit a closed period is carried forward in:
 * a report boundary inside an archived month would have nothing left to answer
 * with. Asking for `2019-01` to `2019-12` and being given exactly that is also
 * how an operator avoids the off-by-one that makes an archive quietly miss the
 * 31st of December.
 */
function periodOf(
  value: unknown,
): { from: Date; to: Date } | { error: string } {
  const body = (value ?? {}) as { from?: unknown; to?: unknown };
  const month = (input: unknown) =>
    typeof input === "string" && /^\d{4}-\d{2}$/.test(input.trim())
      ? input.trim()
      : null;
  const first = month(body.from);
  const last = month(body.to);
  if (!first || !last) {
    return { error: "a period is two months, like 2019-01 and 2019-12" };
  }
  const [fromYear, fromMonth] = first.split("-").map(Number) as [
    number,
    number,
  ];
  const [toYear, toMonth] = last.split("-").map(Number) as [number, number];
  const from = new Date(Date.UTC(fromYear, fromMonth - 1, 1));
  const to = new Date(Date.UTC(toYear, toMonth, 1) - 1);
  if (from.getTime() > to.getTime()) {
    return { error: "that period ends before it starts" };
  }
  return { from, to };
}

const MAX_RESTORE_BYTES = 512 * 1024 * 1024;

export default defineModule({
  id: "archive",
  tier: "free",
  register(ctx) {
    ctx.registerNav({
      id: "settings-archive",
      label: "Archive and storage",
      icon: "boxes",
      order: 90.09,
      parent: "settings",
      group: "Configure",
      requires: { archive: ["read"] },
    });
    for (const action of ["read", "create", "delete", "connect"]) {
      ctx.registerPermission(`archive:${action}`);
    }

    /**
     * What this instance can archive, and what its country's floor is.
     *
     * The floor is stated up front rather than only appearing as a refusal:
     * somebody planning to free a disk should learn "six years" before they
     * have chosen a period, not after.
     */
    ctx.app.get(
      "/api/archive/sets",
      requireSession(),
      requirePermission({ archive: ["read"] }),
      async (c: RouteContext) => {
        const orgId = activeOrganizationId(c.get("session"));
        const { retention } = await planArchive(
          orgId,
          "activity",
          new Date(0),
          new Date(0),
        ).catch(() => ({
          retention: { years: 0, countryCode: null, cutoff: new Date() },
        }));
        return c.json({
          sets: archiveSets().map((set) => ({
            id: set.id,
            label: set.label,
            description: set.description,
            statutory: set.statutory,
            requiresClosedBooks: Boolean(set.requiresClosedBooks),
            carriesForward: Boolean(set.carriesForward),
          })),
          retention,
        });
      },
    );

    /** What a period holds, and whether it may be removed. Reads nothing else. */
    ctx.app.get(
      "/api/archive/plan",
      requireSession(),
      requirePermission({ archive: ["read"] }),
      async (c: RouteContext) => {
        const orgId = activeOrganizationId(c.get("session"));
        const period = periodOf({
          from: c.req.query("from"),
          to: c.req.query("to"),
        });
        if ("error" in period) return c.json({ error: period.error }, 400);
        const plan = await planArchive(
          orgId,
          c.req.query("set") ?? "",
          period.from,
          period.to,
        );
        return c.json({
          set: plan.set.id,
          from: plan.from.toISOString(),
          to: plan.to.toISOString(),
          counts: plan.counts,
          rows: plan.rows,
          blockers: plan.blockers,
          retention: plan.retention,
        });
      },
    );

    /**
     * Do it.
     *
     * `remove` is the whole difference between a copy and an offload, and it
     * carries its own permission. Without it — or with anything at all standing
     * in the way — the archive is written and verified and every local row
     * stays, which is the right outcome for a business inside its retention
     * window that wants a copy off-site.
     */
    ctx.app.post(
      "/api/archive/runs",
      requireSession(),
      requirePermission({ archive: ["create"] }),
      async (c: RouteContext) => {
        const session = c.get("session");
        const orgId = activeOrganizationId(session);
        const body = (await c.req.json().catch(() => ({}))) as Record<
          string,
          unknown
        >;
        const period = periodOf(body);
        if ("error" in period) return c.json({ error: period.error }, 400);

        const plan = await planArchive(
          orgId,
          typeof body.set === "string" ? body.set : "",
          period.from,
          period.to,
        );
        if (!wholeMonths(plan.from, plan.to)) {
          return c.json(
            { error: "a period has to be whole calendar months" },
            400,
          );
        }

        const remove = body.remove === true;
        if (remove) {
          const { mayAccess } = await import("@sentrello/auth/hono");
          if (!(await mayAccess(c.req.raw.headers, { archive: ["delete"] }))) {
            return c.json(
              {
                error: "you may write an archive but not remove what it holds",
              },
              403,
            );
          }
        }

        const outcome = await runArchive(
          orgId,
          plan,
          await destinationFor(orgId),
          {
            remove,
            actor: session.user.id,
          },
        );
        return c.json(
          {
            run: outcome.run,
            removed: outcome.removed,
            blockers: plan.blockers,
            rows: outcome.verification.counts,
          },
          201,
        );
      },
    );

    ctx.app.get(
      "/api/archive/runs",
      requireSession(),
      requirePermission({ archive: ["read"] }),
      async (c: RouteContext) =>
        c.json({ runs: await runsFor(activeOrganizationId(c.get("session"))) }),
    );

    /** The file itself, streamed from wherever it was put. */
    ctx.app.get(
      "/api/archive/runs/:id/download",
      requireSession(),
      requirePermission({ archive: ["read"] }),
      async (c: RouteContext) => {
        const orgId = activeOrganizationId(c.get("session"));
        const run = await runFor(orgId, c.req.param("id") ?? "");
        if (!run || !run.locator) {
          return c.json(
            { error: "that archive is no longer on this server" },
            404,
          );
        }
        const destination = archiveDestination(run.destinationId);
        if (!destination) {
          return c.json(
            { error: `this instance can no longer reach ${run.destinationId}` },
            409,
          );
        }
        const config = (await destinationFor(orgId)).config;
        const stream = new ReadableStream<Uint8Array>({
          async start(controller) {
            try {
              for await (const chunk of destination.get(config, run.locator)) {
                controller.enqueue(chunk);
              }
              controller.close();
            } catch (err) {
              controller.error(err);
            }
          },
        });
        return new Response(stream, {
          headers: {
            "content-type": "application/zip",
            "content-disposition": `attachment; filename="${run.filename}"`,
          },
        });
      },
    );

    /**
     * Clear the copy at the destination once it is somewhere else.
     *
     * The run row stays, with its checksum: what left and when is a thing a
     * business needs to be able to answer long after the file has gone.
     */
    ctx.app.delete(
      "/api/archive/runs/:id/file",
      requireSession(),
      requirePermission({ archive: ["delete"] }),
      async (c: RouteContext) => {
        const orgId = activeOrganizationId(c.get("session"));
        const run = await runFor(orgId, c.req.param("id") ?? "");
        if (!run) return c.json({ error: "no such archive" }, 404);
        await forgetFile(orgId, run, await destinationFor(orgId));
        return c.json({ ok: true });
      },
    );

    /**
     * Take one back.
     *
     * `inspect` checks the file and reports what is in it without writing
     * anything, which is what somebody who has found an old zip in a drawer
     * actually wants first. `restore` puts the records back where they were.
     */
    ctx.app.post(
      "/api/archive/restore",
      requireSession(),
      requirePermission({ archive: ["create"] }),
      async (c: RouteContext) => {
        const orgId = activeOrganizationId(c.get("session"));
        const form = await c.req.formData().catch(() => null);
        const file = form?.get("file");
        if (!(file instanceof File) || file.size === 0) {
          return c.json({ error: "choose an archive file to read" }, 400);
        }
        if (file.size > MAX_RESTORE_BYTES) {
          return c.json(
            { error: "that file is too large to read in one request" },
            413,
          );
        }
        const inspecting = String(form?.get("mode") ?? "inspect") !== "restore";

        const open = () =>
          file.stream() as unknown as AsyncIterable<Uint8Array>;
        if (inspecting) {
          const { verifyArchive } = await import("@sentrello/db/archive");
          const verified = await verifyArchive(open());
          return c.json({
            inspected: true,
            manifest: verified.manifest,
            counts: verified.counts,
            mine: verified.manifest.organizationId === orgId,
          });
        }
        const restored = await restoreArchive(orgId, open);
        return c.json({
          inspected: false,
          manifest: restored.manifest,
          inserted: restored.inserted,
          skipped: restored.skipped,
          summariesRemoved: restored.summariesRemoved,
        });
      },
    );

    // --- where archives go, configured here and nowhere else ---------------
    ctx.app.get(
      "/api/archive/destination",
      requireSession(),
      requirePermission({ archive: ["read"] }),
      async (c: RouteContext) =>
        c.json(
          await destinationSummary(activeOrganizationId(c.get("session"))),
        ),
    );

    ctx.app.put(
      "/api/archive/destination",
      requireSession(),
      requirePermission({ archive: ["connect"] }),
      async (c: RouteContext) => {
        const orgId = activeOrganizationId(c.get("session"));
        const body = (await c.req.json().catch(() => ({}))) as Record<
          string,
          unknown
        >;
        const id = typeof body.id === "string" ? body.id : "";
        const values = (body.values ?? {}) as Record<string, string>;
        try {
          await saveDestination(orgId, id, values);
        } catch (err) {
          return c.json({ error: (err as Error).message }, 400);
        }
        return c.json(await destinationSummary(orgId));
      },
    );

    /**
     * Prove it before anything is trusted to it.
     *
     * Tested with what is about to be saved rather than with what is stored, so
     * somebody can find out a key is wrong before it becomes the configuration.
     */
    ctx.app.post(
      "/api/archive/destination/test",
      requireSession(),
      requirePermission({ archive: ["connect"] }),
      async (c: RouteContext) => {
        const orgId = activeOrganizationId(c.get("session"));
        const body = (await c.req.json().catch(() => ({}))) as Record<
          string,
          unknown
        >;
        const id =
          typeof body.id === "string"
            ? body.id
            : (await destinationFor(orgId)).id;
        const destination = archiveDestination(id);
        if (!destination)
          return c.json({
            ok: false,
            detail: `there is no destination called "${id}"`,
          });
        const stored = await destinationFor(orgId);
        const config = {
          ...stored.config,
          ...((body.values ?? {}) as Record<string, string>),
        };
        return c.json(await destination.test(config));
      },
    );
  },
});

export { retentionYears };
