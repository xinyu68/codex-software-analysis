# 网站分析

创建 URL 项目后，`analysis_check_environment(profile="web")` 检查 REA 浏览器工具和 Chrome/Edge。用户已要求实际分析时，用 `analysis_capture_website` 采集，默认观察 10 秒，总时限 90 秒；按问题调整窗口，不建立持续取数任务。

采集用独立临时浏览器，不复用个人浏览器账号。先从本地空白页启动，再使用有时限的 domcontentloaded 导航，避免资源一直未完成时无限等待 load。采集包含 HTTP、WebSocket、最终页面文本和已接收脚本；原始内容保存在项目 artifacts/ 的私有文件，工作台返回不含载荷值的网络摘要。

用返回的 networkEvidenceId/pageEvidenceId 分页读取材料。关注实际 HTTP 状态、请求参数名、响应结构、WebSocket 帧，以及采集完整性。WebSocket 仅有 ping/pong 时不能称作取得业务行情。普通 HTTP 请求、浏览器成功显示、独立接口调用成功分别记录。

`verification_page_observed` 表示观察到验证页，采集状态为 partial；不是网络故障，也不是业务成功。网页中提到验证码的文本可能需要人工核对。保留当前证据，按用户意图决定是否继续正常浏览器核对；工作台没有验证码绕过、凭据迁移或自动接口回放。

返回超过 REA MCP stdio 预算时，采集器只在明确的 transport resource_constraint 错误上导出本会话 retained evidence；导出成功但没有 capture 记录仍判为失败。其他错误不能伪装为成功。原始浏览器 bundle 最大读取 128 MiB，超过时缩短窗口或使用原生工具的更细范围。

采集后直接对同一 URL 项目调用 `analysis_run_static(profile="javascript")`，分析其导出脚本。它通过 MCP 返回摘要并导出完整会话文件，避免巨大的语义图堵塞 stdio。检查 coverage 与 limitations；语义图可能不完整。需要查某段代码时使用脚本与摘要指向的证据，不要求全站所有代码都恢复。

完成后登记有材料支持的结论并生成报告。64 MiB 内的其他文本可直接导入，`analysis_read_evidence` 保留分页和全文件摘要校验，不把大文本整体返回给模型。
