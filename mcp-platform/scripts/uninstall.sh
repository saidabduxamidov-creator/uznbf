#!/bin/bash
# Uninstalls the Local MCP Platform.
#
# Usage:
#   bash scripts/uninstall.sh [-p <install-path>]

set -euo pipefail

INSTALL_DIR="${1:-$HOME/.local/share/local-mcp-platform}"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

echo -e "${CYAN}Local MCP Platform Uninstaller${NC}"
echo ""

# Remove from Claude Desktop config (macOS)
if [[ "$OSTYPE" == "darwin"* ]]; then
  CLAUDE_CONFIG_FILE="$HOME/Library/Application Support/Claude/claude_desktop_config.json"

  if [[ -f "$CLAUDE_CONFIG_FILE" ]]; then
    echo -e "${YELLOW}Updating Claude Desktop configuration...${NC}"

    if command -v jq &> /dev/null; then
      jq 'del(.mcpServers["local-platform"])' "$CLAUDE_CONFIG_FILE" > "$CLAUDE_CONFIG_FILE.tmp"
      mv "$CLAUDE_CONFIG_FILE.tmp" "$CLAUDE_CONFIG_FILE"
      echo -e "${GREEN}  ✓ Removed from Claude Desktop config${NC}"
    else
      echo -e "${YELLOW}  ⚠ jq not found; please manually remove \"local-platform\" from $CLAUDE_CONFIG_FILE${NC}"
    fi
  fi
fi

# Remove installation directory
if [[ -d "$INSTALL_DIR" ]]; then
  echo -e "${YELLOW}Removing installation directory...${NC}"
  rm -rf "$INSTALL_DIR"
  echo -e "${GREEN}  ✓ Removed $INSTALL_DIR${NC}"
fi

echo ""
echo -e "${CYAN}Restart Claude Desktop to complete uninstallation.${NC}"
