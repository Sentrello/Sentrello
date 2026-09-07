import { statfs } from "node:fs/promises";
import { resolve } from "node:path";
import { db } from "@sentrello/db";

/**
 * Whether the machine this is running on is in good shape.
 *
 * A self-hosted business owns its own server and nobody is watching it for
 * them. The first they hear of a full disk is usually a failed backup or an
 * invoice that would not save — so the numbers that predict that go on the
 * screen they open every morning.
 *
 * Everything here is cheap enough to run on a page load. Nothing shells out,
 * because the app runs as a non-root user in a container where most of what
 * you would shell out to is not installed.
 */

export interface Health {
  version: string;
  uptimeSeconds: number;
  database: { reachable: boolean; sizeBytes: number | null };
  disk: { freeBytes: number; totalBytes: number; usedPercent: number } | null;
  memory: { usedBytes: number; totalBytes: number } | null;
}

/** The data directory, because that is the one that fills up. */
const dataDir = () => resolve(process.env.SENTRELLO_DATA_DIR ?? "/data");

export async function readHealth(): Promise<Health> {
  const [database, disk] = await Promise.all([databaseHealth(), diskHealth()]);

  return {
    version: process.env.SENTRELLO_VERSION ?? "unknown",
    uptimeSeconds: Math.round(process.uptime()),
    database,
    disk,
    memory: memoryHealth(),
  };
}

async function databaseHealth(): Promise<Health["database"]> {
  try {
    // Size as well as reachability: a database growing faster than expected is
    // the other thing that fills a disk, and it is invisible until it does.
    const rows = await db.execute(
      "select pg_database_size(current_database())::bigint as bytes",
    );
    const bytes = Number((rows[0] as { bytes?: string | number })?.bytes ?? 0);
    return {
      reachable: true,
      sizeBytes: Number.isFinite(bytes) ? bytes : null,
    };
  } catch {
    // Reachability is the answer even when the size query is refused — a
    // managed database may not grant that function to the app's role.
    try {
      await db.execute("select 1");
      return { reachable: true, sizeBytes: null };
    } catch {
      return { reachable: false, sizeBytes: null };
    }
  }
}

async function diskHealth(): Promise<Health["disk"]> {
  try {
    const fs = await statfs(dataDir());
    const total = Number(fs.blocks) * Number(fs.bsize);
    const free = Number(fs.bavail) * Number(fs.bsize);
    if (!Number.isFinite(total) || total <= 0) return null;
    return {
      freeBytes: free,
      totalBytes: total,
      // `bavail` rather than `bfree`: the space this user can actually have,
      // not the space that exists. On many filesystems they differ by the
      // root reserve, and reporting the larger number is how somebody runs
      // out at "5% free".
      usedPercent: Math.round(((total - free) / total) * 100),
    };
  } catch {
    // statfs is not available everywhere, and a dashboard that fails because
    // it could not measure a disk is worse than one that says nothing about it.
    return null;
  }
}

function memoryHealth(): Health["memory"] {
  try {
    const usage = process.memoryUsage();
    // What this process holds, not what the machine has. Inside a container
    // the machine's total is the host's and means nothing to the reader.
    return { usedBytes: usage.rss, totalBytes: usage.rss + usage.external };
  } catch {
    return null;
  }
}
