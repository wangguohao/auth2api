#!/usr/bin/env bash
set -euo pipefail

# 在 Ubuntu 22.04 x64 上安装 Node.js 20 的一键脚本。
# 逻辑尽量收敛到可重复执行的 apt 安装流程，便于 VPS 迁移时直接使用。

usage() {
  cat <<'EOF'
用法：
  sudo bash scripts/install-node20.sh

说明：
  - 仅面向 Ubuntu 22.04 x64 / amd64
  - 通过 NodeSource 的 apt 仓库安装 Node.js 20
  - 会顺带安装 npm
EOF
}

require_root() {
  if [[ ${EUID} -ne 0 ]]; then
    echo "请使用 root 或 sudo 运行" >&2
    exit 1
  fi
}

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "缺少命令: $1" >&2
    exit 1
  }
}

check_platform() {
  if [[ ! -r /etc/os-release ]]; then
    echo "无法读取 /etc/os-release，无法确认系统版本" >&2
    exit 1
  fi

  # shellcheck disable=SC1091
  source /etc/os-release

  local arch_raw
  arch_raw="$(uname -m)"

  if [[ "${ID:-}" != "ubuntu" || "${VERSION_ID:-}" != "22.04" ]]; then
    echo "当前系统为 ${ID:-unknown} ${VERSION_ID:-unknown}，该脚本只面向 Ubuntu 22.04" >&2
    exit 1
  fi

  case "${arch_raw}" in
    x86_64|amd64)
      ;;
    *)
      echo "当前架构为 ${arch_raw}，该脚本只面向 x64/amd64" >&2
      exit 1
      ;;
  esac
}

install_node20() {
  export DEBIAN_FRONTEND=noninteractive

  # 先补齐 NodeSource 仓库签名和 apt HTTPS 依赖，避免后续安装失败。
  apt-get update
  apt-get install -y ca-certificates curl gnupg

  install -d -m 0755 /etc/apt/keyrings

  local tmp_dir
  tmp_dir="$(mktemp -d)"
  trap 'rm -rf "${tmp_dir}"' EXIT

  curl -fsSL "https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key" -o "${tmp_dir}/nodesource.key"
  gpg --dearmor < "${tmp_dir}/nodesource.key" > /etc/apt/keyrings/nodesource.gpg
  chmod 0644 /etc/apt/keyrings/nodesource.gpg

  cat >/etc/apt/sources.list.d/nodesource.list <<'EOF'
deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_20.x nodistro main
EOF

  apt-get update
  apt-get install -y nodejs
}

main() {
  if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
    usage
    exit 0
  fi

  require_root
  require_cmd apt-get
  check_platform

  echo "[1/2] 安装 Node.js 20 ..."
  install_node20

  echo "[2/2] 校验安装结果 ..."
  node -v
  npm -v

  echo
  echo "安装完成。"
  echo "如果你要继续安装 auth2api，可执行："
  echo "  sudo bash scripts/clone-auth2api-install.sh"
}

main "$@"
