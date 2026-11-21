#!/usr/bin/env sh
set -eu
printf 'npm 2FA 一次性验证码: '
stty -echo 2>/dev/null || true
read -r OTP
stty echo 2>/dev/null || true
printf '\n'
[ -n "$OTP" ] || { echo '未输入验证码'; exit 1; }
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
for dir in local-context local-context-cost local-context-activity; do
  echo "== 发布 $dir =="
  (cd "$ROOT/plugins/$dir" && npm publish --access public --otp="$OTP")
done
unset OTP
echo '全部发布完成'
