# auth2api VPS 代理迁移手册

本文档用于在新的 VPS 上快速恢复 `auth2api + mihomo + 多账号代理` 环境。

适用前提：

- 系统：`Ubuntu 22.04 x64`
- 进程管理：`systemd`
- 代理程序：`mihomo`
- `auth2api` 已支持账号级 `routingExtra.proxy`

## 目标架构

推荐按“一个 mihomo 实例 = 一个本地端口 = 一个固定出口节点”设计：

- `mihomo@jp-at` -> `127.0.0.1:7890` -> `AnyTLS` 节点
- `mihomo@jp-hy2` -> `127.0.0.1:7891` -> `Hysteria2` 节点
- `mihomo@jp-trojan` -> `127.0.0.1:7892` -> `Trojan` 节点
- `auth2api` 不同账号分别绑定不同本地代理 URL

这样做的目的：

- 节点协议类型可以混用，`auth2api` 只关心本地 `http://127.0.0.1:port`
- 某个出口节点挂掉时，只影响绑定该端口的账号
- `auth2api` 会把发生代理网络失败的账号冷却 5 分钟，再切下一个账号

## 当前实现边界

- `routingExtra.proxy` 当前只支持 `http://` 或 `https://` 代理 URL
- `auth2api` 填的是本地 mihomo 监听地址，不是原始 `AnyTLS/HY2/Trojan` 节点配置
- 带 `routing.proxy` 的账号发生 `network` 失败时，会固定冷却 `5 分钟`
- Anthropic / Codex 的上游请求、refresh、models/usage 拉取已接入账号级代理
- Cursor 的主聊天链路目前仍是自建 HTTP/2 直连传输，尚未接入账号级代理

## 一键脚本

仓库里已经补了三份迁移脚本，适合 Ubuntu 22.04 x64 的新 VPS：

1. `scripts/install-node20.sh`：安装 Node.js 20 和 npm
2. `scripts/clone-auth2api-install.sh`：克隆仓库、安装依赖、构建项目
3. `scripts/install-nginx-domain.sh <domain>`：按域名安装 Nginx 反代配置

推荐顺序：

```bash
sudo bash scripts/install-node20.sh
sudo bash scripts/clone-auth2api-install.sh
sudo bash scripts/install-nginx-domain.sh auth2api.wghcloud.com
```

如果证书还没签发，`install-nginx-domain.sh` 会只写配置，不会强行 reload nginx。

## 需要准备的文件

迁移时建议同时备份这几类文件：

1. `auth2api` 代码仓库
2. 你的大节点 YAML，例如 `/root/all-proxies.yaml`
3. `auth2api` 的 token 目录
4. `config.yaml`
5. `api-keys.json`

如果只迁代理相关，至少要保留：

- `all-proxies.yaml`
- `scripts/install-mihomo-systemd.sh`
- `scripts/mihomo-new-instance-from-yaml.sh`

## 第一步：安装 mihomo 和 systemd 模板

进入仓库目录：

```bash
cd /path/to/auth2api
```

执行安装脚本：

```bash
sudo bash scripts/install-mihomo-systemd.sh
```

该脚本会完成：

- 安装 `curl/python3/python3-yaml`
- 下载并安装 `mihomo` 到 `/usr/local/bin/mihomo`
- 写入 `/etc/systemd/system/mihomo@.service`
- 创建 `/etc/mihomo/instances`

检查安装结果：

```bash
/usr/local/bin/mihomo -v
systemctl cat mihomo@.service
```

## 第二步：准备总节点 YAML

准备一份 Clash/Mihomo 风格的总节点文件，例如：

```yaml
proxies:
  - name: 日本-TY-4-AT-流量倍率:0.6
    type: anytls
    server: ty-4.tr202605.com
    port: 3343
    password: xxx
    udp: true
    client-fingerprint: random
    skip-cert-verify: true

  - name: 日本-TY-4-HY2-流量倍率:0.6
    type: hysteria2
    server: xxx
    port: 443
    password: xxx
    sni: xxx
    skip-cert-verify: true

  - name: 日本-OS-1-流量倍率:0.6
    type: trojan
    server: xxx
    port: 443
    password: xxx
    sni: xxx
    skip-cert-verify: true
```

要求：

- 节点必须放在 `proxies:` 列表下
- `name` 必须唯一
- 后续脚本按 `name` 精确匹配

## 第三步：从总 YAML 生成单实例配置

先 dry-run 预览：

```bash
sudo bash scripts/mihomo-new-instance-from-yaml.sh \
  --source-yaml /root/all-proxies.yaml \
  --proxy-name "日本-TY-4-AT-流量倍率:0.6" \
  --instance-name jp-at \
  --port 7890 \
  --dry-run
```

确认结果正常后正式生成：

```bash
sudo bash scripts/mihomo-new-instance-from-yaml.sh \
  --source-yaml /root/all-proxies.yaml \
  --proxy-name "日本-TY-4-AT-流量倍率:0.6" \
  --instance-name jp-at \
  --port 7890
```

