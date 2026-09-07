# Contributing

Thank you for looking. This is a small project run by a small company, and a
good bug report is worth as much to us as a pull request.

Please read the [Code of Conduct](CODE_OF_CONDUCT.md) first. It is short.

## What this repository is

Sentrello Core: the free tier, the module system, the host runtime, and the
licensing **client**. It is AGPLv3, and it is a complete product on its own —
not a demo of a paid one.

What is **not** here, and cannot be accepted here: Pro features, the optional
paid modules, the licence **signing** key, and anything under a commercial
licence. Those live in private repositories. A pull request that adds one of
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
docker compose -f docker-compose.dev.yml up -d   # PostgreSQL
bun run db:migrate
bun run dev                                      # API and web
```

`SENTRELLO_BASE_URL` has to be the address your browser actually uses, or every
sign-in is refused — correctly, and with a message saying so.

Use a database that is not the one the tests use. Claiming an instance in the
browser leaves an organization behind, and the bootstrap tests then fail with
conflicts that have nothing to do with your change.

## Before you open a pull request

```bash
bun run verify
```

That runs the typecheck, the linter and the tests, and prints one word at the
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
Tax rates are basis points — 875 is 8.75%.

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

Write for somebody reading it in a year with no memory of today.

## Licensing your contribution

Contributions are accepted under the AGPLv3, the same licence as the rest of
this repository, together with the module linking exception set out at the top
of [LICENSE](LICENSE).

Please do not paste code from another project unless its licence permits it and
you say where it came from.

### Sign your work

Every commit needs a `Signed-off-by` line. There is no contributor agreement to
sign and no form to fill in — the sign-off is the whole of it, and `git` writes
it for you:

```
git commit -s -m "fix(crm): the task list ignored its own filter"
```

That adds a line naming you and your email address:

```
Signed-off-by: Your Name <you@example.com>
```

By adding it you are certifying the [Developer Certificate of Origin
1.1](https://developercertificate.org/), which in plain terms means: you wrote
this, or you have the right to submit it under the licence above, and you
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
