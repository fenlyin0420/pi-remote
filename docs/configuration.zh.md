# Remote Pi 配置文档（Linux / Windows）

覆盖桌面插件 [`fenlyin0420/pi-remote`](https://github.com/fenlyin0420/pi-remote) 与手机端
[`fenlyin0420/pi-remote-app`](https://github.com/fenlyin0420/pi-remote-app)。协议本身见
[`PROTOCOL.md`](../PROTOCOL.md)，这里只讲**怎么配**。

---

## 1. 组件与配置面

```
手机 App ──WSS──> Relay <──WSS── Pi 扩展 / daemon（supervisord 拉起）
                        │
        Pi ↔ Pi（同机）: UDS broker / Windows 命名管道
        Pi ↔ Pi（跨机）: 经 Relay 转发
```

四类配置，分别落在不同位置：

| 配置面 | 位置 | 谁写 |
|---|---|---|
| Relay 地址（全机） | `~/.pi/remote/config.json` | `/remote-pi set-relay`、`remote-pi set-relay`、env |
| 每个目录的 agent 名 / 是否连 relay | `<cwd>/.pi/remote-pi/config.json` | `/remote-pi setup`、`/remote-pi rename`、`remote-pi create` |
| 运行时开关 | 环境变量（`REMOTE_PI_*`） | 部署脚本、CI、systemd/Task Scheduler |
| 手机端设置 | App 内 Settings + 构建期 Gradle 变量 | 用户 / 发版流水线 |

## 2. 前置条件

| 项 | Linux | Windows |
|---|---|---|
| Node.js | ≥ 20.0.0（Pi 本身要求 ≥ 20.6.0） | 同左 |
| Pi 命令行 | `npm i -g @earendil-works/pi-coding-agent` | 同左（生成 `pi.cmd`，需在 PATH 中） |
| 其他 | `git`、`systemd`（用户实例）；身份密钥建议有 libsecret/gnome-keyring | `git`、PowerShell、任务计划程序（系统自带） |
| 手机 | Android 14+（API 34） | 同左 |

Windows 原生支持，**不需要 WSL**：本地 IPC 用命名管道，守护进程用任务计划程序。

## 3. 安装

### 3.1 安装扩展（两个平台相同）

```text
pi install git:github.com/fenlyin0420/pi-remote
```

随后在 Pi 里 `/remote-pi` 会走首次向导：

1. **Agent 名** — 默认取当前目录名（leaf），地址形如 `<cwd>@<名字>`；重命名用 `/remote-pi rename`。
2. **是否在这个终端连 relay** — `No` 则只加入本机 mesh，不开 WSS（手机连不上这台 Pi）。
3. 确认保存。

向导写入 `<cwd>/.pi/remote-pi/config.json`：

```json
{ "agent_name": "Jarvis", "auto_start_relay": true }
```

`auto_start_relay` 缺省按 `true` 处理；**daemon 必须为 `true`**，否则 supervisor 拉起的 daemon 不连 relay，手机端看不到。

### 3.2 安装 CLI 与守护服务

两条路径，区别在于 CLI 二进制从哪来：

| 方式 | 命令 | 结果 |
|---|---|---|
| 只要扩展（推荐配合 TUI） | `pi install git:…`，然后在 Pi 内 `/remote-pi install` | 服务装好；并在 `~/.local/bin` 写 `remote-pi` / `pi-supervisord` 链接（Windows 为 `.cmd` 垫片） |
| 全局 CLI | `npm install -g github:fenlyin0420/pi-remote` 然后 `remote-pi install` | 二进制来自 npm 全局前缀，**不会再往 `~/.local/bin` 写链接** |

Linux：`~/.local/bin` 不在 PATH 时需自己加 `export PATH="$HOME/.local/bin:$PATH"`。
Windows：安装会写 `.cmd` 垫片并把 `%USERPROFILE%\.local\bin` 追加进**用户级 PATH（HKCU，无需管理员）**，之后要新开终端。

### 3.3 Linux：systemd 用户单元

`remote-pi install` 生成并启用 `~/.config/systemd/user/remote-pi-supervisord.service`：

- `ExecStart=<node> <dist/bin/supervisord.js>`（node 为安装时那一份 `process.execPath`，绝对路径）
- `Restart=on-failure`、`RestartSec=5s`
- `Environment="PATH=…"`、`Environment="HOME=…"`：**安装瞬间的 PATH 被烤进单元**。之后才改 `pi` 的安装位置/版本，需重跑 `remote-pi install` 刷新。

无图形会话的服务器（`systemctl --user` 报 "No such file or directory" 或注销后服务停）：

```bash
loginctl enable-linger "$USER"
systemctl --user daemon-reload
remote-pi install
```

日志与启停：

```bash
systemctl --user status remote-pi-supervisord
journalctl --user -u remote-pi-supervisord -f
remote-pi restart-supervisor        # 等价 systemctl --user restart
remote-pi uninstall                 # 卸载单元，保留 daemons.json
```

### 3.4 Windows：任务计划程序

`remote-pi install`（或 Pi 内 `/remote-pi install`）做三件事：

1. 写 `%USERPROFILE%\.pi\remote\RemotePiSupervisor.xml`（UTF-16LE + BOM，`schtasks` 的硬要求）。
2. 写 `%USERPROFILE%\.pi\remote\RemotePiSupervisorLauncher.vbs`：用 `wscript.exe` 隐藏窗口启动 node，并把 stdout/stderr 追加到 `supervisord.log`。
3. `schtasks /End` 清掉旧实例 → **UAC 提权**执行 `schtasks /Create /XML … /TN RemotePiSupervisor /F` → `schtasks /Run /TN RemotePiSupervisor`。
   只有 `/Create`（和卸载时的 `/Delete`）需要管理员，`/End`、`/Run` 不需要。

任务定义的关键属性：

| 属性 | 值 | 含义 |
|---|---|---|
| 触发器 | `LogonTrigger` | **登录后才启动**，不是开机服务；无人登录不跑 |
| 主体 | `InteractiveToken` + `LeastPrivilege` | 用当前用户的登录令牌，不提权运行 |
| 多实例 | `IgnoreNew` | 已有实例在跑时忽略新启动 |
| 失败重启 | `PT1M` × 999 | 崩了每分钟重试 |
| 时限 | `PT0S` | 不限运行时长 |
| 窗口 | `Hidden` | 不弹控制台 |

日志与启停：

```powershell
schtasks /Query /TN RemotePiSupervisor /V /FO LIST
Get-Content "$env:USERPROFILE\.pi\remote\supervisord.log" -Tail 50 -Wait
remote-pi restart-supervisor        # schtasks /End + /Run，无需提权
remote-pi uninstall                 # 提权 /Delete，并删掉 xml 与 vbs
```

daemon 的 `pi` 解析：supervisor 用 `where pi` 找，优先 `.exe/.cmd/.bat`；若拿到 npm 的 `pi.cmd`，会解析出里面的 `node <cli.js>` 直接 spawn（避免 shell 层被 kill 后留下孤儿进程）。所以 **`pi` 必须在登录用户的 PATH 里**，否则 daemon 状态显示 `crashed`。

## 4. Relay 配置

### 4.1 解析顺序

1. 环境变量 `REMOTE_PI_RELAY`
2. `~/.pi/remote/config.json` 的 `relay` 字段
3. 内置默认 `https://relay-rp1.jacobmoura.work`

写入方式（三者等价）：

```text
/remote-pi set-relay https://relay.example.tld
/remote-pi relay url https://relay.example.tld
remote-pi set-relay https://relay.example.tld
```

规则：

- 只接受 `http://` / `https://`；`ws://` / `wss://` 会被拒（扩展/App 内部自行转 WebSocket）。
- 可以在 URL 里带端口（`https://relay.example.tld:8443`）。
- 改地址后：扩展侧 `/remote-pi relay stop` → `/remote-pi relay start`（或 `/remote-pi relay` 切换）；daemon 需 `remote-pi daemon restart`。
- 校验：

```text
/remote-pi config      # 打印生效的 relay 与来源（env / config / default）
```

### 4.2 自建 relay

```bash
docker run -d \
  --name remote-pi-relay \
  -p 3000:3000 \
  --restart unless-stopped \
  ghcr.io/jacobaraujo7/remote-pi-relay:latest
```

- 单端口同时提供三面：`/`（WebSocket upgrade）、`/health`（探活）、`/mesh/<hash>`（签名的 mesh 版本 blob，存 SQLite）。
- 外层 envelope 上限 4 MiB，可用 `RELAY_MAX_CT_MIB` 调整；调大要同时照顾手机端与 Pi 端的内存预算。
- Relay 不存私钥、不做业务鉴权，靠 Ed25519 握手认证；**它是一个可见明文的转发者**，隐私靠自建 + VPN 兜底。
- TLS：裸 IP 拿不到受信任证书（自签证书 App 不接受），要么域名 + 反向代理，要么明文 + 靠 keypair 认证（链路不加密）。

### 4.3 手机端指向同一个 relay

App 的 relay 地址**独立于 PC 配置**，两边必须一致：Settings → Relay 填同一个 `http(s)://` URL。
PC 改地址不需要重新配对，前提是 keypair 与 `peers.json` 没动；连不上再走 QR 重配。

## 5. 配对与身份

```text
/remote-pi pair              # 终端出二维码（外加可复制的配对 URI）
/remote-pi devices           # 已配对设备（在线/离线）
/remote-pi revoke <shortid>  # 撤销，shortid = devices 显示的前 8 位
```

- 配对是**按机器**的，落在 `~/.pi/remote/peers.json`，同机所有 Pi 进程共享。
- Pi 身份是 Ed25519 Pi-key，存在 OS 密钥环（服务名 `dev.remotepi.pi`）：

| 平台 | keyring |
|---|---|
| Linux | libsecret / gnome-keyring；无桌面会话时可能不可用 |
| Windows | 凭据管理器（Credential Manager） |
| macOS | Keychain |

- keyring 读不到时（headless Linux、无 D-Bus）会落 `~/.pi/remote/identity.json`（`0600`，带警告）。**`identity.json` 一旦存在就永远优先**，因为手机是照它配对的。在 macOS/Windows 上若 keyring 持续读失败，会直接报错而不是新生成密钥（避免静默丢配对）；确定要文件身份时设 `REMOTE_PI_ALLOW_FILE_IDENTITY=1`。
- 同一台机器的 keypair 被复制到另一台会被 relay 当成同一 PC（clone detection 尚未实现），迁移机器时注意。

## 6. 环境变量

`REMOTE_PI_HOME` 在 Windows 的等价写法是 `set REMOTE_PI_HOME=C:\path` 或 `$env:REMOTE_PI_HOME="C:\path"`。

| 变量 | 作用 | 常规用途 |
|---|---|---|
| `REMOTE_PI_RELAY` | 覆盖 relay URL（最高优先级） | CI / 一次性切换 |
| `REMOTE_PI_HOME` | 状态根，默认 `~`/`%USERPROFILE%`；实际用 `<root>/.pi/remote/` | 测试隔离、多身份 |
| `REMOTE_PI_DIRECT_CONFIG` | 内联 JSON 形式的每目录配置，优先于 `config.json` | daemon、容器、只读配置 |
| `REMOTE_PI_ALLOW_FILE_IDENTITY` | `=1` 强制使用 `identity.json` | headless macOS/Windows |
| `REMOTE_PI_MCP_CWD` / `REMOTE_PI_MCP_NAME` | MCP mesh server 的目录 / 名 | `remote-pi claude` 之外的接法 |
| `REMOTE_PI_SYNC_LIMIT` | 历史重放事件条数上限（默认 10000） | 手机端历史被截断时调大 |
| `REMOTE_PI_SYNC_MAX_BYTES` | 历史重放字节预算（默认 3 MiB） | 同上，注意 relay 4 MiB 上限 |
| `REMOTE_PI_LOCK_RETRY_MS` | daemon 抢目录锁的重试间隔（默认 15 s） | 调优/测试 |
| `REMOTE_PI_DAEMON` / `REMOTE_PI_EPHEMERAL` | supervisor 注入给子进程 | 内部，不要手设 |
| `RELAY_MAX_CT_MIB` | relay 侧外层 envelope 上限（默认 4 MiB） | 自建 relay |
| `REMOTE_PI_HOSTS` | App 构建期：允许明文 HTTP 的主机列表 | App 发版 |

## 7. daemon fleet 与定时任务

```bash
remote-pi create ~/work/Jarvis --name "Jarvis"   # 注册目录（id = sha256(realpath)[:8]）
remote-pi daemons                                # 注册表 + 运行态
remote-pi daemon start|stop|restart [<id>]       # 全部或单个
remote-pi daemon status                          # pid / uptime / 重启次数
remote-pi daemon send <id> "…"                   # 给 daemon 发一条 prompt
remote-pi remove <id>                            # 注销（保留该目录的 config.json）
```

- 注册表：`~/.pi/remote/daemons.json`。
- supervisor 为每个条目拉起 `pi --mode rpc`，注入 `REMOTE_PI_DAEMON=1` 与该目录的配置。
- 房间（= App 里的 tile）由 `(realpath(cwd), name)` 派生；同目录不同名可以并存，同名同目录互斥（目录锁）。
- 保活：崩溃后按 1s / 5s / 30s / 5min 退避重启，用完预算标记 `crashed`。

定时 prompt（需要 supervisor 作为服务在跑）：

```bash
remote-pi cron add <id> "0 9 * * *" "总结新的 PR" --tz Asia/Shanghai [--wake] [--no-skip-busy] [--catchup]
remote-pi cron list|run <jobId>|enable|disable|remove|log
```

最小间隔 60 秒；daemon 正在跑一轮时默认跳过；每次触发/跳过都会在 `~/.pi/remote/cron.jsonl` 里留一行。
配置存在 `~/.pi/remote/cron.json`。

## 8. 手机端配置

### 8.1 首次与设置

按向导走三步：欢迎 → 选 relay（自建 / 社区默认）→ 扫 PC 上 `/remote-pi pair` 的二维码。
Settings 分区：

| 分区 | 内容 |
|---|---|
| Pairings | 每台已配对 PC 的昵称、连接状态、撤销；撤销最后一台会退回 onboarding |
| Relay | relay URL 输入框 + `Current:` 提示 + Save / Use default Relay；保存即断开重连 |
| Display | 主题（System/Light/Dark）、字号档位 |
| Background | 「Stay connected」——后台保持连接、回复变通知（仅 Android 显示；需要通知权限，避开厂商省电策略）。划掉最近任务即断开 |
| 其他 | 更新横幅（读本仓 releases 的 atom 源 + `latest.json`）、会话/房间切换、Quick Actions（compact / new session / model / thinking） |

relay URL 规则与 PC 端一致：只收 `http(s)://`，`ws(s)://` 会提示「app 会自动转换」。

### 8.2 构建期变量

| 变量 | 作用 |
|---|---|
| `REMOTE_PI_HOSTS` | 逗号/空格分隔的主机名或 IP；Gradle 据此生成 `network_security_config.xml`，把这些主机的明文 HTTP 放行。不设则**没有任何明文例外** |

```bash
REMOTE_PI_HOSTS="192.168.1.10 relay.example.lan" flutter build apk --release --flavor prod
```

- 变体：`prod`（`work.jacobmoura.remotepi`）/ `beta`（`work.jacobmoura.remotepi.beta`，可与正式版并存）。版本号取 `pubspec.yaml` 的 `version: x.y.z+N`，tag 必须匹配。
- 注意：这个白名单作用在 Android 平台层的明文策略上；App 的 WebSocket 走 dart:io 原生 socket，实测不受该策略约束，因此裸 `http://` 的 relay 通常仍能连上。仍建议按实际主机配上，行为更可预期。
- App 的默认 relay 是编译进包的常量（`kDefaultRelayUrl`），不可在构建时覆盖；要换地址只能在 App 内填。

## 9. 路径对照

| 内容 | Linux | Windows |
|---|---|---|
| 全局配置（relay） | `~/.pi/remote/config.json` | `%USERPROFILE%\.pi\remote\config.json` |
| 每目录配置 | `<cwd>/.pi/remote-pi/config.json` | `<cwd>\.pi\remote-pi\config.json` |
| 已配对设备 | `~/.pi/remote/peers.json` | `%USERPROFILE%\.pi\remote\peers.json` |
| 身份（回退） | `~/.pi/remote/identity.json` | `%USERPROFILE%\.pi\remote\identity.json` |
| daemon 注册表 | `~/.pi/remote/daemons.json` | `%USERPROFILE%\.pi\remote\daemons.json` |
| 定时任务 | `~/.pi/remote/cron.json` + `cron.jsonl` | 同左（`%USERPROFILE%` 下） |
| 上传落盘 | `~/.pi/remote/uploads/<room>/` | 同左 |
| Broker（本地 mesh） | `~/.pi/remote/sessions/local/broker.sock` | `\\.\pipe\remote-pi-broker-local-<用户>` |
| Broker 审计 | `~/.pi/remote/sessions/local/audit.jsonl` | 同左 |
| 目录锁 | `~/.pi/remote/locks/<roomId>.sock` | `\\.\pipe\remote-pi-lock-<roomId>-<用户>` |
| supervisor IPC | `~/.pi/remote/supervisor.sock` | `\\.\pipe\remote-pi-supervisor-<用户>` |
| supervisor 日志 | `journalctl --user -u remote-pi-supervisord` | `%USERPROFILE%\.pi\remote\supervisord.log` |
| 服务定义 | `~/.config/systemd/user/remote-pi-supervisord.service` | `%USERPROFILE%\.pi\remote\RemotePiSupervisor.xml` + `…Launcher.vbs` |
| CLI 垫片 | `~/.local/bin/{remote-pi,pi-supervisord}`（符号链接） | `%USERPROFILE%\.local\bin\{remote-pi.cmd,pi-supervisord.cmd}` |

## 10. 平台差异速查

| 维度 | Linux | Windows |
|---|---|---|
| 本地 IPC | 文件系统 UDS（`.sock`） | 命名管道（进程退出即消失，无残留文件） |
| 守护方式 | `systemd --user` + `enable --now` | 任务计划程序 + VBS 隐藏窗口 |
| 启动时机 | 登录后；`enable-linger` 可脱离登录 | 仅用户登录后（InteractiveToken） |
| 管理员权限 | 不需要 | 安装/卸载那一次需要 UAC 确认 |
| PATH 注入 | 单元里烤 `PATH`/`HOME` | 用户级 PATH（HKCU）+ 登录环境继承 |
| CLI 暴露 | 符号链接 | `.cmd` 垫片（内容为 `node "<dist/index.js>" %*`） |
| 日志 | journald | 追加到 `supervisord.log` |
| 身份密钥 | libsecret（可能缺） | 凭据管理器 |
| daemon 的 `pi` | PATH 直取 | `where` → `.cmd` 垫片 → 解析成 `node <cli.js>` |

## 11. 校验与排障

### 11.1 通用自检

```text
/remote-pi config       # relay + 来源
/remote-pi status       # 本地 mesh + relay 状态
remote-pi devices       # 手机配对情况
remote-pi daemons       # 注册表 + 运行态
remote-pi daemon status # pid / uptime / 重启次数
remote-pi peers         # 本机 + 跨机 mesh 成员（只读探针，不注册自己）
```

### 11.2 常见症状

| 症状 | 排查 |
|---|---|
| App 连不上 | 两端 relay URL 是否一致（`/remote-pi config` vs App Settings → Relay）；`/remote-pi devices` 里该设备是否在线；`auto_start_relay` 是否为 `true` |
| daemon 一直 `crashed` | `supervisord.log` / journal 里带 `[<cwd>]` 前缀的 stderr；在该目录手跑 `REMOTE_PI_DAEMON=1 pi --mode rpc -e <dist/index.js>` 复现 |
| Linux 重启后不跑 | `systemctl --user status`；headless 需 `loginctl enable-linger`；日志里 `pi: command not found` 说明装好 Pi 后没重跑 `remote-pi install`（PATH 被烤进了单元） |
| Windows 重启后不跑 | `schtasks /Query /TN RemotePiSupervisor /V /FO LIST` 看 `Last Result`；确认是「登录后」而不是「开机」触发；`schtasks /Run` 手动拉起看日志 |
| Windows 找不到 `remote-pi` | 是否新开了终端（PATH 是安装时才写的）；`%USERPROFILE%\.local\bin` 是否在用户 PATH |
| 安装报权限错误 | Windows：UAC 被拒；Linux：`~/.pi/remote` 曾以 sudo 创建导致属主不对（删掉重装） |
| 手机历史不全 | 调 `REMOTE_PI_SYNC_LIMIT` / `REMOTE_PI_SYNC_MAX_BYTES`（注意 relay 4 MiB 上限） |
| 配对莫名其妙失效 | `identity.json` 与 keyring 混用；确认机器上只存在一份身份 |

### 11.3 彻底重装

```bash
remote-pi uninstall          # 卸服务（保留注册表）
rm -rf ~/.pi/remote          # 删注册表、配对、身份
npm uninstall -g remote-pi
npm install -g github:fenlyin0420/pi-remote
remote-pi install
# 各目录的 <cwd>/.pi/remote-pi/config.json 仍保留，需要重置就一并删掉
```

## 12. 可选：Claude 加入 mesh

```bash
remote-pi claude [cwd] [claude 旗标…]
```

不做持久配置：MCP server（`remote-pi-mesh`）通过一次性的 `--mcp-config` 临时文件注入，并且只在这个会话内可见；普通 `claude` 会话不会自动加入 mesh。需要手动接时用 `REMOTE_PI_MCP_CWD` / `REMOTE_PI_MCP_NAME` 直接跑 `dist/mcp/mesh_server.js`。
