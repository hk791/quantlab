#!/usr/bin/env bash
# One-command deployment from your own machine (no AI session needed).
#
#   ./deploy/deploy.sh            push code, rebuild, restart (server config is NOT touched)
#   ./deploy/deploy.sh pull       download the server's arena.config.json to backend/arena.config.json
#   ./deploy/deploy.sh config     OVERWRITE the server config with your local one, restart (asks first)
#   ./deploy/deploy.sh secrets    copy *_API_KEY lines from backend/.env into the server's deploy/.env
#   ./deploy/deploy.sh ping       test every enabled model once on the server (no orders)
#   ./deploy/deploy.sh status     container status + recent decisions in the log
#   ./deploy/deploy.sh logs       follow the server log (Ctrl+C to quit)
#   ./deploy/deploy.sh backup     download the server database to deploy/backups/
#
# Set ARENA_HOST=user@your-server; optionally set ARENA_REMOTE_DIR.
# Requires key-based SSH (run `ssh-copy-id user@your-server` once).
# Source of truth: the config ON THE SERVER (the dashboard edits it). Run `pull`
# before hand-editing locally, then `config` to push it back.
set -euo pipefail

HOST="${ARENA_HOST:?请设置 ARENA_HOST，例如 user@your-server}"
RDIR="${ARENA_REMOTE_DIR:-quantlab}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CMD="${1:-all}"
SSH_OPTS=(-o ConnectTimeout=15 -o ServerAliveInterval=30)

remote() { ssh "${SSH_OPTS[@]}" "$HOST" "cd ~/$RDIR/deploy && $*"; }

check_config() {
  local f="$ROOT/backend/arena.config.json"
  [[ -f "$f" ]] || { echo "找不到 $f"; exit 1; }
  node -e "JSON.parse(require('fs').readFileSync(process.argv[1],'utf8'))" "$f" \
    || { echo "arena.config.json 不是合法 JSON，已中止"; exit 1; }
}

push_config() {
  check_config
  remote "mkdir -p config data"
  scp -q "${SSH_OPTS[@]}" "$ROOT/backend/arena.config.json" "$HOST:~/$RDIR/deploy/config/arena.config.json"
  echo "✓ 配置已上传"
}

push_code() {
  echo ">> 打包代码"
  local tgz; tgz="$(mktemp -t arena-src.XXXXXX).tgz"
  COPYFILE_DISABLE=1 tar -C "$ROOT" -czf "$tgz" \
    --exclude='node_modules' --exclude='dist' --exclude='.git' --exclude='*.db' --exclude='*.db-*' \
    --exclude='.env' --exclude='backend/arena.config.json' --exclude='deploy/data' --exclude='deploy/config' \
    --exclude='deploy/backups' --exclude='.DS_Store' --exclude='backend/static' .
  echo ">> 上传到 $HOST"
  ssh "${SSH_OPTS[@]}" "$HOST" "mkdir -p ~/$RDIR"
  scp -q "${SSH_OPTS[@]}" "$tgz" "$HOST:/tmp/arena-src.tgz"
  ssh "${SSH_OPTS[@]}" "$HOST" "tar -xzf /tmp/arena-src.tgz -C ~/$RDIR && rm /tmp/arena-src.tgz"
  rm -f "$tgz"
}

require_env() {
  remote "test -f .env" || { echo "服务器上缺少 deploy/.env，请先运行：./deploy/deploy.sh secrets，再登录服务器设置 ARENA_PASSWORD"; exit 1; }
}

