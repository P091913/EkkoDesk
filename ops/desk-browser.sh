#!/bin/sh
# Opens the desk at login on the Pi (README, "On the Pi"), once its server answers. labwc's window rule puts it full screen
# on the projector. Its own profile keeps it apart from the deck's Chromium, and the CPU cap (one core) keeps it from
# starving the deck.
until curl -s -o /dev/null http://127.0.0.1:8081/; do sleep 1; done
exec systemd-run --user --scope -p CPUQuota=100% chromium --user-data-dir="$HOME/.config/ekko-desk-chromium" \
  --app=http://127.0.0.1:8081/ --no-first-run --noerrdialogs --hide-crash-restore-bubble
