#!/usr/bin/env bash
# Install (or refresh) the extension into ~/.local/share/gnome-shell/extensions/
# and enable it. Run from anywhere; operates relative to its own location.
set -euo pipefail

UUID="second-monitor-top-bar@hridoyvaraby"
SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEST="$HOME/.local/share/gnome-shell/extensions/$UUID"

mkdir -p "$DEST"
install -m 644 "$SRC/extension.js" "$SRC/metadata.json" "$SRC/stylesheet.css" "$DEST/"

echo "Installed -> $DEST"

if gnome-extensions info "$UUID" >/dev/null 2>&1; then
    # Shell already knows the extension: cycle it so enable() runs again.
    # NOTE: this re-runs enable()/disable() but does NOT re-import changed
    # code. After editing extension.js you still need a shell restart:
    # X11: Alt-F2 -> type r -> Enter      (your session is X11)
    # Wayland: log out and back in
    gnome-extensions disable "$UUID" 2>/dev/null || true
    gnome-extensions enable "$UUID"
    echo "Enabled (state: $(gnome-extensions info "$UUID" | awk '/State/{print $2}'))."
    echo "Code changed since shell start? Restart the shell to reload it: Alt-F2 -> r -> Enter"
else
    echo "Extension not loaded by the running shell yet."
    echo "  1. Restart the shell:   Alt-F2 -> type r -> Enter"
    echo "  2. Enable it:           gnome-extensions enable $UUID"
fi
