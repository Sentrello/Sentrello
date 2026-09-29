import { statfsSync } from "node:fs";
import { resolve } from "node:path";

/**
 * How full the volume this instance keeps its data on is.
 *
 * A self-hosted product on somebody's smallest VPS fills its disk. What happens
 * then is not a degraded service: PostgreSQL refuses writes, so invoices cannot
 * be raised, payments cannot be recorded and the ledger stops — and the business
 * whose disk it is has no IT department and is not reading logs. `/healthz` has
 * reported the retention sweep for exactly this reason since it was written, and
 * reported nothing about the disk that sweep exists to protect.
 *
 * Read from the data directory rather than `/`: a deployment that keeps the
 * database on a mounted volume fills that one first, and the root filesystem it
 * is not on stays reassuringly empty.
 *
 * Nothing is thrown. An answer nobody can get — a path that has gone, a
 * platform without `statfs` — is `null`, and every reader treats that as "not
 * known" rather than as trouble.
 */
export function diskState(
  path = resolve(process.env.SENTRELLO_DATA_DIR ?? "."),
): { percentUsed: number; freeBytes: number } | null {
  try {
    const fs = statfsSync(path);
    const total = fs.blocks * fs.bsize;
    const free = fs.bavail * fs.bsize;
    if (!Number.isFinite(total) || total <= 0) return null;
    return {
      // Rounded to whole percent: this is a number somebody reads in a
      // sentence, and nothing acts on the decimal.
      percentUsed: Math.round(((total - free) / total) * 100),
      freeBytes: free,
    };
  } catch {
    return null;
  }
}

/**
 * The threshold at which it is worth interrupting somebody.
 *
 * Ninety rather than the monitor's eighty-five: that one pages us about hosts we
 * run and can act on within the hour, and this one puts a banner on a business's
 * own screens. A banner that appears with a fortnight of room left is a banner
 * people learn to ignore before the day it matters.
 */
export const DISK_WARN_PERCENT = 90;

/** Whether a business should be told, and nothing when it should not. */
export function diskWarning(
  state = diskState(),
): { percentUsed: number; freeBytes: number } | null {
  return state && state.percentUsed >= DISK_WARN_PERCENT ? state : null;
}
