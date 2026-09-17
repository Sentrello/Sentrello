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

/*
 * Late has one definition, and it lives with the money: the badge a customer
 * reads, the "overdue" tab, the account summary and this chase all have to
 * agree about the instant a bill falls due. Re-exported so every existing
 * importer is unchanged and there is still one implementation.
 */
export { isOverdue } from "@sentrello/db/money";
