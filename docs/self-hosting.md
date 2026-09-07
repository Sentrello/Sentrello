# Running Sentrello yourself

Everything here applies to the Free tier, which is this repository.

```bash
curl -fsSL https://get.sentrello.com | bash
```

The installer asks four questions — a licence key (blank for Free), the
domain, an administrator email, and whether to send usage reports — then
generates its own database password and signing secrets, starts PostgreSQL and
the app, and runs the migrations. It prints a **setup token** at the end — the
first screen asks for it, which is what stops somebody who finds your address
before you do from claiming your instance.

The app listens on `127.0.0.1:3000`. It is deliberately not exposed, and **the
installer does not set up a reverse proxy or TLS for you** — putting those in
front is the one part that is yours. It is the next section.

---

## Before you start

### The machine

- **Linux, x86-64 or ARM64.** The installer refuses anything else, because
  those are the two architectures the images are built for.
- **1 GB of memory works; 2 GB is more comfortable.** The installer sizes
  PostgreSQL from whatever it finds — a quarter of memory for shared buffers,
  half as the cache estimate. Verified on a 1 GB server with no swap: the
  install completes and the instance settles around 630 MB used of 960 MB,
  with PostgreSQL given 240 MB of shared buffers. That is the entry size most
  providers sell, so it is the size this was tested at. A busy instance, or
  one with several optional modules, wants more.
- **Add swap if your provider gives you none.** A 1 GB server with no swap has
  no margin for a moment of pressure, and most cloud images ship without any.
- **A few GB of disk**, mostly the images and your own data. The database, the
  files you upload and the backups all live under the install directory.
- Do **not** build the images on a small server. Pull them, which is what the
  installer does.

### What must already be installed

**A container engine, and a way to run a compose file.** Those are two things,
and the second is the one people are missing:

| Engine | What else you need | Check it with |
|---|---|---|
| Docker | a **Compose v2 plugin** — package name differs, see below | `docker compose version` |
| Podman | a compose provider — `podman-compose`, or a `docker-compose` binary for `podman compose` to hand the file to | `podman compose version` |

`docker` on its own is not enough. The installer checks for the plugin and
stops with `docker compose plugin is required` rather than failing halfway
through, but it is quicker to install it first.

**The package is named differently depending on where you get Docker**, which
is the part that catches people out:

```bash
# Ubuntu and Debian, using the distribution's own packages
apt install docker.io docker-compose-v2

# any distribution, using Docker's own repository (https://get.docker.com)
apt install docker-ce docker-compose-plugin      # Debian/Ubuntu
dnf install docker-ce docker-compose-plugin      # RHEL, Rocky, Alma
```

There is no `docker-compose-plugin` in Ubuntu's repositories — that name only
exists in Docker's own — and the old `docker-compose` (v1, a separate Python
program) is not what the installer looks for. Either line above gives a
working `docker compose version`, which is the only thing that matters.

Verified on a fresh Ubuntu 24.04 server: `docker.io` and `docker-compose-v2`
from Ubuntu's own repositories are enough, and the installer runs straight
through.

**On Podman**, `apt install podman podman-compose` is enough, and was verified
the same way. Podman on its own is not: the installer stops and names the three
ways to get a provider rather than leaving you to work it out.

`podman-docker` is a different thing again — it provides a `docker` command
that is really Podman, and **it does not provide compose**. It is worth knowing
that installing it changes which engine the installer picks: `docker` is then
on the PATH, so Docker is chosen, and the whole stack runs through Podman's
Docker emulation. That was verified to work end to end, but if you want the
Podman path taken explicitly, set `SENTRELLO_ENGINE=podman`.

**`curl`**, which the install line itself uses.

A host with both engines gets Docker, because it is looked for first. Set
`SENTRELLO_ENGINE=podman` to override that.

