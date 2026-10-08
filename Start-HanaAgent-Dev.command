#!/bin/bash
# Finder entry for the existing source-development command. No login shell or installs.
set -u

fail() {
  local status="$1"
  shift
  printf '\n[HanaAgent 开发版] %s\n' "$*" >&2
  if [ -t 0 ]; then
    printf '按回车结束；可保留终端中的错误信息用于排查。\n' >&2
    IFS= read -r answer
  fi
  exit "$status"
}

case "$OSTYPE" in
  darwin*) ;;
  *) fail 1 '此双击入口仅支持 macOS。其他系统请按 README.md 使用 npm start。' ;;
esac

repo_dir="$(CDPATH= cd -- "$(/usr/bin/dirname -- "${BASH_SOURCE[0]}")" && pwd -P)" \
  || fail 1 '无法定位项目目录。请保留此文件在项目根目录。'
cd -- "$repo_dir" || fail 1 '无法进入项目目录。'
[ -f package.json ] && [ -f scripts/launch.js ] \
  || fail 1 '项目文件缺失。请在完整项目根目录中双击此文件，不要单独复制启动文件。'
[ -n "${HOME:-}" ] || fail 1 'HOME 未设置，无法定位本机开发环境。'

node_bin=''
npm_cli=''
try_node() {
  local candidate="$1" candidate_dir
  [ -x "$candidate" ] || return 1
  candidate_dir="$(CDPATH= cd -- "$(/usr/bin/dirname -- "$candidate")" && pwd -P)" || return 1
  [ -f "$candidate_dir/npm" ] || return 1
  "$candidate" -e 'const [major, minor] = process.versions.node.split(".").map(Number); process.exit(major === 24 && minor >= 12 ? 0 : 1)' \
    >/dev/null 2>&1 || return 1
  node_bin="$candidate_dir/$(/usr/bin/basename -- "$candidate")"
  npm_cli="$candidate_dir/npm"
}

if [ -n "${HANA_DEV_NODE_BIN:-}" ]; then
  try_node "$HANA_DEV_NODE_BIN" \
    || fail 1 '指定的 HANA_DEV_NODE_BIN 不可用：需要 Node >=24.12.0 <25，以及同一 bin 目录中的 npm。'
else
  node_arch="$(/usr/bin/uname -m)"
  [ "$node_arch" != x86_64 ] || node_arch=x64
  path_node="$(type -P node || true)"
  for candidate in \
    "$HOME"/.local/node-v24.*-darwin-"$node_arch"/bin/node \
    "$path_node" \
    /opt/homebrew/opt/node@24/bin/node /usr/local/opt/node@24/bin/node \
    /opt/homebrew/bin/node /usr/local/bin/node; do
    if try_node "$candidate"; then break; fi
  done
  [ -n "$node_bin" ] \
    || fail 1 '未找到 Node >=24.12.0 <25 和配套 npm。请先按 docs/mac-dev-launcher.md 准备开发环境，再双击。'
fi

[ -f node_modules/vite/bin/vite.js ] && [ -f node_modules/electron/cli.js ] \
  || fail 1 '项目依赖未就绪。请先按 README.md 完成 npm ci 和 npm run build:packages，再双击。本入口不会自动安装依赖。'

# This PATH only belongs to this process and its children. launch.js passes the
# absolute Node path to the server even after Electron resolves its login-shell PATH.
export PATH="$(/usr/bin/dirname -- "$node_bin"):${PATH:-/usr/bin:/bin:/usr/sbin:/sbin}"
export HANA_DEV_NODE_BIN="$node_bin"
printf 'HanaAgent 源码开发版\n项目：%s\nNode：%s\n' "$repo_dir" "$node_bin"
printf '正在执行 npm start（会构建桌面前端资源，请等待窗口打开）。\n'
printf '退出时在应用中按 Command+Q；待这里显示退出后再关闭终端。\n\n'
"$node_bin" "$npm_cli" start
status=$?
if [ "$status" -ne 0 ]; then
  fail "$status" "npm start 未成功结束（退出码 ${status}）。请查看上方错误；本入口不会自动安装、升级或修复依赖。"
fi
printf '\nHanaAgent 开发启动进程已结束，可关闭此终端窗口。\n'
