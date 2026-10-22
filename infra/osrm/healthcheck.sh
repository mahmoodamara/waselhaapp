#!/usr/bin/env bash
set -euo pipefail
# The pinned Debian image has bash/timeout, but no curl/wget. Check an actual
# public-road route in the existing Kafr Kanna service area. Emit no route data.
exec 3<>/dev/tcp/127.0.0.1/5000
printf 'GET /route/v1/driving/35.3357268,32.7486911;35.3437821,32.7356136?overview=false&steps=false&alternatives=false HTTP/1.0\r\nHost: localhost\r\nConnection: close\r\n\r\n' >&3
response=$(cat <&3)
[[ "$response" == HTTP/1.*' 200 '* ]]
[[ "$response" == *'"code":"Ok"'* ]]
[[ "$response" == *'"distance":'* && "$response" == *'"duration":'* ]]