**Rootless Podman needs two more things**, and the installer will try to set
them up and tell you if it cannot: the user socket (`systemctl --user start
podman.socket`) and lingering (`loginctl enable-linger $USER`), without which
your instance stops the moment you log out.

### Where to run it

The installer puts everything in **`/opt/sentrello`** by default: the compose
file, `secrets/.env`, the database volume, backups and bundles.

**You do not have to be root.** Root is only needed to create that directory —
if you are not root and cannot create it, the installer uses `sudo` for that
one step and then hands ownership to your own user. If you would rather keep
it out of `/opt` entirely, set the directory yourself and no privileges are
needed at all:

```bash
SENTRELLO_HOME=~/sentrello bash -c "$(curl -fsSL https://get.sentrello.com)"
```

Running the whole thing as root works and is what most single-purpose servers
do. Running rootless Podman as an ordinary user is the stricter choice, and
the installer supports it — see the two requirements above.

### DNS, before you install

The installer asks for the domain and writes it into `SENTRELLO_BASE_URL`.
Point the name at the server first, so the certificate step afterwards has
something to validate against.

---

## A domain or a subdomain

Sentrello does not care which, and nothing in it needs to live at the root of
a name. What matters is that **`SENTRELLO_BASE_URL` is exactly the address
people type**, including the `https://` and any `www.`

- **A subdomain** — `app.yourbusiness.com`, `office.yourbusiness.com` — is the
  usual choice, and the one to make if your website already lives at the
  domain. Add an `A` record for the subdomain, point it at the server, and
  leave the website alone. Two names on one server can share nginx: one
  `server` block each.
- **The domain itself** — `yourbusiness.com` — is fine if nothing else is
  there. Add `A` records for both `yourbusiness.com` and `www.yourbusiness.com`
  if you want the `www.` to work, pick one as canonical, and redirect the other
  to it. Whichever you pick is what goes in `SENTRELLO_BASE_URL`.

Sentrello is **not** designed to be served from a path — `yourbusiness.com/app`
is not a supported layout. Give it a name of its own.

If you get the base URL wrong, sign-in refuses with a message that says so:
the origin check compares what the browser sent against what you configured.
That is the same setting the Users console's Authentication screen reads, and
it warns there when the two disagree, or when the base URL is not `https`.

---

## On a cloud server, or on your own hardware

The install is the same. What differs is how the certificate is obtained and
what the machine can reach.

**On a cloud server** — a VPS, a droplet, an EC2 instance — with a public DNS
record, everything below works as written: ports 80 and 443 open to the
internet, Let's Encrypt validates over HTTP, and certbot or Caddy renews it.
Leave 3000 closed; the app binds loopback and only the proxy needs to reach it.

**On your own hardware**, on a network with no public DNS record, HTTP
validation cannot work — Let's Encrypt has no way to reach you. Three options,
in the order most businesses should consider them:

1. **A real name with DNS-01 validation.** Keep using a domain you own, and
   let certbot prove ownership through a DNS record instead of a web request.
   The instance stays on your LAN and the certificate is publicly trusted.
2. **Your own certificate authority**, if you already run one — an internal CA
   whose root is on the company's machines.
3. **A self-signed certificate**, which works and which every browser will warn
   about until somebody installs it as trusted on each machine.

What you cannot do is run it on plain HTTP and expect sign-in to work. The
session cookie is marked `Secure`, so a browser will not send it back over
HTTP: sign-in appears to succeed and then does nothing, which is a confusing
enough failure that the Authentication screen warns about it explicitly.

An on-premise instance also has no route to `sentrello.com`, which for the Free
tier costs nothing at all — there is nothing to check in with. A Pro instance
needs to reach it to refresh its licence token, and runs for 72 hours between
refreshes before degrading to Free.

---

## What it talks to

A Free instance can run forever without contacting us at all. There is no
registration, no key, and nothing that expires.

