#!/usr/bin/env bash
# Build aowlc-lengc — a standalone binary over lengc's REAL C backend.
#
# Mirrors ~/aowlhexer/build.sh: vendor a full copy of nimony/src so all lib deps
# resolve, overlay our minimal driver into the lengc/ subdir, and build with
# classic Nim. The result reads a post-hexer .c.nif and emits C byte-identical to
# lengc (nimony's C backend), by construction.
set -e
NIMONY_SRC="${NIMONY_SRC:-$HOME/nimony/src}"
# Classic Nim: prefer choosenim devel, else ~/Nim (same as aowlhexer).
if [ -x "$HOME/.choosenim/toolchains/nim-#devel/bin/nim" ]; then
  NIM="${NIM:-$HOME/.choosenim/toolchains/nim-#devel/bin/nim}"
else
  NIM="${NIM:-$HOME/Nim/bin/nim}"
fi
ROOT="$(cd "$(dirname "$0")" && pwd)"
BUILD="$ROOT/.build-lengc"
[ -d "$NIMONY_SRC" ] || { echo "aowlc-lengc: NIMONY_SRC not found: $NIMONY_SRC" >&2; exit 1; }

if [ "$1" = "--fresh" ] || [ ! -d "$BUILD" ]; then
  rm -rf "$BUILD"; cp -r "$NIMONY_SRC" "$BUILD"
fi
cp "$ROOT"/parity/aowlc_parity.nim "$BUILD/lengc/"   # overlay OUR driver
mkdir -p "$ROOT/bin"
"$NIM" c -d:release --hints:off --warnings:off \
  -o:"$ROOT/bin/aowlc-lengc" "$BUILD/lengc/aowlc_parity.nim"
echo "built $ROOT/bin/aowlc-lengc"
