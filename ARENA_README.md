# Quantlab 使用手册

项目介绍和截图见 [README](README.md)。本手册说明运行、配置和实验口径；所有成交均为模拟成交，不包含实盘执行功能。

## 启动和数据

推荐 Node.js 22+、pnpm 8。根目录执行 `pnpm install --frozen-lockfile`，复制 `backend/.env.example` 和 `backend/arena.config.example.json` 为同目录下的 `.env`、`arena.config.json`，执行 `pnpm dev:backend`。看板在 `http://localhost:5611/`，`/dashboard` 等价，旧入口 `/arena` 会跳转。

默认模板启用 Mock 与三个规则对照，不调用付费模型。Mock 仅验证流程。启用真实模型前填写密钥变量、接口地址和有效模型 ID。不要直接把演示账户成绩当作模型成绩。

| 环境变量 | 用途 |
| --- | --- |
| `ARENA_CONFIG` | 配置路径；默认 `backend/arena.config.json` |
| `DATABASE_PATH` | SQLite 路径；本地默认 `backend/data.db` |
| `PORT` | 默认 5611 |
| `ARENA_USER` | 管理员用户名，默认 admin |
| `ARENA_PASSWORD` | 管理密码；未设置时仅允许直接本机连接进行管理 |
| `LOG_LEVEL` | 日志级别 |
| `MODEL_API_KEY` 等 | 模型配置引用的密钥环境变量 |

看板与列入白名单的只读接口公开；模型配置、启停、测试和手动轮次等操作需要管理权限。浏览器支持管理员登录，脚本支持 Basic Auth。公开部署应设置管理员密码并使用 HTTPS。数据库、配置和 `.env` 不提交到 Git。

无竞技场配置或 `enabled: false` 时，会恢复上游旧模式；Docker 镜像没有构建旧 React 前端。正常使用 Quantlab 请保持配置文件存在且启用。

## 模型配置与账户

每个模型包含唯一 `name`、服务商 `model`、`baseUrl`、`apiKeyEnv`、策略版本、启用状态，以及可选的 `temperature`、`maxTokens`、`timeoutSeconds`、`extraBody`。接口使用 OpenAI 兼容 `/chat/completions` 格式。`extraBody` 不得覆盖 `model` 和 `messages`。

账户按名字识别。改名字会生成新账户；停用会按模拟市价平掉该账户持仓，原因记录为 `disabled`，历史保留。不要在已有账户上修改策略版本：通过复制功能创建新账户。看板编辑写回配置文件并热生效；环境变量变化需要重启服务。

每轮共用行情快照，启用模型并行请求。每个模型的持仓、记忆及版本规则不同，因此输入上下文并不完全相同。比较模型能力时应对齐策略、窗口和预算。

`pnpm --filter ./backend arena:ping` 会调用所有启用模型，使用真实行情、产生模型费用，不交易也不写交易数据库。不要在日常检查健康状态时重复调用它。

## 策略与对照

- **V1**：原始自由决策，模型提出方向、保证金比例与杠杆，代码风控审核。
- **V2**：加入工作记忆、成本说明、24h 统计、同币冷却与 ATR 止损下限。
- **V3**：按整点对齐的小时级决策；系统按约 1% 权益止损风险（含开平成本）计算仓位，连续亏损止损锁定同币同方向。参数在 `strategyV3`。
- **V3.1**：保留 V3 定仓与节奏；开仓记录固定 `exit_rule`，入场后新的已收盘 4h K 线触发规则才允许模型主动平仓。止损、强平、超时和回撤退出不受限制，仍允许调整止损止盈。
- **ema-filter-v1 / EF1**：已收盘 1h EMA20/50 决定 BTC 方向；首次有效方向或方向变化产生入场候选。规则先退出反向持仓，AI 只允许或拒绝入场，不能更改方向和仓位。请求 25% 权益、1 倍杠杆、2×1h ATR 初始止损，经统一硬风控审核。拒绝或故障后等待下次方向变化，不同向反复调用。候选状态与事件持久化。

三个免费规则对照分别为 `buy_hold_btc`、`ema_cross_btc`、`ema_rules_v1`。最后一个使用 EF1 相同规则、不经过 AI 入场过滤；它与原 EMA 对照不同，评估 EF1 应优先比较这个配对对照。配置中可以选择需要的对照。

