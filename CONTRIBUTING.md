# Contributing

Thank you for looking. This is a small project run by a small company, and a
good bug report is worth as much to us as a pull request.

Please read the [Code of Conduct](CODE_OF_CONDUCT.md) first. It is short.

## What this repository is

Sentrello Core: the free tier, the module system, the host runtime, and the
licensing **client**. It is AGPLv3, and it is a complete product on its own —
not a demo of a paid one.

What is **not** here, and cannot be accepted here: Pro features, the optional
paid modules, the license **signing** key, and anything under a commercial
license. Those live in private repositories. A pull request that adds one of
them cannot be merged whatever its quality, so please ask before starting.

## Reporting a bug

Open an issue with:

- what you did, what happened, and what you expected instead;
- the output of `sentrello status` — version, tier, which modules loaded;
- anything relevant from `sentrello logs`.

Please check `modules_failed` in `/healthz` before reporting a missing screen.
An instance can be perfectly healthy and still have a module that did not
load, and the log says why.

**Do not open an issue for a security problem.** Email
**security@sentrello.com** and give us a reasonable window to fix it. See
[legal/security.md](legal/security.md).

## Suggesting a change

Open an issue before writing code for anything larger than a fix. Not as
bureaucracy — it is so nobody spends a weekend on something that turns out to
belong in a paid module, or that we have already tried and rejected for a
reason worth knowing.

Say what problem you are solving. A feature described as a solution is hard to
discuss; the same thing described as "a business with two vans cannot tell
which invoices are unpaid" is easy.

## Getting it running

You need [Bun 1.3.14](https://bun.sh) exactly, and PostgreSQL 17.

```bash
bun install
cp .env.example .env
docker compose -f docker-compose.dev.yml up -d   # PostgreSQL
bun run db:migrate
bun run dev                                      # API and web
```

`SENTRELLO_BASE_URL` has to be the address your browser actually uses, or every
sign-in is refused — correctly, and with a message saying so.

The tests need a database of their own. They truncate tables, and the gate
below refuses to point at the one you are clicking around in — claiming an
instance in a browser leaves an organization behind, and the bootstrap tests
then fail with conflicts that have nothing to do with your change. One command,
once:

```bash
docker compose -f docker-compose.dev.yml exec -T postgres \
  createdb -U sentrello sentrello_t_core
export DATABASE_URL=postgres://sentrello:sentrello@localhost:5432/sentrello_t_core
```

Keep that exported for anything that runs tests, or they go looking for the
database this project's own machines keep on port 5433.

## Before you open a pull request

```bash
bun run verify
```

That runs the typecheck, the linter, a web build that checks every Tailwind
class name against the stylesheet it produced, the tests, and a pass that
refuses to finish if a suite left rows behind — then prints one word at the
end. Run it bare — do not pipe it through `tail` or `grep`, because a
pipeline's exit code is the last command's and a failing gate then looks
exactly like a passing one.

Everything must be green. If something unrelated is already broken on `main`,
say so in the pull request rather than working around it.

## What we look for

**Tests that could fail.** A test that passes whatever the code does is worse
than no test, because it is believed. The habit here is to break the thing
deliberately and watch the test go red before trusting it.

**Money is integer cents. Always.** Never a float, anywhere, for any reason.
Tax rates are integer millionths — 99750 is 9.975%, Quebec's QST, the rate that
proved basis points too coarse. The arithmetic never leaves the integers:
per-line tax is `Math.round(net * ratePpm / 1_000_000)`.

**Every financial event posts a balanced journal entry.** The ledger is the
source of truth; reports are read from it rather than recalculated. If debits
do not equal credits, the write is refused.

**Every business query carries `organizationId`.** One organization per
instance today; this is what keeps a hosted tier possible later, and leaving it
out is a data leak waiting for a second customer.

**Permissions are checked on the server.** A screen hiding a button is a
convenience. The route decides.

**Comments explain why, not what.** The code already says what it does. The
valuable comment is the one that stops somebody "simplifying" a line that looks
redundant and is not — ideally naming the failure that put it there.

**Migrations are additive and backward-compatible.** The previous version keeps
serving while they run.

## Commit messages

A subject line that says what changed and why it matters, and a body that
explains anything a reader would otherwise have to reconstruct. We use
`type(scope): summary` — `fix(invoicing):`, `feat(crm):`, `docs:`.

Keep the subject to 72 characters, leave the line under it blank, and wrap the
body at 72 as well. Those are checked rather than suggested:

```bash
git config core.hooksPath .githooks
```

That turns on the local hooks — the message rules, and the gate above before
every commit. A fresh clone has them off, which is how a long subject line gets
as far as a pull request.

Write for somebody reading it in a year with no memory of today.

## Licensing your contribution

Contributions are accepted under the AGPLv3, the same license as the rest of
this repository, together with the module linking exception set out at the top
of [LICENSE](LICENSE).

**You keep the copyright in what you write.** Sentrello LLC asks for no
assignment and no contributor license agreement — there is nothing to sign, and
your name stays on your commits. The consequence is worth knowing: because we do
not hold your copyright, we cannot move your code into a paid module or
relicense it. If we ever want to, we will ask you on the pull request and you
are free to say no.

Please do not paste code from another project unless its license permits it and
you say where it came from.

### What happens after you open it

We read every issue and pull request **daily**, and you will get a reply from a
person **within two business days**. A reply is not a commitment to merge or to
fix — it is us telling you what we think and where it sits. If something is
going to take weeks, we will say that rather than leave it quiet.

Security problems do not belong in an issue. [SECURITY.md](SECURITY.md) has
both private routes and the same two-day window, and we would rather hear about
it privately first.

### Sign your work

Every commit in a pull request needs a `Signed-off-by` line, and CI checks each
one before anything else runs. There is no contributor agreement to sign and no
form to fill in — the sign-off is the whole of it, and `git` writes it for you:

```
git commit -s -m "fix(crm): the task list ignored its own filter"
```

That adds a line naming you and your email address:

```
Signed-off-by: Your Name <you@example.com>
```

By adding it you are certifying the [Developer Certificate of Origin
1.1](https://developercertificate.org/), which in plain terms means: you wrote
this, or you have the right to submit it under the license above, and you
understand that your contribution and the record of it are public and stay
public.

The full text:

```
Developer Certificate of Origin
Version 1.1

Copyright (C) 2004, 2006 The Linux Foundation and its contributors.

Everyone is permitted to copy and distribute verbatim copies of this
license document, but changing it is not allowed.


Developer's Certificate of Origin 1.1

By making a contribution to this project, I certify that:

(a) The contribution was created in whole or in part by me and I
    have the right to submit it under the open source license
    indicated in the file; or

(b) The contribution is based upon previous work that, to the best
    of my knowledge, is covered under an appropriate open source
    license and I have the right under that license to submit that
    work with modifications, whether created in whole or in part
    by me, under the same license (unless I am permitted to submit
    under a different license), as indicated in the file; or

(c) The contribution was provided directly to me by some other
    person who certified (a), (b) or (c) and I have not modified
    it.

(d) I understand and agree that this project and the contribution
    are public and that a record of the contribution (including all
    personal information I submit with it, including my sign-off) is
    maintained indefinitely and may be redistributed consistent with
    this project or the open source license(s) involved.
```

If you forget the sign-off, `git commit --amend -s` on the last commit, or
`git rebase --signoff main` across a branch, will add it.

## What happens next

We will read it. If it sits for a week, a polite nudge is welcome and not
rude — it means it was missed rather than ignored.

A change can be well made and still not belong in the product, and that is not
a judgement of the person who wrote it. If we say no, we will say why.
