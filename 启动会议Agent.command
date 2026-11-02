#!/bin/zsh
set -e
cd "${0:A:h}"
export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"
if ! command -v pnpm >/dev/null 2>&1; then
  print '未找到 pnpm，请先安装 pnpm 10.15.1。'
  read -k 1 'reply?按任意键关闭'
  exit 1
fi
if [[ ! -d node_modules ]]; then
  pnpm install --frozen-lockfile
fi
pnpm run build
exec pnpm run start
