#!/usr/bin/env bash
set -euo pipefail
mkdir -p secrets
# Ed25519 keypair. PRIVATE stays only on sentrello.com in production.
openssl genpkey -algorithm ed25519 -out secrets/license_private.pem
openssl pkey -in secrets/license_private.pem -pubout -out secrets/license_public.pem
echo "Wrote secrets/license_private.pem (KEEP SECRET) and secrets/license_public.pem"
echo "In production: private key lives ONLY on the license server; public key ships in the core."
