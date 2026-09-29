# 可复现结果 | Trace & Eval Evidence

[返回 README](../README.md) · [技术设计](trace-and-eval.md) · [GitHub Actions 运行与报告](https://github.com/hdyrowecc/siteforge-agent-showcase/actions/workflows/ci.yml)

这页提供一条简短的**证据核验路径**：本仓库自动化测试真正执行了什么、观察到了什么，以及哪些数据仅供解释概念。它不是私有 CrossWeb AI 产品的线上性能报告。

## 结果从哪里来？

[CI 工作流](../.github/workflows/ci.yml) 每次提交自动执行：

    npm test
    npm run check
    npm run trace:demo
    npm run trace:synthetic
    npm run eval:demo

随后使用同样的 Node.js 示例生成三个 JSON 报告，校验数据来源标签和受控 Eval 结果，并以 **sanitized-offline-evidence** 作为 GitHub Actions Artifacts 上传。可在最近的 [Actions 运行记录](https://github.com/hdyrowecc/siteforge-agent-showcase/actions/workflows/ci.yml)中进入成功的运行页面，在 Artifacts 下载报告（默认保留 30 天）。

无需密钥、收费模型、E2B、Neon、真实用户项目或外部网站。任何人也可在 Node.js 20+ 环境本地重现报告。

## 1. Trace：离线任务中的实际执行证据

命令：

    node examples/trace-demo.mjs

此命令真正执行仓库中的独立 Agent：读取合成 HTML，修改标题，检查结果，并记录脱敏 Span。自动化测试要求报告满足以下条件：

| 项目 | 预期及核实方式 |
| --- | --- |
| 执行结论 | 最新修改得到充分检查证据，状态 verified |
| 模型适配器 | 确定性离线适配器；4 次决策 |
| 工具调用 | 读取、精准修改、HTML 校验，共 3 次 |
| 补充结果检查 | 1 次合成文件内容核验 |
| Token 用量 | null：离线适配器未提供数据，不能假称零 Token |
| 时间 | 取本次运行的实际耗时，不用固定数值冒充线上指标 |

[源代码](../examples/trace-demo.mjs) · [回归测试](../test/trace.test.mjs)

## 2. Trace：完全虚构的超时及重试示例

以下数值由合成事件构成，用于解释非重叠耗时归因，**不是实际 CrossWeb AI 或付费模型测量**。运行：

    node examples/trace-demo.mjs --synthetic

| 阶段 | 去重叠耗时 |
| --- | ---: |
| 工作区 | 150 ms |
| 模型（含一次虚构失败尝试） | 1,190 ms |
| 工具 | 240 ms |
| 验证 | 160 ms |
| 其他 / 空闲 | 60 ms |
| **总耗时** | **1,800 ms** |

模型工具 Span 会重叠，因而不能直接把原始 Span 耗时加总。此示例优先归属验证阶段，工具和验证重叠的 40 ms 不会重复计入。虚构的两次模型尝试含一次失败；示意 Token 为输入 1,640、输出 120，总计 1,760。这些数字只验证分析方法，**不代表线上速度、成本或可靠性**。

## 3. Eval：受控证据与负例

运行：

    node examples/eval-suite.mjs

| 受控场景 | 期望 | 实际判定应为 | 为什么 |
| --- | --- | --- | --- |
| 两个页面及 CSS 修改，同时保护导航/CTA | PASS | PASS | 目标修改与保留条件均有证据 |
| 工具遇到歧义后改用精准修改 | PASS | PASS | 观察到错误、修复且重新验证 |
| 重复请求幂等 | PASS | PASS | 只执行一次，冲突请求被拒绝 |
| **故意删除 CTA** | FAIL | FAIL | 检查器正确发现损坏，属于负例的预期结果 |
| **模型只说完成而没有修改证据** | INCONCLUSIVE | INCONCLUSIVE | 不允许纯文本声称完成 |

五个场景全部符合各自的预期，表明这组受控案例的检查器正常工作。**不可以将“5/5 符合预期”写成真实 AI Agent 的 100% 任务成功率**。

[Eval 执行器](../src/evaluation.mjs) · [场景及证据](../examples/eval-suite.mjs) · [评测回归测试](../test/eval.test.mjs)

## 私有商业实现的边界

实际产品中涉及更广的 Trace、Token/耗时归因、不同网站类型和多轮任务评测，但本仓库不包含客户运行轨迹、真实项目代码、生产凭证、商业提示词、生产数据库和付费模型评测记录。真实产品体验请前往 [CrossWeb AI](https://www.crosswebai.com/)。