| Call | Where it goes | Whose account |
|---|---|---|
| Everything the app does | your own instance | yours |
| Email, if you configure it | Resend or your SMTP server | yours |
| Card payments, if you enable them | Stripe or PayPal | yours |
| Usage report, **only if you say yes** | sentrello.com | ours |

The usage report is the only thing that ever reaches us, it is off unless you
answer yes at install, and you can turn it off afterwards in Settings. It
sends: the version you run, whether you are Free or Pro, which modules are
loaded, and a band for how many people use it (`1`, `2-5`, `6-10`, `11-20`,
`21+`). It never sends customer records, names, addresses, figures, or anything
that identifies your business.

Your database is on your server. Query it, back it up, move it. If this project
disappeared tomorrow your instance keeps running.

---

## Putting TLS in front of it

Any reverse proxy works. Two that people use:

**Caddy**, which gets a certificate on its own:

```
app.yourbusiness.com {
    reverse_proxy 127.0.0.1:3000
}
```

**nginx**, with certbot. Neither is installed by the Sentrello installer, so
on a bare server start with them:

```bash
sudo apt install -y nginx certbot python3-certbot-nginx   # Ubuntu, Debian
sudo dnf install -y nginx certbot python3-certbot-nginx   # Rocky, RHEL, Fedora
```

Then the site itself:

```nginx
server {
    server_name app.yourbusiness.com;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    client_max_body_size 10m;
}
```

Then `certbot --nginx -d app.yourbusiness.com`.

Whatever you use, the address must match `SENTRELLO_BASE_URL` in
`/opt/sentrello/secrets/.env`. Links in emails and on customer-facing pages are
built from it, and a mismatch is why a customer receives a link pointing at
`localhost`. Settings tells you when the two disagree.

### Which header carries a visitor's real address

Sentrello trusts `x-real-ip` by default, which is what the nginx example
above sets from `$remote_addr` — a header your own proxy writes, not one a
client can hand it. Nothing installs that proxy for you, so nothing guarantees
the header: if you use Caddy, Traefik, a load balancer or a cloud ingress,
check which header it sets and point Sentrello at it in
`/opt/sentrello/secrets/.env`.

This is worth getting right rather than leaving. Sign-in rate limiting, the
account lockout and the address shown beside a session all key on it — so a
wrong header means every request appears to come from the proxy, and one
person guessing passwords locks out everybody at once. The Users console's
Authentication screen shows which header is in use and what the current
request resolved to, which is the quickest way to check it is what you think.

```sh
# Which header carries the caller's real address. Default `x-real-ip`, which
# the nginx example above sets from $remote_addr. Change it to match whatever
# proxy you actually put in front, and never to `x-forwarded-for` unless
# SENTRELLO_TRUSTED_PROXIES also names every hop — that header is written by
# the caller.
SENTRELLO_CLIENT_IP_HEADER=x-real-ip
# Comma-separated proxy addresses or CIDR ranges, for deployments that must
# use a forwarded chain.
SENTRELLO_TRUSTED_PROXIES=
```

An instance reached directly, with no proxy at all, must not be reading a
forwarded header — anyone talking to it could set one and pick their own
address.

---

## Email

Optional, and worth doing: without it, a password reset has nowhere to go and
invoices cannot be emailed. Either of these in
`/opt/sentrello/secrets/.env`, then `sentrello restart`:

```sh
RESEND_API_KEY=re_...
EMAIL_FROM="Your Business <billing@yourbusiness.com>"
```

```sh
SMTP_HOST=smtp.yourprovider.com
SMTP_PORT=587
SMTP_USER=...
SMTP_PASS=...
EMAIL_FROM="Your Business <billing@yourbusiness.com>"
```

If mail is not configured and you are locked out, use the terminal instead:

```bash
sentrello reset-password you@yourbusiness.com
```

From **0.18**, a repeated wrong password locks the address for a few minutes —
by design, so guessing cannot run forever — but that also means the one person on a
self-hosted instance with nobody else to ask for help can lock themselves
out. `sentrello reset-password` already clears the lock along with setting a
new password; if the password itself is fine and only the lock is the
problem, clear it on its own:

