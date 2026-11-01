#!/bin/zsh
cd -- "${0:A:h}" || exit 1
if [[ ! -x .venv/bin/python ]]; then
  print "The viewer environment is missing. See README.md for setup instructions."
  read -k 1
  exit 1
fi
viewer_health=$(/usr/bin/curl --silent --max-time 1 http://127.0.0.1:8765/api/health)
if [[ "$viewer_health" == *'"application": "mri-viewer"'* ]]; then
  /usr/bin/open http://127.0.0.1:8765
  exit 0
fi
exec .venv/bin/python server.py --open
