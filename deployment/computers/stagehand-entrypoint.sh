#!/bin/sh
set -eu
# Move this Dot's credential into an anonymous pipe before replacing PID 1.
# Browser and shell processes inherit a credential-free environment.
exec 3<<EOF
$COMPUTER_TOKEN
EOF
unset COMPUTER_TOKEN
exec node /app/dist/server/computer/index.js
