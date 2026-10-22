#!/usr/bin/env bash
set -euo pipefail
port=${PORT:-10000}
[[ "$port" =~ ^[1-9][0-9]{0,4}$ ]] && (( port <= 65535 ))
# Public road points used in the existing Kafr Kanna smoke check; no user data.
exec 3<>"/dev/tcp/127.0.0.1/$port"
printf 'GET /route/v1/driving/35.3357268,32.7486911;35.3437821,32.7356136?overview=false&steps=false&alternatives=false HTTP/1.0\r\nHost: localhost\r\nConnection: close\r\n\r\n' >&3
response=$(timeout 4 cat <&3)
[[ "$response" == HTTP/1.*' 200 '* ]]
[[ "$response" == *'"code":"Ok"'* ]]
[[ "$response" == *'"distance":'* && "$response" == *'"duration":'* ]]
