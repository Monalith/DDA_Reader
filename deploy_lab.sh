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
#        ./deploy_lab.sh --with-ocp            # ALSO upload ocp/ and install CasADi (full OCP, spec v2 §2.10)
#        ./deploy_lab.sh --no-build --with-ocp
#
# --with-ocp is opt-in: the default deploy does exactly what it always did. Without
# ocp/ on the host the bridge still runs and /ocp/jobs answers 503.
# The droplet venv is found from the service's ExecStart; override with
# DDA_LAB_PY=/path/to/python if that guess is wrong. The OCP solve runs in a child
# process inside the dda-lab cgroup; a MemoryMax drop-in (512 MB droplet) makes the
# kernel kill that child, not the host, if a solve ever grows too large.
set -e
cd "$(dirname "$0")"
HOST=root@159.89.97.78
BUILD=1
WITH_OCP=0
for arg in "$@"; do
  case "$arg" in
    --no-build) BUILD=0 ;;
    --with-ocp) WITH_OCP=1 ;;
    *) echo "unknown option: $arg" >&2; exit 2 ;;
  esac
done
echo "Deploy başlıyor: $(date '+%H:%M')"
if [ "$BUILD" = 1 ]; then
  (cd dda_lab && npm run build >/dev/null)
fi
ssh "$HOST" 'mkdir -p /opt/dda-lab/viewer_lab'
rsync -az --delete viewer_lab/ "$HOST":/opt/dda-lab/viewer_lab/
rsync -az dda_lab_bridge.py dda_lab_bridge_prompt.txt "$HOST":/opt/dda-lab/
if [ "$WITH_OCP" = 1 ]; then
  echo "OCP: ocp/ yükleniyor + casadi kuruluyor"
  rsync -az --delete --exclude '__pycache__' ocp/ "$HOST":/opt/dda-lab/ocp/
  ssh "$HOST" "DDA_LAB_PY='${DDA_LAB_PY:-}' bash -s" <<'REMOTE'
set -e
PY="$DDA_LAB_PY"
if [ -z "$PY" ]; then
  EXE=$(systemctl show dda-lab -p ExecStart --value | sed -n 's/.*path=\([^ ;]*\).*/\1/p')
  BIN=$(dirname "$EXE")
  if [ -x "$BIN/python" ]; then PY="$BIN/python"; else PY=python3; fi
fi
echo "OCP python: $PY"
"$PY" -m pip install -q -r /opt/dda-lab/ocp/requirements.txt
"$PY" -c 'import casadi; assert casadi.has_nlpsol("ipopt"); print("casadi", casadi.__version__, "+ ipopt OK")'
mkdir -p /etc/systemd/system/dda-lab.service.d
printf '[Service]\nMemoryMax=400M\nEnvironment=OCP_TIMEOUT_S=900\n' > /etc/systemd/system/dda-lab.service.d/ocp.conf
systemctl daemon-reload
REMOTE
fi
ssh "$HOST" 'systemctl restart dda-lab && sleep 2 && systemctl is-active dda-lab && curl -s http://127.0.0.1:8777/health'
echo
echo "Tamam → https://dda.kitchenonstage.com"