研究标的固定为 BTC / ETH / SOL / HYPE / XRP / ZEC；如果做自己的实验，改变币种或规则后应单独记录，避免混合前后数据。

## 运行节奏与风控

默认引擎每 15 分钟拉取一次行情并决策；V3/V3.1 只在其小时级到期轮次调用模型。监控每 30 秒检查止损、止盈、近似强平和最长持仓时间；净值每 5 分钟记录。资金费率按小时计提。

默认模板：杠杆上限 5 倍、单仓保证金上限 25%、总保证金上限 80%、最多 5 仓；止损距离 0.3%–10%，缺失或无效止损由风控处理；最长持仓 48 小时。从净值高点回撤 25% 禁止新仓，40% 强制平仓并停止该账户。新版本另有 ATR 或退出确认限制，最终仍经过统一风控。

观察提示中的 10% 回撤预警、15% 风险停用线及满 7 天/50 笔后的表现条件，仅提示人工评估，不自动停用，不替代上述硬回撤规则。

模拟账本扣开平手续费、滑点与资金费。固定滑点不代表真实交易所成交质量，目标止损风险也不是最大损失保证。

## 看板与评估口径

总览提供相对 BTC 的收益跑道、资金汇总、净值曲线、组合风险、成本、观察提示、统计门槛、EF1 配对比较与交易复盘。其他页展示持仓与成交、分页决策日志、模型管理。

历史排行榜包含有记录的停用账户，停用时长及 BTC 比较截至停止观察时点；曲线补入行政退出后的最终现金点。顶部资金和门槛只统计启用账户。不同起止时间的累计排名不能当作公平能力排名。

交易成本含未平仓费用；滑点估算仅展示，不能重复扣净值。模型费用单列，不计入交易净值。`reporting.modelBilling` 可填写订阅月费或按百万 token 的输入/输出单价；不知道实付时留空，不把参考档位当账单。

```json
{
  "reporting": {
    "modelBilling": [
      { "apiKeyEnv": "MODEL_API_KEY", "mode": "subscription", "currency": "CNY", "monthlyFee": 99 }
    ]
  }
}
```

上例只是配置格式，99 不是你的实际费用。订阅以 30 天为参考周期分摊；按量计费依赖接口返回的完整 token 用量。夏普满 7 天才计算；统计门槛全部通过也不等于证明可盈利。

## Docker 与远程部署

先准备 `deploy/.env`、`deploy/config/arena.config.json`，在 `deploy/` 执行 `docker compose up -d --build`。默认端口只监听本机，通过 [Caddy 模板](deploy/Caddyfile.example) 配置自己的域名和 HTTPS。数据库持久化到 `deploy/data/`。

远程脚本需 SSH 密钥与目标服务器 Docker/Compose，首次运行先在服务器准备 `deploy/.env`：

```bash
export ARENA_HOST=user@your-server
export ARENA_REMOTE_DIR=quantlab
export ARENA_DOMAIN=quant.example.com
./deploy/deploy.sh           # 上传代码、构建、重启；已有服务器配置不覆盖
./deploy/deploy.sh pull      # 下载服务器配置到本地
./deploy/deploy.sh config    # 对比后推送本地配置
./deploy/deploy.sh status
./deploy/deploy.sh backup
```

服务器配置是运行时的准确信息，在看板修改后先 `pull` 再手改本地。`secrets` 子命令合并 API Key 到服务器 `.env`；完成后重启服务。已有部署目录为 `open-alpha-arena` 的用户必须设置 `ARENA_REMOTE_DIR=open-alpha-arena`，避免部署到新目录。

## 开发验证

运行 `pnpm typecheck`、`pnpm --filter ./backend test:arena`、`pnpm test` 与 `pnpm build:backend`。测试使用内存数据库与本地夹具，不调用付费模型。新增策略用独立版本，风控、账本、指标和解析变更应有对应测试。

主要只读 API 前缀为 `/api/arena/`：`leaderboard`、`curves`、`positions`、`trades`、`decisions`、`outcomes`、`market`。成交支持 `page/size/account_id`，决策使用 `before_id` 游标，曲线支持 `points` 抽稀。访问 `/api/health` 检查服务存活。
