#!/usr/bin/env sh
set -e
P="${DSH_HOME:-$HOME/.dsh}/dsh-go/plugins"
mkdir -p "$P"
cp -r "$(dirname "$0")/plugins/local-context" "$P/"
cp -r "$(dirname "$0")/plugins/local-context-cost" "$P/"
dsh plugin --profile web add "$P/local-context"
dsh plugin --profile web add "$P/local-context-cost"
echo "已安装。若改动过 lib/，请在 App「引擎」页重启引擎。"
