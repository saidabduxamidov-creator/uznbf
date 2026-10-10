#!/bin/bash
# Installs the Local MCP Platform bundled server on macOS and Linux.
#
# Usage:
#   bash scripts/install.sh [-p <install-path>] [-d <data-path>]
#
# Requirements:
#   - Node.js 22.12.0 or later
#   - bash 4.0+
#   - jq (for JSON parsing; optional—script falls back to grep)

set -euo pipefail

# Defaults
INSTALL_DIR="${1:-$HOME/.local/share/local-mcp-platform}"
DATA_DIR="${2:-$HOME/.config/local-mcp-platform}"
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

echo -e "${CYAN}Local MCP Platform Installer${NC}"
echo -e "${CYAN}version 0.1.0${NC}"
echo ""

# Check prerequisites
echo -e "${YELLOW}Checking prerequisites...${NC}"

# Check Node.js
if ! command -v node &> /dev/null; then
  echo -e "${RED}Error: Node.js is not installed or not in PATH.${NC}"
  echo "Install Node.js 22.12.0 or later from https://nodejs.org/"
  exit 1
fi

NODE_VERSION=$(node --version)
# Extract major and minor version
MAJOR=$(echo "$NODE_VERSION" | sed -E 's/v([0-9]+)\.[0-9]+.*/\1/')
MINOR=$(echo "$NODE_VERSION" | sed -E 's/v[0-9]+\.([0-9]+).*/\1/')

if [[ $MAJOR -lt 22 ]] || ([[ $MAJOR -eq 22 ]] && [[ $MINOR -lt 12 ]]); then
  echo -e "${RED}Error: Node.js version $NODE_VERSION is below minimum 22.12.0${NC}"
  exit 1
fi

echo -e "${GREEN}  ✓ Node.js $NODE_VERSION${NC}"
echo -e "${GREEN}  ✓ Installation directory: $INSTALL_DIR${NC}"
echo -e "${GREEN}  ✓ Data directory: $DATA_DIR${NC}"

# Prepare directories
echo ""
echo -e "${YELLOW}Preparing installation directories...${NC}"
mkdir -p "$INSTALL_DIR"
mkdir -p "$DATA_DIR"

# Locate bundled server and payload
PAYLOAD_DIR="$PROJECT_ROOT/release/payload"
SERVER_FILE="$PAYLOAD_DIR/server/server.mjs"
MANIFEST_FILE="$PAYLOAD_DIR/server/manifest.json"
NOTICES_FILE="$PAYLOAD_DIR/server/THIRD_PARTY_NOTICES.txt"

if [[ ! -f "$SERVER_FILE" ]]; then
  echo -e "${RED}Error: Bundle not found at $SERVER_FILE${NC}"
  echo "Run 'npm run build && node scripts/bundle.mjs' first."
  exit 1
fi

SIZE_MB=$(( $(stat -f%z "$SERVER_FILE" 2>/dev/null || stat -c%s "$SERVER_FILE" 2>/dev/null) / 1048576 ))
echo -e "${GREEN}  ✓ Bundle found ($SIZE_MB MB)${NC}"

# Load manifest
PRODUCT=$(grep -o '"product"[^,]*' "$MANIFEST_FILE" | cut -d'"' -f4)
VERSION=$(grep -o '"version"[^,]*' "$MANIFEST_FILE" | cut -d'"' -f4)
EXPECTED_SHA=$(grep -o '"serverSha256"[^,]*' "$MANIFEST_FILE" | cut -d'"' -f4)

echo -e "${GREEN}  ✓ Version: $VERSION${NC}"
echo -e "${GREEN}  ✓ Product: $PRODUCT${NC}"

# Validate SHA-256
echo ""
echo -e "${YELLOW}Validating bundle integrity...${NC}"

if command -v shasum &> /dev/null; then
  ACTUAL_SHA=$(shasum -a 256 "$SERVER_FILE" | awk '{print $1}')
elif command -v sha256sum &> /dev/null; then
  ACTUAL_SHA=$(sha256sum "$SERVER_FILE" | awk '{print $1}')
else
  echo -e "${RED}Error: Neither shasum nor sha256sum found${NC}"
  exit 1
