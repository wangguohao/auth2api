#!/usr/bin/env bash
set -euo pipefail

# Ubuntu 22.04 / Debian 系的一次性基础安装脚本：
# 1. 下载并安装 mihomo
# 2. 安装 mihomo@.service systemd 模板
# 3. 准备 /etc/mihomo/instances 目录
# 4. 安装 python3-yaml，供实例生成脚本解析 YAML

usage() {
  cat <<'EOF'
用法：
  sudo bash scripts/install-mihomo-systemd.sh

说明：
  - 该脚本面向 Linux x86_64/amd64、arm64
  - 默认把 mihomo 安装到 /usr/local/bin/mihomo
  - 默认创建 systemd 模板服务 /etc/systemd/system/mihomo@.service
EOF
}

require_root() {
  if [[ ${EUID} -ne 0 ]]; then
    echo "请使用 root 运行" >&2
    exit 1
  fi
}

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "缺少命令: $1" >&2
    exit 1
  }
}

install_base_packages() {
  export DEBIAN_FRONTEND=noninteractive
  apt-get update
  apt-get install -y curl gzip tar python3 python3-yaml ca-certificates
}

resolve_arch() {
  local arch_raw
  arch_raw="$(uname -m)"
  case "${arch_raw}" in
    x86_64|amd64)
      echo "amd64-compatible amd64"
      ;;
    aarch64|arm64)
      echo "arm64"
      ;;
    *)
      echo "不支持的架构: ${arch_raw}" >&2
      exit 1
      ;;
  esac
}

main() {
  if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
    usage
    exit 0
  fi

  require_root
  require_cmd apt-get

  local tmp_dir
  tmp_dir="$(mktemp -d)"
  trap 'rm -rf "${tmp_dir}"' EXIT

  echo "[1/5] 安装基础依赖..."
  install_base_packages

  require_cmd curl
  require_cmd gzip
  require_cmd tar
  require_cmd python3
  require_cmd systemctl

  echo "[2/5] 获取 mihomo 最新版本..."
  curl -fsSL "https://api.github.com/repos/MetaCubeX/mihomo/releases/latest" \
    -o "${tmp_dir}/latest.json"

  local arch_candidates
  arch_candidates="$(resolve_arch)"

  local download_url
  python3 - "${tmp_dir}/latest.json" ${arch_candidates} > "${tmp_dir}/download_url.txt" <<'PY'
import json
import sys

path = sys.argv[1]
arch_candidates = sys.argv[2:]

with open(path, "r", encoding="utf-8") as f:
    data = json.load(f)

assets = data.get("assets", [])
urls = [a.get("browser_download_url", "") for a in assets]

patterns = []
for arch in arch_candidates:
    patterns.extend([
        f"mihomo-linux-{arch}-",
        f"mihomo-linux-{arch}.",
    ])

for p in patterns:
    for url in urls:
        if p in url and url.endswith(".gz"):
            print(url)
            raise SystemExit(0)

raise SystemExit("没有找到匹配当前架构的 mihomo 压缩包")
PY
  download_url="$(cat "${tmp_dir}/download_url.txt")"

  echo "下载地址: ${download_url}"
  curl -fL "${download_url}" -o "${tmp_dir}/mihomo.gz"

  echo "[3/5] 安装 mihomo 到 /usr/local/bin/mihomo ..."
  gzip -dc "${tmp_dir}/mihomo.gz" > "${tmp_dir}/mihomo"
  install -m 0755 "${tmp_dir}/mihomo" /usr/local/bin/mihomo

  echo "[4/5] 写入 systemd 模板服务..."
  mkdir -p /etc/mihomo/instances
  tee /etc/systemd/system/mihomo@.service >/dev/null <<'EOF'
[Unit]
Description=mihomo instance %i
After=network.target NetworkManager.service systemd-networkd.service iwd.service

[Service]
Type=simple
LimitNPROC=500
LimitNOFILE=1000000
Restart=always
ExecStartPre=/usr/bin/sleep 1s
ExecStart=/usr/local/bin/mihomo -d /etc/mihomo/instances/%i
ExecReload=/bin/kill -HUP $MAINPID

[Install]
WantedBy=multi-user.target
EOF

  echo "[5/5] 重新加载 systemd ..."
  systemctl daemon-reload

  echo
  echo "安装完成。"
  echo "检查版本："
  echo "  /usr/local/bin/mihomo -v"
  echo
  echo "下一步可以执行："
  echo "  sudo bash scripts/mihomo-new-instance-from-yaml.sh \\"
  echo "    --source-yaml /root/all-proxies.yaml \\"
  echo "    --proxy-name \"日本-TY-4-AT-流量倍率:0.6\" \\"
  echo "    --instance-name jp-at \\"
  echo "    --port 7890"
}

main "$@"
