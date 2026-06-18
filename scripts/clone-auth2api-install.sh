#!/usr/bin/env bash
set -euo pipefail

# 一键克隆 auth2api 仓库并完成依赖安装、构建和基础配置准备。
# 默认会把代码放到 /opt/auth2api，适合 VPS 迁移后的统一部署。

usage() {
  cat <<'EOF'
用法：
  sudo bash scripts/clone-auth2api-install.sh

可选参数：
  --repo https://github.com/wangguohao/auth2api.git
  --dir /opt/auth2api
  --branch main

说明：
  - 默认会执行 git clone、npm ci、npm run build
  - 如果目标目录不存在 config.yaml，会自动从 config.example.yaml 复制一份
  - 不会自动启动服务，也不会写入账号登录信息
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

REPO_URL="https://github.com/wangguohao/auth2api.git"
TARGET_DIR="/opt/auth2api"
BRANCH="main"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --repo)
      REPO_URL="${2:-}"
      shift 2
      ;;
    --dir)
      TARGET_DIR="${2:-}"
      shift 2
      ;;
    --branch)
      BRANCH="${2:-}"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "未知参数: $1" >&2
      usage
      exit 1
      ;;
  esac
done

main() {
  require_root
  require_cmd git
  require_cmd npm
  require_cmd node

  if [[ -e "${TARGET_DIR}" ]]; then
    if [[ -d "${TARGET_DIR}/.git" ]]; then
      echo "目标目录已经存在并且是 git 仓库：${TARGET_DIR}" >&2
      echo "请先确认是否要更新现有仓库，脚本不会自动覆盖。" >&2
      exit 1
    fi

    if [[ -n "$(ls -A "${TARGET_DIR}" 2>/dev/null || true)" ]]; then
      echo "目标目录已经存在且非空：${TARGET_DIR}" >&2
      exit 1
    fi
  fi

  mkdir -p "$(dirname "${TARGET_DIR}")"

  echo "[1/4] 克隆仓库 ..."
  git clone --branch "${BRANCH}" --single-branch "${REPO_URL}" "${TARGET_DIR}"

  cd "${TARGET_DIR}"

  echo "[2/4] 安装依赖 ..."
  npm ci

  echo "[3/4] 构建项目 ..."
  npm run build

  echo "[4/4] 准备基础配置 ..."
  if [[ ! -f config.yaml && -f config.example.yaml ]]; then
    cp config.example.yaml config.yaml
    echo "已创建 config.yaml：${TARGET_DIR}/config.yaml"
  fi

  echo
  echo "安装完成。"
  echo "下一步你可以："
  echo "  1. 进入目录：cd ${TARGET_DIR}"
  echo "  2. 登录账号：npm run login"
  echo "  3. 启动服务：npm start"
  echo "  4. 如果需要 nginx 域名配置，再执行：sudo bash scripts/install-nginx-domain.sh auth2api.example.com"
}

main "$@"
