#!/usr/bin/env bash
# Installs everything the course needs into ./.tools (no sudo, nothing global):
#   - AWS Emulator  (native on Linux; a Docker image on macOS/Windows)
#   - AWS CLI v2    (skipped if a v2 `aws` is already on PATH)
#   - Terraform     (for module 12)
# Re-run any time to pick up the latest emulator release.
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
TOOLS="$ROOT/.tools"
DL="$TOOLS/dl"
mkdir -p "$DL" "$TOOLS/bin" "$TOOLS/tf-cache"
OS=$(uname -s)
ARCH=$(uname -m)
TF_VERSION=${TF_VERSION:-1.17.2}
BASE=https://downloads.aws.com/aws-emulator/packages/aws-emulator/LTS/latest

say() { printf '\033[38;5;214m==>\033[0m %s\n' "$*"; }
have() { command -v "$1" >/dev/null 2>&1; }

case "$ARCH" in
  x86_64|amd64) RPM_ARCH=x86_64; DEB_ARCH=amd64; GO_ARCH=amd64; CLI_ARCH=x86_64 ;;
  aarch64|arm64) RPM_ARCH=aarch64; DEB_ARCH=arm64; GO_ARCH=arm64; CLI_ARCH=aarch64 ;;
  *) echo "Unsupported CPU architecture: $ARCH" >&2; exit 1 ;;
esac

# ------------------------------------------------------------------ emulator
if [ "$OS" = "Linux" ]; then
  say "Downloading AWS Emulator ($RPM_ARCH)"
  rm -rf "$TOOLS/emu" && mkdir -p "$TOOLS/emu"
  if have bsdtar; then
    curl -fsSLo "$DL/aws-emulator.rpm" "$BASE/aws-emulator-$RPM_ARCH.rpm"
    bsdtar -xf "$DL/aws-emulator.rpm" -C "$TOOLS/emu"
  elif have rpm2cpio && have cpio; then
    curl -fsSLo "$DL/aws-emulator.rpm" "$BASE/aws-emulator-$RPM_ARCH.rpm"
    (cd "$TOOLS/emu" && rpm2cpio "$DL/aws-emulator.rpm" | cpio -idm --quiet)
  elif have dpkg-deb; then
    curl -fsSLo "$DL/aws-emulator.deb" "$BASE/aws-emulator_$DEB_ARCH.deb"
    dpkg-deb -x "$DL/aws-emulator.deb" "$TOOLS/emu"
  else
    echo "Need one of: bsdtar (libarchive), rpm2cpio+cpio, or dpkg-deb to unpack the emulator." >&2
    exit 1
  fi
  "$TOOLS/emu/opt/aws-emulator/bin/aws-emulator" -v | head -1
else
  have docker || { echo "On $OS the emulator runs in Docker. Install Docker Desktop, then re-run." >&2; exit 1; }
  say "Building the aws-emulator Docker image ($RPM_ARCH)"
  mkdir -p "$DL/docker"
  cat > "$DL/docker/Dockerfile" <<EOF
FROM public.ecr.aws/amazonlinux/amazonlinux:2023-minimal
ADD $BASE/aws-emulator-$RPM_ARCH.rpm /tmp/aws-emulator.rpm
RUN rpm -i /tmp/aws-emulator.rpm && rm /tmp/aws-emulator.rpm \\
    && mkdir -p /home/emulator && chmod 777 /home/emulator
ENV HOME=/home/emulator
EXPOSE 9297
ENTRYPOINT ["aws-emulator", "-b", "0.0.0.0"]
EOF
  docker build -q -t aws-emulator "$DL/docker"
  docker run --rm aws-emulator -v | head -1
fi

# ------------------------------------------------------------------ AWS CLI v2
if have aws && aws --version 2>&1 | grep -q '^aws-cli/2'; then
  say "Using existing $(aws --version 2>&1 | cut -d' ' -f1)"
elif [ "$OS" = "Linux" ]; then
  say "Installing AWS CLI v2 into .tools"
  curl -fsSLo "$DL/awscliv2.zip" "https://awscli.amazonaws.com/awscli-exe-linux-$CLI_ARCH.zip"
  rm -rf "$DL/aws" && (cd "$DL" && unzip -q awscliv2.zip)
  "$DL/aws/install" -i "$TOOLS/aws-cli" -b "$TOOLS/bin" --update >/dev/null
  "$TOOLS/bin/aws" --version
else
  echo "Install AWS CLI v2 (https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html), then re-run." >&2
  exit 1
fi

# ------------------------------------------------------------------ Terraform
if [ ! -x "$TOOLS/bin/terraform" ]; then
  say "Installing Terraform $TF_VERSION into .tools"
  TF_OS=$(echo "$OS" | tr '[:upper:]' '[:lower:]')
  curl -fsSLo "$DL/tf.zip" "https://releases.hashicorp.com/terraform/$TF_VERSION/terraform_${TF_VERSION}_${TF_OS}_${GO_ARCH}.zip"
  (cd "$TOOLS/bin" && unzip -oq "$DL/tf.zip" terraform)
fi
"$TOOLS/bin/terraform" version | head -1

# ------------------------------------------------------------------ the rest
for t in jq zip curl python3; do have "$t" || echo "warning: '$t' is not installed; some labs use it." >&2; done
[ -d "$ROOT/node_modules" ] || (say "Installing npm dependencies" && cd "$ROOT" && npm install --no-fund --no-audit)

say "Done. Start the course with:  npm start   →  http://127.0.0.1:4380"
