#!/bin/bash
set -euo pipefail
clear

REPO="thelastligma/wave"
TAG="Releases"
APP_NAME="Wave"

echo "🌊 Wave Installer"
echo "===================="

OS_VERSION=$(sw_vers -productVersion | cut -d. -f1,2)
ARCH=$(uname -m)

# Catalina detection (10.15)
if [[ "$OS_VERSION" == "10.15" ]]; then
  ASSET_NAME="${APP_NAME}-catalina.zip"
  echo "Detected: macOS Catalina ($OS_VERSION)"
else
  case "$ARCH" in
    arm64|aarch64)
      ASSET_NAME="${APP_NAME}-arm64.zip"
      echo "Detected: Apple Silicon ($ARCH)"
      ;;
    x86_64|amd64)
      ASSET_NAME="${APP_NAME}-x86_64.zip"
      echo "Detected: Intel ($ARCH)"
      ;;
    *)
      echo "❌ Unsupported architecture: $ARCH"
      exit 1
      ;;
  esac
fi

DOWNLOAD_URL="https://github.com/$REPO/releases/download/$TAG/$ASSET_NAME"
# Fallback if the first URL structure is wrong, standard github releases use /releases/download/vX.Y.Z/file
# But we follow the "like this" request which used $TAG directly.

TMP_ZIP="/tmp/$ASSET_NAME"
TMP_DIR=$(mktemp -d)

echo "🔗 Downloading: $DOWNLOAD_URL"
curl -fL "$DOWNLOAD_URL" -o "$TMP_ZIP" || {
  echo "❌ Download failed. Please check your internet connection or if the release exists."
  exit 1
}

echo "📦 Extracting ZIP..."
unzip -q -o "$TMP_ZIP" -d "$TMP_DIR"

APP_SRC=$(find "$TMP_DIR" -maxdepth 2 -name "${APP_NAME}.app" -type d | head -n 1)

if [ -z "$APP_SRC" ]; then
  # Try searching case insensitive if Wave.app vs wave.app matters
  APP_SRC=$(find "$TMP_DIR" -maxdepth 2 -iname "${APP_NAME}.app" -type d | head -n 1)
fi

if [ -z "$APP_SRC" ]; then
  echo "❌ ${APP_NAME}.app not found in ZIP"
  exit 1
fi

DEST_DIR="/Applications"
DEST_APP="${DEST_DIR}/$(basename "$APP_SRC")"

if [ -d "$DEST_APP" ]; then
  echo "♻️ Removing existing installation..."
  rm -rf "$DEST_APP"
fi

echo "💾 Installing..."
if [ -w "$DEST_DIR" ]; then
  cp -R "$APP_SRC" "$DEST_DIR/"
else
  echo "sudo access required to copy to /Applications"
  sudo cp -R "$APP_SRC" "$DEST_DIR/"
fi

echo "🛡️ Removing quarantine flags..."
xattr -rd com.apple.quarantine "$DEST_APP" 2>/dev/null || true

echo "🧹 Cleaning up..."
rm -rf "$TMP_DIR" "$TMP_ZIP"

echo ""
echo "✅ $APP_NAME installed successfully!"
open -a "$DEST_APP"
