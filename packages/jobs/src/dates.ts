/*
 * The schedule arithmetic moved to `@sentrello/db/subscriptions`, because the
 * shop needs it too and a paid bundle cannot import this package — only a small
 * set is linked into the container. Re-exported so every existing importer is
 * unchanged and there is still one implementation.
 */
export {
  type Interval,
  nextRun,
} from "@sentrello/db/subscriptions";

export function isOverdue(
  dueDate: Date,
  balanceDueCents: number,
  now = new Date(),
): boolean {
  return balanceDueCents > 0 && dueDate.getTime() < now.getTime();
}
