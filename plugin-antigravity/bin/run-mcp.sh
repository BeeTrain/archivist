#!/bin/sh
set -eu
DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
export PATH="/opt/homebrew/bin:/usr/local/bin:$HOME/.nvm/current/bin:$HOME/.volta/bin:$HOME/.asdf/shims:$PATH"
exec node "$DIR/archivist-mcp"
