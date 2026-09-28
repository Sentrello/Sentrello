<!--
Thank you. Everything below is short on purpose; the only parts that are not
optional are the sign-off and a green `bun run verify`.

If this is a draft and you want an opinion before finishing it, open it as a
draft and say so — that is a good use of everybody's time, not an imposition.
-->

## What was wrong

<!-- The problem, in a sentence or two. Not what you changed — the code says
     that. What somebody could not do, or what the product got wrong. -->

## What this does about it

<!-- The approach, and anything a reader would otherwise have to work out for
     themselves. If you tried something else first and it did not work, that is
     worth a line: it stops the next person trying it. -->

Fixes #

## How you can see it working

<!-- The test that fails without this change, or the steps to watch it happen.
     "Break it deliberately and watch the test go red" is the habit here — if
     you did that, say so. -->

---

- [ ] `bun run verify` is green. (Run it bare. Piping it through `tail` or
      `grep` gives you the pipeline's exit code, and a failing gate then looks
      exactly like a passing one.)
- [ ] There is a test that fails without this change, or the change is one that
      cannot have one — and this says which.
- [ ] Every commit is signed off (`git commit -s`). The
      [DCO](https://developercertificate.org/) is the whole of it; there is no
      agreement to sign.
- [ ] Nothing here belongs to Pro or a paid module. This repository is the free
      core and cannot take them, whatever the quality of the code.

<!--
If it touches money, the ledger, permissions or a migration, the four rules in
CONTRIBUTING.md are not negotiable and are the first thing we will read for:
integer cents, balanced entries, `organizationId` on every business query, and
the permission checked on the server rather than hidden on the screen.
-->
