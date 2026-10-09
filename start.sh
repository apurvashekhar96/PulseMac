#!/bin/bash
# PulseMac Launcher Script

cd "$(dirname "$0")"

echo "⚡ Starting PulseMac Dashboard..."
node server.mjs --open
