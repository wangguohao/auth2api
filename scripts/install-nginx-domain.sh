#!/usr/bin/env bash
set -euo pipefail

# 为 auth2api 安装 Nginx 域名配置的脚本。
# 默认写入 sites-available，并在证书文件存在时自动启用和 reload。

usage() {
  cat <<'EOF'
用法：
  sudo bash scripts/install-nginx-domain.sh auth2api.wghcloud.com

可选参数：
  --upstream-port 8317
  --site-name auth2api

说明：
  - 会把配置写到 /etc/nginx/sites-available/<site-name>-<domain>.conf
  - 默认 upstream 指向 127.0.0.1:8317
  - 如果 /etc/letsencrypt/live/<domain>/ 下的证书文件已经存在，脚本会自动启用站点并 reload nginx
  - 如果证书尚未签发，脚本只落盘配置文件，不会强行 reload，避免把当前 nginx 配置打坏
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

DOMAIN=""
UPSTREAM_PORT="8317"
SITE_NAME="auth2api"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --upstream-port)
      UPSTREAM_PORT="${2:-}"
      shift 2
      ;;
    --site-name)
      SITE_NAME="${2:-}"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      if [[ -z "${DOMAIN}" ]]; then
        DOMAIN="$1"
        shift
      else
        echo "未知参数: $1" >&2
        usage
        exit 1
      fi
      ;;
  esac
done

if [[ -z "${DOMAIN}" ]]; then
  usage
  exit 1
fi

if ! [[ "${UPSTREAM_PORT}" =~ ^[0-9]+$ ]] || (( UPSTREAM_PORT < 1 || UPSTREAM_PORT > 65535 )); then
  echo "upstream port 非法: ${UPSTREAM_PORT}" >&2
  exit 1
fi

CONFIG_FILE="/etc/nginx/sites-available/${SITE_NAME}-${DOMAIN}.conf"
ENABLED_LINK="/etc/nginx/sites-enabled/${SITE_NAME}-${DOMAIN}.conf"
CERT_DIR="/etc/letsencrypt/live/${DOMAIN}"
FULLCHAIN_FILE="${CERT_DIR}/fullchain.pem"
PRIVKEY_FILE="${CERT_DIR}/privkey.pem"
OPTIONS_FILE="/etc/letsencrypt/options-ssl-nginx.conf"
DHPARAM_FILE="/etc/letsencrypt/ssl-dhparams.pem"

main() {
  require_root
  require_cmd apt-get

  export DEBIAN_FRONTEND=noninteractive

  # Nginx 和证书目录可能在迁移机上都不存在，先把基础包补齐。
  apt-get update
  apt-get install -y nginx

  require_cmd nginx
  systemctl enable nginx >/dev/null 2>&1 || true
  systemctl start nginx >/dev/null 2>&1 || true

  install -d -m 0755 /etc/nginx/sites-available /etc/nginx/sites-enabled

  # 如果配置已经存在，先备份一份，避免重复执行时悄悄覆盖掉旧内容。
  if [[ -f "${CONFIG_FILE}" ]]; then
    local backup_file
    backup_file="${CONFIG_FILE}.bak.$(date +%Y%m%d%H%M%S)"
    cp "${CONFIG_FILE}" "${backup_file}"
    echo "已备份旧配置：${backup_file}"
  fi

  tee "${CONFIG_FILE}" >/dev/null <<EOF
server {
    server_name ${DOMAIN};

    location / {
        proxy_pass http://127.0.0.1:${UPSTREAM_PORT};
        proxy_http_version 1.1;
        proxy_set_header Connection "";

        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;

        # =========================
        # AI Gateway 必备优化
        # =========================

        client_max_body_size 100m;

        proxy_connect_timeout 600;
        proxy_send_timeout 600;
        proxy_read_timeout 600;
        send_timeout 600;

        proxy_buffering off;
    }

    listen 443 ssl; # managed by Certbot

    ssl_certificate ${FULLCHAIN_FILE};
    ssl_certificate_key ${PRIVKEY_FILE};
    include ${OPTIONS_FILE};
    ssl_dhparam ${DHPARAM_FILE};
}
EOF

  echo "已写入 Nginx 配置：${CONFIG_FILE}"

  if [[ -f "${FULLCHAIN_FILE}" && -f "${PRIVKEY_FILE}" && -f "${OPTIONS_FILE}" && -f "${DHPARAM_FILE}" ]]; then
    ln -sfn "${CONFIG_FILE}" "${ENABLED_LINK}"
    nginx -t
    systemctl reload nginx || systemctl restart nginx
    echo "已启用站点并重载 Nginx：${DOMAIN}"
  else
    echo
    echo "未检测到完整的 Let's Encrypt 证书文件，已仅写入配置，未启用站点。"
    echo "请先为 ${DOMAIN} 申请证书，证书存在后重新执行本脚本即可自动启用。"
  fi

  echo
  echo "当前 upstream：127.0.0.1:${UPSTREAM_PORT}"
}

main "$@"
