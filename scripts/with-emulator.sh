#!/usr/bin/env bash
# Run a command against a fresh, throwaway AWS Emulator.
#
#   scripts/with-emulator.sh aws s3 ls
#   scripts/with-emulator.sh bash my-test.sh
#   EMU_PORT=9400 scripts/with-emulator.sh pytest
#
# Starts the emulator on a free port with its own temp HOME, exports the
# standard AWS_* variables, runs the command, then stops the emulator (which
# discards all state). This is the same pattern you'd use in CI.
set -uo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
BIN="$ROOT/.tools/emu/opt/aws-emulator/bin/aws-emulator"
[ -x "$BIN" ] || BIN=$(command -v aws-emulator) || { echo "aws-emulator not installed: run npm run setup" >&2; exit 127; }
PORT=${EMU_PORT:-$(( 20000 + RANDOM % 20000 ))}
EHOME=$(mktemp -d)
LOG="$EHOME/emulator.log"
HOME="$EHOME" "$BIN" --telemetry off -p "$PORT" >"$LOG" 2>&1 &
EPID=$!
cleanup() { kill "$EPID" 2>/dev/null; wait "$EPID" 2>/dev/null; rm -rf "$EHOME"; }
trap cleanup EXIT
D="$EHOME/.aws/emulator/$PORT"
for _ in $(seq 150); do
  [ -f "$D/ca.pem" ] && curl -sf --cacert "$D/ca.pem" "https://127.0.0.1:$PORT/__admin/health" >/dev/null 2>&1 && break
  kill -0 "$EPID" 2>/dev/null || { echo "emulator failed to start:" >&2; cat "$LOG" >&2; exit 1; }
  sleep 0.2
done
unset AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_SESSION_TOKEN AWS_PROFILE
export AWS_ENDPOINT_URL="https://127.0.0.1:$PORT" \
  AWS_SHARED_CREDENTIALS_FILE="$D/emulator_credentials" AWS_CONFIG_FILE="$D/config" AWS_CA_BUNDLE="$D/ca.pem" \
  AWS_EC2_METADATA_DISABLED=true AWS_DISABLE_HOST_PREFIX_INJECTION=true \
  AWS_REGION=us-east-1 AWS_DEFAULT_REGION=us-east-1 AWS_PAGER=""
export PATH="$ROOT/.tools/bin:$PATH" TF_PLUGIN_CACHE_DIR="$ROOT/.tools/tf-cache"
mkdir -p "$TF_PLUGIN_CACHE_DIR"
"$@"
