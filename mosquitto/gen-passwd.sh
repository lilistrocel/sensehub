#!/usr/bin/env bash
# (Re)generate mosquitto/config/passwd from the project .env.
#   MQTT_DEVICE_PASSWORD -> user farm1021 (irrigation monitor)
#   MQTT_PASSWORD        -> user sensehub (backend ingest)
# Missing passwords are generated (24 random alphanumerics) and appended to .env.
# Then: docker kill -s HUP sensehub-mosquitto   (reload without dropping clients)
set -euo pipefail
cd "$(dirname "$0")/.."
ENV_FILE=.env
PASSWD=mosquitto/config/passwd
touch "$ENV_FILE"

gen() { LC_ALL=C tr -dc 'A-Za-z0-9' </dev/urandom | head -c 24; }
ensure() {
  local key=$1
  if ! grep -q "^${key}=" "$ENV_FILE"; then
    # never glue onto a last line that lacks its newline
    [ -s "$ENV_FILE" ] && [ -n "$(tail -c1 "$ENV_FILE")" ] && echo >> "$ENV_FILE"
    echo "${key}=$(gen)" >> "$ENV_FILE"
    echo "generated ${key} in ${ENV_FILE}"
  fi
}
ensure MQTT_DEVICE_PASSWORD
ensure MQTT_PASSWORD
get() { grep "^$1=" "$ENV_FILE" | tail -1 | cut -d= -f2-; }
for k in MQTT_DEVICE_PASSWORD MQTT_PASSWORD; do
  [ "$(get "$k" | wc -c)" -ge 13 ] || { echo "ERROR: $k in $ENV_FILE is empty or < 12 chars" >&2; exit 1; }
done

umask 077
: > "$PASSWD"
docker run --rm --user "$(id -u):$(id -g)" -v "$PWD/mosquitto/config:/work" \
  -e DEV_PW="$(get MQTT_DEVICE_PASSWORD)" -e BE_PW="$(get MQTT_PASSWORD)" \
  --entrypoint sh eclipse-mosquitto:2.0 -c '
    mosquitto_passwd -b /work/passwd farm1021 "$DEV_PW" &&
    mosquitto_passwd -b /work/passwd sensehub "$BE_PW"'
chmod 600 "$PASSWD" mosquitto/config/acl   # mosquitto warns on world-readable acl/passwd
echo "wrote $PASSWD ($(wc -l < "$PASSWD") users)"