case "$CMD" in
  all)
    push_code
    remote "test -f config/arena.config.json" || push_config   # first deploy only
    require_env
    echo ">> 构建并重启（首次约 3 分钟，之后约 1 分钟）"
    remote "sudo docker compose up -d --build 2>&1 | tail -5 && sudo docker image prune -f >/dev/null && sudo docker compose ps"
    echo ">> 检查 HTTPS 入口"
    sleep 8
    if curl -fsS --max-time 15 "https://${ARENA_DOMAIN:-quant.example.com}/api/health" >/dev/null; then
      echo "✓ 完成。看板：https://${ARENA_DOMAIN:-quant.example.com}/"
    else
      echo "⚠ https://${ARENA_DOMAIN:-quant.example.com}/ 访问失败。容器端口现在只监听 127.0.0.1，"
      echo "  请确认服务器上 Caddy 反代到 127.0.0.1:5611（见 deploy/Caddyfile.example），或在 deploy/.env 里设 ARENA_BIND=0.0.0.0 临时恢复。"
    fi
    ;;
  pull)
    scp -q "${SSH_OPTS[@]}" "$HOST:~/$RDIR/deploy/config/arena.config.json" "$ROOT/backend/arena.config.json"
    echo "✓ 已把服务器配置下载到 backend/arena.config.json"
    ;;
  config)
    tmp="$(mktemp)"
    scp -q "${SSH_OPTS[@]}" "$HOST:~/$RDIR/deploy/config/arena.config.json" "$tmp" 2>/dev/null || true
    if [[ -s "$tmp" ]] && ! diff -q "$tmp" "$ROOT/backend/arena.config.json" >/dev/null; then
      echo "服务器配置和本地不同（可能在看板上改过）。差异："
      diff -u "$tmp" "$ROOT/backend/arena.config.json" | head -60 || true
      read -r -p "用本地配置覆盖服务器？[y/N] " ans
      [[ "$ans" == "y" || "$ans" == "Y" ]] || { rm -f "$tmp"; echo "已取消。可先运行 ./deploy/deploy.sh pull"; exit 1; }
    fi
    rm -f "$tmp"
    push_config
    remote "sudo docker compose restart && sudo docker compose ps"
    ;;
  secrets)
    f="$ROOT/backend/.env"
    [[ -f "$f" ]] || { echo "找不到 $f"; exit 1; }
    keys="$(grep -E '^[A-Z0-9_]+_API_KEY=.+' "$f" || true)"
    [[ -n "$keys" ]] || { echo "backend/.env 里没有填写任何 *_API_KEY"; exit 1; }
    # Merge: replace/add API key lines, keep everything else (ARENA_PASSWORD etc.) on the server.
    printf '%s\n' "$keys" | ssh "${SSH_OPTS[@]}" "$HOST" "mkdir -p ~/$RDIR/deploy && cd ~/$RDIR/deploy && touch .env && chmod 600 .env && \
      python3 -c '
import sys
new = dict(l.split(\"=\", 1) for l in sys.stdin.read().splitlines() if \"=\" in l)
lines = open(\".env\").read().splitlines()
out = []
for l in lines:
    k = l.split(\"=\", 1)[0]
    if k in new: out.append(k + \"=\" + new.pop(k))
    else: out.append(l)
out += [k + \"=\" + v for k, v in new.items()]
open(\".env\", \"w\").write(\"\\n\".join(out) + \"\\n\")
'"
    echo "✓ 已同步 Key：$(printf '%s\n' "$keys" | cut -d= -f1 | tr '\n' ' ')"
    echo "  运行 ./deploy/deploy.sh config 重启后生效"
    ;;
  ping)
    remote "sudo docker compose run --rm --no-deps -T arena node dist/arena/ping.js ${2:-}"
    ;;
  status)
    remote "sudo docker compose ps; echo; sudo docker compose logs --since 2h 2>&1 | grep -E 'actions ->|failed|ERROR|halt' | tail -30"
    ;;
  logs)
    remote "sudo docker compose logs -f --tail 50 | grep --line-buffered -v DEBUG"
    ;;
  backup)
    mkdir -p "$ROOT/deploy/backups"
    out="$ROOT/deploy/backups/data-$(date +%Y%m%d-%H%M).db"
    remote "sudo docker compose exec -T arena node -e \"new (require('better-sqlite3'))('/app/data/data.db').backup('/app/data/backup.db').then(()=>console.log('ok'))\""
    scp -q "${SSH_OPTS[@]}" "$HOST:~/$RDIR/deploy/data/backup.db" "$out"
    remote "rm -f data/backup.db"
    echo "✓ 已备份到 $out"
    ;;
  *)
    sed -n '2,14p' "$0"; exit 1 ;;
esac
