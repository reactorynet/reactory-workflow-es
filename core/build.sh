#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROVIDERS_DIR="$SCRIPT_DIR/../providers"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

log()  { echo -e "${GREEN}[✓]${NC} $*"; }
warn() { echo -e "${YELLOW}[!]${NC} $*"; }
info() { echo -e "${BLUE}[i]${NC} $*"; }
fail() { echo -e "${RED}[✗]${NC} $*" >&2; exit 1; }

echo "========================================"
echo " Workflow ES Build Script"
echo "========================================"
echo ""

# ── Step 1: Build all providers ─────────────────────────────────────────────
info "Building providers..."
cd "$PROVIDERS_DIR"

for provider_dir in workflow-es-*/; do
  [ -d "$provider_dir" ] || continue
  
  name=$(jq -r '.name' "$provider_dir/package.json")
  version=$(jq -r '.version' "$provider_dir/package.json")
  
  # Generate tarball name: @reactorynet/workflow-es-mongodb -> reactorynet-workflow-es-mongodb
  basename_safe=$(echo "$name" | sed 's/@//g')
  tarball="${basename_safe}-${version}.tgz"
  
  info "Building $name@$version..."
  cd "$provider_dir"
  
  # Install dependencies
  if [ ! -d "node_modules" ]; then
    warn "Installing dependencies for $name..."
    yarn install --immutable 2>/dev/null || yarn install
  fi
  
  # Build
  yarn build
  
  # Pack with correct name
  yarn pack -o "$tarball"
  
  log "$name@$version → $tarball"
  
  cd "$PROVIDERS_DIR"
done

log "All providers built successfully."
echo ""

# ── Step 2: Build core ──────────────────────────────────────────────────────
info "Building @reactorynet/workflow-es core..."
cd "$SCRIPT_DIR"

if [ ! -d "node_modules" ]; then
  warn "Installing dependencies for core..."
  yarn install --immutable 2>/dev/null || yarn install
fi

yarn build

# Generate tarball name
core_version=$(jq -r '.version' package.json)
core_tarball="reactorynet-workflow-es-${core_version}.tgz"

yarn pack -o "$core_tarball"
log "Core packaged → $core_tarball"

echo ""
echo "========================================"
echo " Build Complete"
echo "========================================"
echo ""
info "Tarballs created:"
echo "  Core:    $(ls "$SCRIPT_DIR"/*.tgz 2>/dev/null | tail -1)"
echo "  Providers:"
for provider_dir in workflow-es-*/; do
  [ -d "$provider_dir" ] || continue
  name=$(jq -r '.name' "$provider_dir/package.json")
  version=$(jq -r '.version' "$provider_dir/package.json")
  basename_safe=$(echo "$name" | sed 's/@//g')
  tarball="${basename_safe}-${version}.tgz"
  if [ -f "$PROVIDERS_DIR/$provider_dir$tarball" ]; then
    echo "    - $tarball"
  fi
done
echo ""