生成结果：

```bash
/etc/mihomo/instances/jp-at/config.yaml
```

继续生成第二个、第三个实例：

```bash
sudo bash scripts/mihomo-new-instance-from-yaml.sh \
  --source-yaml /root/all-proxies.yaml \
  --proxy-name "日本-TY-4-HY2-流量倍率:0.6" \
  --instance-name jp-hy2 \
  --port 7891

sudo bash scripts/mihomo-new-instance-from-yaml.sh \
  --source-yaml /root/all-proxies.yaml \
  --proxy-name "日本-OS-1-流量倍率:0.6" \
  --instance-name jp-trojan \
  --port 7892
```

## 第四步：启动 mihomo 实例

启动并设置开机自启：

```bash
sudo systemctl enable mihomo@jp-at
sudo systemctl start mihomo@jp-at

sudo systemctl enable mihomo@jp-hy2
sudo systemctl start mihomo@jp-hy2

sudo systemctl enable mihomo@jp-trojan
sudo systemctl start mihomo@jp-trojan
```

查看状态：

```bash
sudo systemctl status mihomo@jp-at
sudo systemctl status mihomo@jp-hy2
sudo systemctl status mihomo@jp-trojan
```

查看日志：

```bash
sudo journalctl -u mihomo@jp-at -o cat -f
```

## 第五步：验证本地代理端口

检查监听：

```bash
ss -lntp | grep 7890
ss -lntp | grep 7891
ss -lntp | grep 7892
```

检查本地 mixed 代理能否出网：

```bash
curl -x http://127.0.0.1:7890 https://api.ipify.org
curl -x http://127.0.0.1:7891 https://api.ipify.org
curl -x http://127.0.0.1:7892 https://api.ipify.org
```

如果返回了出口 IP，说明该实例可用。

## 第六步：给 auth2api 账号绑定代理

登录新账号时直接带上 `routingExtra.proxy`：

```bash
node dist/index.js --login --provider=codex \
  --routingExtra='{"proxy":"http://127.0.0.1:7890"}'
```

另一个账号：

```bash
node dist/index.js --login --provider=codex \
  --routingExtra='{"proxy":"http://127.0.0.1:7891"}'
```

第三个账号：

```bash
node dist/index.js --login --provider=codex \
  --routingExtra='{"proxy":"http://127.0.0.1:7892"}'
```

如果账号已经登录过，也可以直接修改 token 文件中的：

```json
"routing": {
  "proxy": "http://127.0.0.1:7890"
}
```

然后执行 reload：

```bash
curl http://127.0.0.1:8317/admin/reload \
  -H "Authorization: Bearer <admin-api-key>" \
  -X POST
```

## 推荐账号分配策略

建议至少保留一个无代理兜底账号：

- 账号 A -> `7890`
- 账号 B -> `7891`
- 账号 C -> `7892`
- 账号 D -> 不配置代理，直连

优点：

- 某个节点失效时，仅影响对应账号
- 代理网络失败的账号会冷却 5 分钟
- 仍有兜底账号可继续服务

## 代理故障时的当前行为

当前 `auth2api` 的行为：

1. 某个账号使用的本地代理端口不可用
2. 本次请求会表现为该账号 `network failure`
3. 如果该账号配置了 `routing.proxy`，则固定冷却 `5 分钟`
4. 同一次请求会继续尝试下一个账号

这适用于：

- 某个 mihomo 实例挂掉
- 某个本地端口不可连接
- 某个出口节点连不上

## 常用运维命令

启动：

```bash
sudo systemctl start mihomo@jp-at
```

停止：

```bash
sudo systemctl stop mihomo@jp-at
```

重启：

```bash
sudo systemctl restart mihomo@jp-at
```

查看状态：

```bash
sudo systemctl status mihomo@jp-at
```

查看日志：

```bash
sudo journalctl -u mihomo@jp-at -o cat -f
```

查看实例配置：

```bash
sudo cat /etc/mihomo/instances/jp-at/config.yaml
```

## 迁移时最短恢复顺序

在新 VPS 上，按这个顺序恢复：

1. 同步 `auth2api` 仓库
2. 同步 `/root/all-proxies.yaml`
3. 运行 `scripts/install-mihomo-systemd.sh`
4. 为每个需要的节点运行 `scripts/mihomo-new-instance-from-yaml.sh`
5. `systemctl enable/start mihomo@实例名`
6. 用 `curl -x` 验证代理出口
7. 恢复 `auth2api` token/config/api-keys
8. 启动 `auth2api`
9. 验证各账号是否按预期走不同出口

## 建议的首批实例数量

第一次迁移不要一次起太多实例，建议先起 2 到 3 个：

- 1 个 `AnyTLS`
- 1 个 `Hysteria2`
- 1 个 `Trojan`

先确认：

- 本地端口可监听
- 出口节点稳定
- `auth2api` 绑定后请求成功

再继续追加更多实例。
