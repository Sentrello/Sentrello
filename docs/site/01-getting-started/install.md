---
title: Install
sidebar_position: 2
description: Put Sentrello on your own server in about five minutes.
tags: [setup, install]
---

# Install

Sentrello runs in containers on a Linux server you control. One command
installs it.

## What you need

- A Linux server with **2GB of memory** and 20GB of disk. A small cloud
  instance carries a twenty-person business without complaining.
- **Docker** or **Podman**. Either works; the installer detects which you have.
- A **domain name** pointing at the server, if you want it reachable from
  outside your network.

:::info[Podman is fully supported]
If both are installed, Docker is used by default. To choose Podman instead, set
`SENTRELLO_ENGINE=podman` before running the installer.
:::

## Install it

```bash title="on your server"
curl -fsSL https://get.sentrello.com | bash
```

The installer asks four things: your licence key (leave it blank for the free
tier), the domain this instance will answer on, an administrator email address,
and whether to send usage reports. Then it does the rest by itself. Images come
down, the database is sized for the machine it is on, migrations run, and the
whole thing starts.

When it finishes it prints a **setup token**. You need that token once, on the
first screen. It proves you are the person who installed this, which is what
stops whoever finds the address before you from claiming the instance.

## Put TLS in front of it

Sentrello listens on `127.0.0.1:3000`. It never binds a public port itself, so
something in front of it has to terminate TLS.

```nginx title="/etc/nginx/conf.d/sentrello.conf"
server {
    listen 80;
    server_name example.com;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        client_max_body_size 26m;
    }
}
```

Then issue a certificate:

```bash
sudo certbot --nginx -d example.com
```

:::warning[The address has to match]
`SENTRELLO_BASE_URL` must be exactly the address a browser uses. Say it reads
`http://localhost` while everyone reaches `https://example.com`: every sign-in
is refused. Correctly so. That check is what stops another site posting your
login form.
:::

## Managing it afterwards

The installer leaves a `sentrello` command on the server.

```bash
sentrello status      # version, tier, which modules loaded
sentrello update      # to the latest release, backing up first
sentrello rollback    # back to the previous version
sentrello backup      # an immediate database dump
sentrello logs        # follow the application log
```

## Next

- [Configure it](/getting-started/configure) for your business.
- [Check it works](/getting-started/testing) before you rely on it.
