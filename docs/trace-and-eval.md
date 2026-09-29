# Trace + Eval 工程展示｜Observability & Evaluation

[返回 README](../README.md) · [真实产品架构范围](product-case-study.md) · [可复现结果与 CI 报告](evidence-report.md)

> **公开范围：** Trace / Eval 均为独立编写、使用合成数据的可运行示例，用于展示工程设计思路；不是商业源码、客户运行记录、线上效果报告，也不能代替真实模型或浏览器评测。

## 1. Trace：定位耗时、重试和失败

实际 AI 建站系统需要区分耗时发生在模型生成、工具执行、页面验证还是保存阶段。真实产品的相关模块包含分阶段事件和耗时分析、失败尝试分类、Token 归因与敏感字段过滤。

公开示例只保留最必要的部分：

- [src/trace.mjs](../src/trace.mjs) 把模型调用、工具执行、验证记录为 Span（开始时间、耗时、结果、有限的错误码）。
- safeAttributes 采用字段白名单，不保存用户输入、提示词、工具参数、代码、邮箱、密钥或原始异常消息；Span 数量有上限。
- analyzeTrace 使用互不重叠的阶段耗时，避免嵌套 Span 导致总耗时被重复相加。
- 失败工具调用、失败模型尝试单独统计。离线模型没有 Token 使用数据时显示 null（未知），而不是虚报 0。
- 此示例没有生产数据库、用户身份信息、原始运行记录或分布式 Trace 后端。

运行真实离线执行过程的 Trace（耗时来自本机，不代表线上延迟）：

    npm run trace:demo

展示失败尝试、Token 记录和分阶段耗时的**完全虚构示意数据**：

    npm run trace:synthetic

真实产品还包含 Sandbox、浏览器、Reviewer、持久化等其他阶段；公开示例只运行合成的 HTML 文件及本仓库 Agent。

## 2. Eval：用证据判断目标是否完成

Eval 不应只检查模型是否说“完成”，也不能把自动化测试通过率当作真实用户任务完成率。公开示例提供确定性场景、正例、失败检测及证据不足案例：

| 受控场景 | 期望观察 | 核实证据 |
| --- | --- | --- |
| 跨页面修改与既有内容保护 | PASS | 目标标题、两个页面、共享导航、CTA、样式保持正常 |
| 工具错误后缩小修改范围 | PASS | 先观察 AMBIGUOUS_EDIT，再精准修改、复检 |
| 重复请求控制 | PASS | 相同请求只执行一次，不同内容的重复 ID 被拒绝 |
| 负例：意外删除 CTA | FAIL（成功识别问题） | 检查器必须发现 CTA 缺失 |
| 负例：模型声称完成但无执行证据 | INCONCLUSIVE（证据不足） | 纯文本回答不算已完成 |

**五个场景全部符合预期**仅表示受控脚本及检查器通过；其中两个负例必须分别给出 FAIL 与 INCONCLUSIVE，不能当作产品失败率或线上成功率样本。

- [src/evaluation.mjs](../src/evaluation.mjs)：通用离线评测执行器；逐项证据可以是 true、false 或 null（未知），生成 PASS / FAIL / INCONCLUSIVE。
- [examples/eval-suite.mjs](../examples/eval-suite.mjs)：五个合成场景与预期结果，产生可审阅报告。
- [test/eval.test.mjs](../test/eval.test.mjs)：校验正例、负例及运行错误处理。

    npm run eval:demo
    npm test

默认自动化测试与 GitHub Actions 不调用付费模型、E2B、生产数据库或真实用户网站，无需任何 API Key。

## 3. 实际产品与公开示例的边界

真实 CrossWeb AI 项目还包括 OpenAI Agents SDK、Neon PostgreSQL、E2B 执行、网站预览、结果审核和版本管理。私有项目中已有更广的运行追踪、耗时及 Token 分析，以及覆盖不同网站类型、多轮开发任务的 Eval 场景和基于历史失败类型的回归测试。

离线示例可验证工具边界、保留检查和证据处理的具体行为，但**不能**证明当前模型的线上任务成功率、主观页面美感、全链路任务耗时，也不能声称完整重放了无法恢复的历史用户任务。

**设计原则：** 模型负责理解与提出行动；运行时负责安全、预算与状态；评测根据可核实的证据判断用户目标是否满足。
