#!/bin/bash
# PulseMac Double-Clickable macOS App Launcher
cd "$(dirname "$0")"
echo "========================================================"
echo "⚡ Launching PulseMac Hardware & Thermal Dashboard..."
echo "========================================================"
node server.mjs --open
