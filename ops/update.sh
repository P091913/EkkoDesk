#!/bin/sh
# Updates the desk on the Pi to main: `sh ~/ekko-desk/ops/update.sh`. The page reloads itself once the server is back.
# .env and data/ are git-ignored, so this never touches them; a new .env name is added by hand.
set -e
cd "$(dirname "$0")/.."
git pull --ff-only
npm ci
npm run build
sudo systemctl restart ekko-desk
