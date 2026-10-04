import { spawnSync } from "node:child_process";

/**
 * `git` asked a question in a repository, with this process's git environment
 * out of the way.
 *
 * **Why the environment has to go.** Every guard here that reads a file list
 * shells out to `git ls-files`, and several of them ask it in the *other*
 * repositories beside this one. During a commit, git sets `GIT_INDEX_FILE`,
 * `GIT_DIR` and friends in the hook's environment — so `git ls-files` run with
 * `cwd` pointing at Modules read **Core's** index instead, answered with Core's
 * file list, and the guard drew its conclusion about the wrong repository.
 *
 * It failed only some of the time, which is the worst version of this. A plain
 * `git commit` leaves `GIT_INDEX_FILE` unset and every guard passed; `git commit
 * --amend --only`, a rebase and a merge all set it, and then one guard failed
 * four times out of four with a message about a module dependency that was
 * perfectly fine. Reproduced on 4 October 2026 by building a temporary index
 * from HEAD and running the suite against it.
 *
 * So: one place that asks git, with the inherited variables stripped. A guard
 * that reads another repository has no business reading this one's index, and a
 * guard that reads this one wants the checkout rather than whatever index a
 * command happens to be holding open.
 */
const INHERITED = [
  "GIT_INDEX_FILE",
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_COMMON_DIR",
  "GIT_PREFIX",
  "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
];

export function gitLines(args: string[], cwd: string): string[] | null {
  const env = { ...process.env };
  for (const name of INHERITED) delete env[name];

  const ran = spawnSync("git", args, { cwd, encoding: "utf8", env });
  if (ran.status !== 0) return null;
  return ran.stdout.split("\n").filter(Boolean);
}
