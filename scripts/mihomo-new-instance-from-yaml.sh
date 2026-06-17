#!/usr/bin/env bash
set -euo pipefail

# 从 Clash/Mihomo YAML 中提取单个代理节点，生成一个独立的 mihomo 实例配置。
# 适用场景：为 auth2api 的不同账号绑定不同本地 mixed 端口。

usage() {
  cat <<'EOF'
用法：
  bash scripts/mihomo-new-instance-from-yaml.sh \
    --source-yaml /path/to/source.yaml \
    --proxy-name "日本-TY-4-AT-流量倍率:0.6" \
    --instance-name jp-at \
    --port 7890

可选参数：
  --listen 127.0.0.1
  --config-root /etc/mihomo/instances
  --dry-run

说明：
  1. 只会从 source.yaml 的 proxies: 列表中精确匹配 name
  2. 生成的实例配置仅包含一个代理节点，并通过 MATCH,<节点名> 固定全量流量走该节点
  3. 该脚本默认只写配置，不自动启动 systemd 服务
EOF
}

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "缺少命令: $1" >&2
    exit 1
  }
}

ensure_pyyaml() {
  if python3 - <<'PY' >/dev/null 2>&1
import yaml
PY
  then
    return 0
  fi

  if [[ ${EUID} -eq 0 ]] && command -v apt-get >/dev/null 2>&1; then
    echo "未检测到 PyYAML，正在安装 python3-yaml..."
    apt-get update
    apt-get install -y python3-yaml
    return 0
  fi

  echo "缺少 PyYAML。请先安装：apt-get install -y python3-yaml" >&2
  exit 1
}

SOURCE_YAML=""
PROXY_NAME=""
INSTANCE_NAME=""
PORT=""
LISTEN_ADDR="127.0.0.1"
CONFIG_ROOT="/etc/mihomo/instances"
DRY_RUN="false"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --source-yaml)
      SOURCE_YAML="${2:-}"
      shift 2
      ;;
    --proxy-name)
      PROXY_NAME="${2:-}"
      shift 2
      ;;
    --instance-name)
      INSTANCE_NAME="${2:-}"
      shift 2
      ;;
    --port)
      PORT="${2:-}"
      shift 2
      ;;
    --listen)
      LISTEN_ADDR="${2:-}"
      shift 2
      ;;
    --config-root)
      CONFIG_ROOT="${2:-}"
      shift 2
      ;;
    --dry-run)
      DRY_RUN="true"
      shift
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

if [[ -z "${SOURCE_YAML}" || -z "${PROXY_NAME}" || -z "${INSTANCE_NAME}" || -z "${PORT}" ]]; then
  usage
  exit 1
fi

if [[ ! -f "${SOURCE_YAML}" ]]; then
  echo "source yaml 不存在: ${SOURCE_YAML}" >&2
  exit 1
fi

if ! [[ "${PORT}" =~ ^[0-9]+$ ]] || (( PORT < 1 || PORT > 65535 )); then
  echo "port 非法: ${PORT}" >&2
  exit 1
fi

require_cmd python3
ensure_pyyaml

INSTANCE_DIR="${CONFIG_ROOT}/${INSTANCE_NAME}"
OUTPUT_FILE="${INSTANCE_DIR}/config.yaml"
TMP_FILE="$(mktemp)"
trap 'rm -f "${TMP_FILE}"' EXIT

# 使用 Python 解析 YAML，避免 shell 对中文、冒号和多协议字段处理不稳。
python3 - "${SOURCE_YAML}" "${PROXY_NAME}" "${PORT}" "${LISTEN_ADDR}" > "${TMP_FILE}" <<'PY'
import sys
import yaml

source_yaml = sys.argv[1]
proxy_name = sys.argv[2]
port = int(sys.argv[3])
listen_addr = sys.argv[4]

with open(source_yaml, "r", encoding="utf-8") as f:
    data = yaml.safe_load(f) or {}

proxies = data.get("proxies")
if not isinstance(proxies, list):
    raise SystemExit("源 YAML 中未找到 proxies 列表")

matched = None
for proxy in proxies:
    if isinstance(proxy, dict) and proxy.get("name") == proxy_name:
        matched = proxy
        break

if matched is None:
    raise SystemExit(f"未在 proxies 中找到 name={proxy_name!r} 的节点")

config = {
    "mixed-port": port,
    "allow-lan": False,
    "mode": "rule",
    "log-level": "info",
    "proxies": [matched],
    "rules": [f"MATCH,{proxy_name}"],
}

if listen_addr:
    config["bind-address"] = listen_addr

print(
    yaml.safe_dump(
        config,
        allow_unicode=True,
        sort_keys=False,
        default_flow_style=False,
    ),
    end="",
)
PY

echo "已匹配节点: ${PROXY_NAME}"
echo "目标实例: ${INSTANCE_NAME}"
echo "本地端口: ${LISTEN_ADDR}:${PORT}"

if [[ "${DRY_RUN}" == "true" ]]; then
  echo
  echo "----- 预览生成配置 -----"
  cat "${TMP_FILE}"
  exit 0
fi

mkdir -p "${INSTANCE_DIR}"
cp "${TMP_FILE}" "${OUTPUT_FILE}"

echo "已写入: ${OUTPUT_FILE}"
echo
echo "下一步："
echo "  systemctl enable mihomo@${INSTANCE_NAME}"
echo "  systemctl start mihomo@${INSTANCE_NAME}"
echo "  journalctl -u mihomo@${INSTANCE_NAME} -o cat -f"
echo
echo "auth2api 可绑定："
echo "  http://${LISTEN_ADDR}:${PORT}"
