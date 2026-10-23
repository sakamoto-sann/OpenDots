#!/bin/sh
set -eu
# Public incident roots are prohibited in Chromium's per-user NSS store.
db=/home/node/.local/share/pki/nssdb
mkdir -p "$db"
certutil -d "sql:$db" -N --empty-password
for certificate in /opt/security-ca/distrust/*.pem; do
    nickname="incident-$(basename "$certificate" .pem)"
    certutil -d "sql:$db" -A -t "p,p,p" -n "$nickname" -i "$certificate"
done
chown -R node:node /home/node/.local/share/pki
