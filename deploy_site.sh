#!/bin/bash
# Deploy the motoracelaps.com landing site (site/) to the kos-web droplet.
set -e
cd "$(dirname "$0")"
echo "Deploy başlıyor: $(date '+%H:%M')"
rsync -az --delete site/ root@159.89.97.78:/var/www/motoracelaps/
echo "Tamam → https://motoracelaps.com"
