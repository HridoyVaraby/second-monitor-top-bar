#!/usr/bin/env bash
# Follow gnome-shell journal output (errors, warnings, extension logs).
#
#   tools/logs.sh              everything from gnome-shell
#   tools/logs.sh --ext        only this extension + JS errors/exceptions
set -euo pipefail

if [[ "${1:-}" == "--ext" ]]; then
    exec journalctl --user -f -o cat -n 100 /usr/bin/gnome-shell |
        grep --line-buffered -iE 'second-monitor-top-bar|js error|exception|warning'
fi

exec journalctl --user -f -o cat -n 100 /usr/bin/gnome-shell
