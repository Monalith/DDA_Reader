#!/bin/bash
# Deploy DDA Lab to https://dda.kitchenonstage.com
#
# Infrastructure: kos-web droplet (DigitalOcean fra1, 159.89.97.78) → nginx (sites-available/dda)
# → systemd "dda-lab" (uvicorn, /opt/dda-lab, 127.0.0.1:8777) → cloudflared tunnel "kos-web"
# (ingress dda.kitchenonstage.com → localhost:80; DNS CNAME created with
# `cloudflared tunnel route dns c7a13516-db36-4591-a6de-03dbbfa9cd98 dda.kitchenonstage.com`).
#
# Usage: ./deploy_lab.sh                       # builds the web app, uploads it, restarts the service
#        ./deploy_lab.sh --no-build            # upload the existing viewer_lab/
#
# The full OCP solver (ocp/ + CasADi) is NEVER deployed to the server (owner
# decision 2026-10-11): the server only serves the app, each user's own DDA Lab
# bridge solves locally. /ocp/jobs on the host answers 503 by design.
set -e
cd "$(dirname "$0")"
HOST=root@159.89.97.78
BUILD=1
for arg in "$@"; do
  case "$arg" in
    --no-build) BUILD=0 ;;
    *) echo "unknown option: $arg" >&2; exit 2 ;;
  esac
done
echo "Deploy başlıyor: $(date '+%H:%M')"
if [ "$BUILD" = 1 ]; then
  (cd dda_lab && npm run build >/dev/null)
fi
ssh "$HOST" 'mkdir -p /opt/dda-lab/viewer_lab'
rsync -az --delete viewer_lab/ "$HOST":/opt/dda-lab/viewer_lab/
rsync -az dda_lab_bridge.py dda_lab_bridge_prompt.txt requirements-lab.txt "$HOST":/opt/dda-lab/
rsync -az --delete --exclude __pycache__ bridge/ "$HOST":/opt/dda-lab/bridge/
ssh "$HOST" '/opt/dda-lab/.venv/bin/pip install -q -r /opt/dda-lab/requirements-lab.txt'
ssh "$HOST" 'systemctl restart dda-lab && sleep 2 && systemctl is-active dda-lab && curl -s http://127.0.0.1:8777/health'
echo
echo "Tamam → https://dda.kitchenonstage.com"
