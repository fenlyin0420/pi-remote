# pi-remote（Pi 插件）

这是 `remote-pi` 插件的**独立仓库**：2026-10-14 从 monorepo fork `fenlyin0420/remote_pi` 的
`pi-remote/` 子目录切出来（`git subtree split`，完整历史保留）。仓库根目录**就是包根**。

## 在 pi 里怎么被加载

```
~/.pi/agent/settings.json → packages: ["git:github.com/fenlyin0420/pi-remote"]
```

pi 的 git 源不支持子目录、也不构建，所以这个仓库必须自带构建产物：

- **`dist/` 要提交**，而且要和 `src/` 同一次提交更新。supervisor/daemon 从自身模块位置上溯
  找 `dist/bin/supervisord.js` 与 `dist/index.js`，并用**裸 node** 起进程 —— 只有 src 的树会让
  daemon 直接断（`.ts` 裸 node 跑不了）。
- 本地改完源码：`npm install && npm run build` → 提交 `src/` + `dist/` → push →
  `pi update --extensions` 才进 pi。
  CI 用 **pnpm**（`pnpm-lock.yaml` 为准，锁文件版本 9）；本机没装 pnpm，`npm install` +
  `npm run build` 等价（npm 会生成 `package-lock.json`，已在 `.gitignore` 里，别提交）。
- CI 有三道门（`.github/workflows/ci.yml`）：`pnpm test`+`typecheck`、**`pnpm build` 后
  `git diff --exit-code -- dist`**（dist 必须与 src 同步）、协议漂移与 fixtures 清单对端比对。

## daemon / supervisor

- 本机跑的是 system 级 systemd 单元 `/etc/systemd/system/remote-pi-supervisord.service`，
  ExecStart 指 `~/.pi/agent/git/github.com/fenlyin0420/pi-remote/dist/bin/supervisord.js`
  （克隆路径稳定，`pi update --extensions` 不会挪它）。
- **settings 的来源路径与 supervisor 的 `-e` 路径必须是同一个文件**：一本地一克隆就是两份扩展，
  会以 `Tool "agent_send" conflicts with …` 结束，pi 退出码 1、daemon 会话起不来。
  换源时两步要背靠背（healthcheck 每 5 分钟会重启非 running 的 daemon，不一致状态自己会掉线）。
- 重启：`sudo systemctl restart remote-pi-supervisord`（`remote-pi restart-supervisor`
  在本机走 user unit，是错的）。

## 版本

`package.json` 的版本走独立线（当前 0.15.x）；它和 app 的 `v1.5.x` release tag 是两套，别混。
tag 用 `vX.Y.Z` 发本仓自己的 release（可选：附 `npm pack` 的 tgz）。

## 协议

`PROTOCOL.md` 在本仓是**权威**（wire 契约的唯一来源）；app 仓 `pi-remote-app` 镜像同一份。
改动 wire 时两个仓一起改，并跑：

```bash
node scripts/check-protocol-drift.mjs \
  --ts src/protocol/types.ts --dart <app 仓>/lib/protocol/protocol.dart \
  --fixtures .orchestration/contracts/fixtures
```

- 字段名（TS 声明 → Dart 能找到）与判别值（TS `type: "x"` → Dart 能找到）不一致就失败；
  确认有意的写进 `scripts/protocol-drift-allow.txt`。
- `.orchestration/contracts/fixtures/` 的 31 个 wire 金样本两个仓各存一份，
  `scripts/protocol-fixtures.sha256` 是清单：改了 fixtures 就重跑 `--write-manifest`；
  CI 会拉对端清单比对（两边必须同源）。drift 脚本里的相对路径是 `../../.orchestration/...`
  （仓库根相对于 `src/protocol/`）。

## 手机端 / daemon

本机 pi 从 `~/.pi/agent/git/github.com/fenlyin0420/pi-remote`（本仓克隆）加载本插件，
5 个 daemon（Jarvis / pi-remote / Roleplay / pi / fenlyin）跑在 `remote-pi-supervisord` 下，
手机端配置在 `~/.pi/remote/`。**改了本仓代码要让手机端吃到，除了 `pi update --extensions`
还要 `sudo systemctl restart remote-pi-supervisord`**（supervisor 启动时就把扩展路径烧进内存）。

## 与上游的关系

2026-10-14 起**不再跟随上游** `jacobaraujo7/remote_pi`（该上游近 200 个提交已不再触碰本目录）。
旧的 monorepo fork 归档在 `fenlyin0420/remote_pi`（保留 tags/releases 与 PR #199），只作历史与
旧 APK 的 release feed 用。
