#!/usr/bin/env sh
set -e
P="${DSH_HOME:-$HOME/.dsh}/dsh-go/plugins"
mkdir -p "$P"
for name in local-context local-context-cost local-context-activity; do
  cp -r "$(dirname "$0")/plugins/$name" "$P/"
  dsh plugin --profile web add "$P/$name"
done
echo "已安装。若改动过 lib/，请在 App「引擎」页重启引擎。"