fi

if [[ "$ACTUAL_SHA" != "$EXPECTED_SHA" ]]; then
  echo -e "${RED}Error: Bundle SHA-256 mismatch.${NC}"
  echo "Expected: $EXPECTED_SHA"
  echo "Got: $ACTUAL_SHA"
  exit 1
fi

echo -e "${GREEN}  ✓ SHA-256 verified${NC}"

# Extract bundle
echo ""
echo -e "${YELLOW}Installing bundled server...${NC}"
cp "$SERVER_FILE" "$INSTALL_DIR/server.mjs"
cp "$MANIFEST_FILE" "$INSTALL_DIR/manifest.json"
cp "$NOTICES_FILE" "$INSTALL_DIR/THIRD_PARTY_NOTICES.txt"
chmod +x "$INSTALL_DIR/server.mjs"
echo -e "${GREEN}  ✓ Server extracted to $INSTALL_DIR${NC}"

# Create shell wrapper
WRAPPER_PATH="$INSTALL_DIR/run.sh"
cat > "$WRAPPER_PATH" << 'EOF'
#!/bin/bash
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
exec node "$SCRIPT_DIR/server.mjs" --data-root "$HOME/.config/local-mcp-platform" "$@"
EOF
chmod +x "$WRAPPER_PATH"
echo -e "${GREEN}  ✓ Created run.sh wrapper${NC}"

# Configure Claude Desktop (macOS only)
if [[ "$OSTYPE" == "darwin"* ]]; then
  echo ""
  echo -e "${YELLOW}Configuring Claude Desktop...${NC}"

  CLAUDE_CONFIG_DIR="$HOME/Library/Application Support/Claude"
  CLAUDE_CONFIG_FILE="$CLAUDE_CONFIG_DIR/claude_desktop_config.json"

  mkdir -p "$CLAUDE_CONFIG_DIR"

  # Create or merge config
  if [[ -f "$CLAUDE_CONFIG_FILE" ]]; then
    # Merge with existing config if using jq
    if command -v jq &> /dev/null; then
      jq ".mcpServers[\"local-platform\"] = {
        \"command\": \"node\",
        \"args\": [\"$INSTALL_DIR/server.mjs\", \"--data-root\", \"$DATA_DIR\", \"--log-level\", \"info\"]
      }" "$CLAUDE_CONFIG_FILE" > "$CLAUDE_CONFIG_FILE.tmp"
      mv "$CLAUDE_CONFIG_FILE.tmp" "$CLAUDE_CONFIG_FILE"
    else
      echo -e "${YELLOW}  ⚠ jq not found; skipping config merge. Manual edit may be needed.${NC}"
    fi
  else
    cat > "$CLAUDE_CONFIG_FILE" << EOFCONFIG
{
  "mcpServers": {
    "local-platform": {
      "command": "node",
      "args": [
        "$INSTALL_DIR/server.mjs",
        "--data-root",
        "$DATA_DIR",
        "--log-level",
        "info"
      ]
    }
  }
}
EOFCONFIG
  fi

  echo -e "${GREEN}  ✓ Configuration written to $CLAUDE_CONFIG_FILE${NC}"
  echo ""
  echo -e "${CYAN}Restart Claude Desktop to load the new MCP server.${NC}"
else
  echo ""
  echo -e "${YELLOW}Note: Claude Desktop auto-configuration only works on macOS.${NC}"
  echo "On Linux, manually add to your MCP client config:"
  echo ""
  echo "  \"local-platform\": {"
  echo "    \"command\": \"node\","
  echo "    \"args\": [\"$INSTALL_DIR/server.mjs\", \"--data-root\", \"$DATA_DIR\", \"--log-level\", \"info\"]"
  echo "  }"
fi

echo ""
echo -e "${GREEN}Installation complete!${NC}"
echo -e "${CYAN}  Install directory: $INSTALL_DIR${NC}"
echo -e "${CYAN}  Data directory: $DATA_DIR${NC}"
echo ""
echo -e "${CYAN}To verify, run:${NC}"
echo -e "${YELLOW}  node '$INSTALL_DIR/server.mjs' --data-root '$DATA_DIR' --log-level debug${NC}"
