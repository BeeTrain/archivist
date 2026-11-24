#!/bin/sh
set -eu
DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
export PATH="/opt/homebrew/bin:/usr/local/bin:$HOME/.nvm/current/bin:$HOME/.volta/bin:$HOME/.asdf/shims:$PATH"
if command -v node >/dev/null 2>&1; then
  exec node "$DIR/archivist" hook
fi
printf '{}\n'