```bash
sentrello unlock you@yourbusiness.com
```

---

## Backups

```bash
sentrello backup                 # a dump you can keep
sentrello restore backups/<file> # put one back
```

Two things worth knowing. Every update takes a backup first and **refuses to
proceed without one** — an update that cannot back up is an update that should
not happen. (`--no-backup` overrides that, and exists for the case where you
have just taken one yourself.) And a backup on the same disk as the database is
not a backup:
copy them somewhere else, on a schedule, and try a restore before you need one.

The whole instance is `/opt/sentrello`. The database dump plus that directory
is everything.

One thing that directory does **not** contain is the database volume itself,
which belongs to the container engine. So `rm -rf /opt/sentrello` leaves the
data behind, and reinstalling afterwards meets a database that still expects
the old password. To remove an instance completely:

```bash
cd /opt/sentrello && docker compose down -v   # or podman-compose down -v
rm -rf /opt/sentrello /usr/local/bin/sentrello
```

---

## Updating, and going back

```bash
sentrello status     # what you are running, and whether anything is newer
sentrello update     # takes a backup, pulls, migrates, restarts
sentrello rollback   # the previous version, if the new one is wrong
```

Both are also buttons in Settings, applied by a small agent on the host so the
app never has to touch the container engine itself.

Rollback puts the previous release back **against the newer database**, which
works because migrations here are additive: an older release ignores columns it
does not know about. Nothing you entered since the update is lost. That is the
point — an instance that has taken a day of invoices must not throw them away
to fix a display bug. If you want the data back as it was too, restore the
backup the update took.

---

## When something is wrong

Start here:

```bash
curl -s localhost:3000/healthz
sentrello logs
```

`healthz` answers without a login and tells you the version, whether the
licence is valid, which modules loaded, and — importantly — which ones
**failed**. A module that will not load takes all of its features with it, so
`modules_failed` being empty is the first thing to check.

The dashboard shows the same machine from the inside: disk free, database size,
how long it has been up. A self-hosted business owns the server and nobody else
is watching it, and the usual first sign of a full disk is a backup that
silently stopped working.

| What you see | Usually |
|---|---|
| Links in emails point at `localhost` | `SENTRELLO_BASE_URL` does not match your domain |
| Customers cannot open the portal | the same |
| A password reset email never arrives | no mail configured — see above |
| `modules_failed` is not empty | that module's bundle is broken; the message says why |
| The app will not start after an update | `sentrello rollback`, then tell us what happened |

---

## Reporting something

Bugs and questions: open an issue. Please include the `healthz` output and what
you were doing.

**Security problems: do not open a public issue.** Email
`security@sentrello.com` with what you found and how to reproduce it.

## The dashboard's promo and sponsor blocks

A Free instance shows two advertising blocks on its dashboard: what Pro adds,
and a sponsor slot. The copy is a small JSON document this instance fetches
from `https://sentrello.com/api/promos` once a day, so it can change without
waiting for a release.

What that does and does not mean:

- **The instance fetches, never the browser.** No page in the product makes a
  request to another host, so nothing about who is reading the dashboard leaves
  the building.
- **Nothing is sent.** It is a plain GET of a public document — no instance id,
  no tier, no counts. Telemetry is a separate thing, off unless it was turned
  on deliberately.
- **It is only decoration.** A failed fetch or an unreadable document leaves
  whatever was cached, or the copy that shipped in the release.
- **Every link in it must be `https`**, and the document is validated before it
  is stored. Anything else is dropped.

To turn it off entirely, set `SENTRELLO_PROMOS=off`; the built-in copy is used.
To point it somewhere else — an air-gapped mirror, say — set
`SENTRELLO_PROMOS_URL`. Pro instances never fetch it: there is no promo block
on Pro.
