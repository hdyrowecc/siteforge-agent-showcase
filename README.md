# CrossWeb AI · AI Coding Agent 工程展示

**真实产品 + 脱敏工程案例。** CrossWeb AI 是对话式 AI 建站产品；本仓库是独立编写的可运行技术示例，展示部分 Agent 与 Node.js 后端设计，**不是商业项目完整源码，也不能代表真实模型的线上任务成功率**。

- **实际产品体验：** https://www.crosswebai.com （可用性以实际部署为准）
- **产品架构与工程取舍：** [docs/product-case-study.md](docs/product-case-study.md)
- **执行循环与工具边界：** [src/agent.mjs](src/agent.mjs) · [src/tools.mjs](src/tools.mjs)
- **运行协调与安全测试：** [src/run-coordinator.mjs](src/run-coordinator.mjs) · [test/](test/)
- **Trace（链路追踪）：** [示例源码](src/trace.mjs) · [真实离线运行](examples/trace-demo.mjs) · [技术说明](docs/trace-and-eval.md)
- **Eval（证据驱动评测）：** [评测引擎](src/evaluation.mjs) · [五个受控案例](examples/eval-suite.mjs) · [自动化测试](test/eval.test.mjs)

## 三个可复现的工程案例

| 案例 | 关注的工程问题 |
| --- | --- |
| **跨文件修改与既有内容保护** | 读取两个页面及共享 CSS，更新标题和样式，再检查两条路由、导航、CTA、页脚及目标修改是否保留 |
| **根据工具错误调整执行** | 观察到 AMBIGUOUS_EDIT 后收窄编辑范围，重新执行验证；不能仅凭模型声称完成 |
| **Node.js 后端请求幂等** | 同一请求 ID 并发时只执行一次，相同 ID 携带不同参数会触发冲突 |

以上均使用合成网页和确定性离线模型适配器，方便招聘者无密钥重复运行。真实 LLM、E2B 执行、数据库项目状态、浏览器审核及 Vercel 发布属于私有产品，**不在示例中伪装实现**。

## Trace 与 Eval：运行分析及可复现评测

精选仓库还包含两项与实际 AI 建站项目相关的工程展示：

- **Trace：** 记录模型、工具和验证阶段的脱敏 Span，分析不重复计算的阶段耗时、失败尝试，并区分已记录与未知的 Token 用量。
- **Eval：** 运行跨页面修改、工具失败修复、请求幂等及两个负例。每项用可检查的证据决定 PASS / FAIL / INCONCLUSIVE，避免将模型的完成声明当作实际完成。

    npm run trace:demo
    npm run trace:synthetic
    npm run eval:demo

详细设计及真实性边界见 [Trace 与 Eval 说明](docs/trace-and-eval.md)。Trace 的虚构示意数据与离线脚本结果均**不是生产任务的性能指标，也不是线上 Agent 成功率**。

## 本地运行

需要 Node.js 20 或更高版本；零运行时依赖。

    npm test
    npm run check
    npm run demo
    npm run demo -- --scenario=repair
    npm run demo -- --scenario=idempotency
    npm run demo:basic

先看 [三个示例的源代码](examples/showcase.mjs) 和 [回归测试](examples/showcase.test.mjs)，再结合 [产品架构说明](docs/product-case-study.md) 了解真实项目的整体范围。

**English:** A sanitized runnable engineering case study accompanying the private CrossWeb AI website-building Agent. It covers multi-page code edits with preservation checks, feedback-driven recovery, and backend request idempotency. No proprietary code, customer data or credentials are included.

**License:** No open-source license is granted by default.
