# CrossWeb AI · AI Coding Agent 工程展示

[![Offline CI](https://github.com/hdyrowecc/siteforge-agent-showcase/actions/workflows/ci.yml/badge.svg)](https://github.com/hdyrowecc/siteforge-agent-showcase/actions/workflows/ci.yml)

**一个实际运行的对话式 AI 建站产品 + 可复现的脱敏 Agent 工程案例。** 用户可以在 [CrossWeb AI](https://www.crosswebai.com/) 通过对话新建网站，并在已有项目中继续修改。此仓库展示其中的 Node.js Agent 设计、工具安全边界、执行恢复、Trace 与 Eval；示例源码为独立编写，并非私有商业产品的完整代码。

**[体验真实产品 →](https://www.crosswebai.com/)** · **[产品架构和工程取舍 →](docs/product-case-study.md)** · **[Trace / Eval 结果报告 →](docs/evidence-report.md)**
- **执行循环与工具边界：** [src/agent.mjs](src/agent.mjs) · [src/tools.mjs](src/tools.mjs)
- **运行协调与安全测试：** [src/run-coordinator.mjs](src/run-coordinator.mjs) · [test/](test/)
- **Trace（链路追踪）：** [示例源码](src/trace.mjs) · [真实离线运行](examples/trace-demo.mjs) · [技术说明](docs/trace-and-eval.md)
- **Eval（证据驱动评测）：** [评测引擎](src/evaluation.mjs) · [五个受控案例](examples/eval-suite.mjs) · [自动化测试](test/eval.test.mjs)

## 招聘者 5 分钟浏览路线

1. **看实际产品：** 打开 [CrossWeb AI](https://www.crosswebai.com/)，用自然语言创建网站，并尝试在同一项目上追加修改。无需安装本仓库；网站当前可用性、注册和用量以实际页面为准。
2. **看架构设计：** 阅读 [产品案例](docs/product-case-study.md)，重点了解多轮修改、用户目标验收、运行状态及成本控制问题；商业实现不在此仓库。
3. **看关键代码：** [Agent Loop](src/agent.mjs) 使用调用方提供的目标检查契约，防止只检查最后一个页面就误报完成；[工具边界](src/tools.mjs) 限制操作范围；[回归测试](test/goal-verification.test.mjs) 提供反例。
4. **看可复现证据：** 先看 [Trace / Eval 结果快照](docs/evidence-report.md) 和 [最新 CI 记录](https://github.com/hdyrowecc/siteforge-agent-showcase/actions/workflows/ci.yml)，也可以在 Node.js 20+ 环境执行以下命令，无需 API Key、数据库或 E2B：

       npm test
       npm run demo
       npm run trace:demo
       npm run eval:demo

想快速验证产品旅程时，可用自拟的测试需求先生成一个小网站，再在**同一项目**内要求局部修改，观察原有导航和未指定部分是否保留。这是供招聘者亲自尝试的建议操作，**不是对每次线上任务结果的保证**。

## 三个可复现的工程案例

| 案例 | 关注的工程问题 |
| --- | --- |
| **跨文件修改与既有内容保护** | 读取两个页面及共享 CSS，更新标题和样式，再检查两条路由、导航、CTA、页脚及目标修改是否保留 |
| **根据工具错误调整执行** | 观察到 AMBIGUOUS_EDIT 后收窄编辑范围，重新执行验证；不能仅凭模型声称完成 |
| **Node.js 后端请求幂等** | 同一请求 ID 并发时只执行一次，相同 ID 携带不同参数会触发冲突 |

上述三个源码案例都使用合成网页和确定性离线模型适配器，便于招聘者无密钥重复运行。**真实产品可直接通过上方网站体验；公开代码不冒充实际模型的线上执行过程。** 真实 LLM、E2B 执行、数据库任务状态、浏览器审核及 Vercel 发布的商业实现未公开。

## Trace 与 Eval：运行分析及可复现评测

精选仓库还包含两项与实际 AI 建站项目相关的工程展示：

- **Trace：** 记录模型、工具和验证阶段的脱敏 Span，分析不重复计算的阶段耗时、失败尝试，并区分已记录与未知的 Token 用量。
- **Eval：** 运行跨页面修改、工具失败修复、请求幂等及两个负例。每项用可检查的证据决定 PASS / FAIL / INCONCLUSIVE，避免将模型的完成声明当作实际完成。

    npm run trace:demo
    npm run trace:synthetic
    npm run eval:demo

[直接查看可阅读的耗时拆解与 Eval 结果表](docs/evidence-report.md) · [理解设计及真实性边界](docs/trace-and-eval.md)。最新 GitHub Actions 会上传可下载的离线 JSON 报告。Trace 的虚构示意数据与离线脚本结果均**不是生产任务的性能指标，也不是线上 Agent 成功率**。

## 本地 API：清楚区分演示通过与用户目标达成

运行 `npm start`，本地 API 默认只监听 `127.0.0.1:3001`。调用 `POST /agent/run` 时，普通离线模式会执行**固定的合成 HTML 修改脚本**：即使提交了不同的自然语言描述，返回的 `demo_verified` 也仅表示固定演示通过，**不表示该输入的目标已实现**。

可选的 `AGENT_MODE=live` 模式需要单独配置模型密钥，并要求调用方提交明确的 `requiredChecks`（本仓库单页示例只支持 `index.html` 的 H1 检查），例如：

`{"instruction":"把首页主标题改为 My Portfolio","requiredChecks":[{"path":"index.html","expectedText":"My Portfolio"}]}`

只有声明的检查全部通过，接口才会返回 `contract_verified`；它验证的是**调用方声明的 HTML 检查范围**，不是完整网站质量、视觉效果或任意自然语言需求。没有检查契约的 live 请求会被拒绝。

单进程请求协调器会限制所有执行中的请求，包括没有客户端请求 ID 的请求；达到上限时返回 `503 RUN_CAPACITY_EXCEEDED` 和 `Retry-After`。这不是生产级多实例任务队列。底层 `runAgent` 如果没有外部目标契约，只能返回 `self_checked`，不能宣称用户目标达成。HTTP 截止时间到达时，等待不配合取消的模型或工具 Promise 也会结束，并返回 `504 timed_out`；已经启动的工具操作仍可能在后台继续，因此不会将超时当作副作用已终止的证明。Trace 的 `partial` / `truncated` 标记则防止把未记录或被丢弃的 Token 当成完整用量。

## 本地运行

需要 Node.js 20 或更高版本；零运行时依赖。

    npm test
    npm run test:coverage
    npm run check
    npm run demo
    npm run demo -- --scenario=repair
    npm run demo -- --scenario=idempotency
    npm run demo:basic

先看 [三个示例的源代码](examples/showcase.mjs) 和 [回归测试](examples/showcase.test.mjs)，再结合 [产品架构说明](docs/product-case-study.md) 了解真实项目的整体范围。

**English:** A sanitized runnable engineering case study accompanying the private CrossWeb AI website-building Agent. It covers multi-page code edits with preservation checks, feedback-driven recovery, and backend request idempotency. No proprietary code, customer data or credentials are included.

**License:** No open-source license is granted by default.
