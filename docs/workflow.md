# 项目与证据工作流

## 分析路线

`analysis_create_project` 返回 projectId、初步目标类型、绝对目录和文件摘要。后续所有工作台工具使用该 projectId，不接受自由拼接的输出路径。

本地软件使用 targetPath；网站使用 targetUrl，两者只能选一个。创建网站项目不会联网；URL 不接受账号或 token。实际分析前按路线调用 `analysis_check_environment`，并按需准备缺失依赖。

`analysis_run_static` 的 profile 与真实 REA 命令对应：

| profile | 命令 |
| --- | --- |
| artifact | inspect-artifact |
| android | inspect-android-package |
| javascript | analyze-javascript-application |
| managed | inspect-managed-artifact |
| har | inspect-web-network-capture `<path>` har |

超时范围 5—300 秒，默认 90 秒。CLI stdout/stderr 总量最多 8 MiB。超时、取消、输出超限、非零退出、不可解析 JSON 或 provider 错误不会登记为成功运行。结果保留为证据，后续用 evidenceId 分页读取。

深入类、方法、汇编、引用等分析使用第二个 MCP 服务 `rea_analysis`。它透明启动本机已有 REA 的 `--mcp` 模式，不重写 REA schema、不启动软件目标、不注册全局配置。

## 网站路线

URL 项目调用 `analysis_capture_website`，默认观察 10 秒、总时限 90 秒。它在独立临时浏览器中采集，保存 HTTP/WebSocket 摘要和页面文本，导出已接收脚本。读取返回的证据 ID 后，对同一项目调用 javascript 静态 profile 即可分析导出脚本；此路径通过 MCP 保存摘要与完整私有会话文件，避免巨大的静态结果整体返回。

仅明确的 REA transport resource_constraint 会触发完整浏览器证据导出恢复，其他错误不会被判为成功。验证页记录为 partial；WebSocket 心跳不等于业务数据。原始浏览器 bundle 最大读取 128 MiB，超过时缩短窗口。原始文件保存在 artifacts/，不作为普通证据直接返回或进入插件包。

## 证据与结论

`analysis_import_evidence` 接受明确选择的 UTF-8 文本文件，最多 64 MiB；kind 为 static、runtime、network_capture 或 reference。它不会执行文件内容或访问 URL。

`analysis_read_evidence` 的 offset / limit 以字符计数，默认最多 16000 字符；nextOffset 非空时可续读。读取前核对保存时的 SHA-256，证据被修改后不继续当作原始材料使用。

`analysis_record_finding` 的 level 区分：

- observed：材料直接显示的事实
- static_inference：由材料推导的解释
- live_verified：记录者完成运行验证并引用运行材料
- unknown：尚未确认

非 unknown 结论至少引用一个登记过的证据；live_verified 至少引用一份 runtime / network_capture，并提供结构化 verification。材料种类检查不能证明验证充分，仍需要记录具体输入、输出和限制。外部导入的“成功”文本不会自动变成可信验证。

`analysis_record_auth` 复用上述结论等级与证据检查，额外记录本地计算、服务器会话、请求签名、安全验证或未知机制，以及来源、期限、续期和验证范围。它不生成 token，也不保存 token 值。

## 结束与进程边界

项目关闭会保留文件、拒绝新增证据和结论，取消本工作台正在进行的观察，并停止该项目的命令。其他项目的任务继续运行。工作台 MCP 的 stdin 结束或收到终止信号时，回收它拥有的全部任务、REA 连接、网站浏览器和本地空白入口。服务只持有内存中的 ChildProcess 对象；正常关闭后等待退出，超时才终止本次进程树。

REA MCP 由独立启动器运行，关闭 stdin 时让 REA 执行自身会话清理。本工作台不采用进程名称批量终止，不根据持久化 PID 文件杀死未知进程。动态分析另行启动的模拟器、App、浏览器和抓取器须由其拥有者关闭。

## 命令行备用方式

状态检查：

```powershell
npm.cmd run status
```

复杂请求先创建 UTF-8 JSON 文件，例如：

```json
{
  "tool": "analysis_create_project",
  "arguments": {
    "targetPath": "D:/samples/example.apk",
    "goal": "分析首页搜索功能，先不运行目标"
  }
}
```

然后执行：

```powershell
node scripts/cli.mjs --request D:\samples\analysis-request.json
```

CLI 与 MCP 调用同一服务与参数校验，不提供任意 shell、任意 REA 命令或 URL 回放入口。CLI 退出时回收自己拥有的进程；跨会话任务不依靠启动后台脚本延续。

## 本地基础检查与运行快照

`analysis_inspect_local({projectId})` 不依赖 REA，针对一个不超过 64 MiB 的文件读取摘要、PE32/PE32+ 头、普通导入表、资源/延迟导入目录位置、嵌入签名存在性和字符串偏移。目录项目须明确 relativePath；真实路径不得越出所选目标。字符串默认最多 2000 条、每条最多 1024 字节，返回 omitted 和编码覆盖范围，不执行内容、不访问其中 URL。

Windows 可额外读取文件版本和提取嵌入证书，**不进行签名信任链、撤销或 catalog 签名验证**。非 PE 或其他宿主仍能取得适用的文件事实；格式解析失败明确保留 peError，不将其当作已完成深度分析。

`analysis_snapshot_process({projectId,pid,samples:3,intervalMs:1000})` 仅观察已运行的 Windows 进程；目录项目同时传对应 EXE 的 relativePath。采样前后核对可执行路径、文件摘要和进程启动时间，最多 6 次、间隔最多 10 秒。它不读取剪贴板、截图内容、命令行凭据或完整内存，也不启动/停止目标。

其网络证据是 connection_snapshot，不是抓包或网络隔离。没有观察到连接只覆盖采样时刻；不能推导过去或未来从不联网、没有上报、不会被检测。

## 结构化验证范围

新 `live_verified` 记录示例：

```json
{
  "method": "functional_test",
  "observedBy": "tool",
  "subject": "本地学习样本的 normalizeQuery",
  "startedAt": "2026-01-01T00:00:00Z",
  "endedAt": "2026-01-01T00:00:01Z",
  "coverage": "仅一次本地输入输出验证，未验证远程服务",
  "networkScope": "not_assessed",
  "input": "空格包围的示例查询",
  "expectedOutput": "规范化查询",
  "actualOutput": "规范化查询"
}
```

verification 放入 analysis_record_finding 或 analysis_record_auth 参数中。method 为 static_inspection / existing_log / user_report / process_snapshot / network_capture / functional_test / other；observedBy 为 tool / user / external。coverage 必填。live_verified 只接受有时间窗口的 process_snapshot / network_capture / functional_test，不能把用户确认或已有日志直接记作独立运行验证。functional_test 必须包含 input、expectedOutput、actualOutput。

networkScope 为 not_assessed / connection_snapshot / capture_window / isolation_test。连接表快照不能标成抓包或隔离；隔离结论需要明确的功能测试。结构检查约束的是记录方式，仍不能自动判定自然语言结论真实、充分或覆盖所有路径。

network_capture 方法还必须引用 network_capture 种类的证据，不能只靠 runtime 标签代替抓包材料。

## 实验副本、收尾与恢复

1. 需要副本时调用 analysis_create_working_copy；仅复制当前本地项目目标到项目 artifacts/a_... 目录，不运行或修改目标。最多 10000 个条目、512 MiB，拒绝链接、junction 和源项目路径重叠，核对源与副本摘要。
2. 外部创建的辅助文件、快捷方式或目录可调用 analysis_register_artifact 登记。登记仅表示来源引用，工作台不能据此自动移动或删除该路径；由原创建工具按用户授权处理。
3. analysis_cleanup_artifacts 默认返回当前计划、摘要、大小和 changedSinceCreation。只有 apply=true 且传入完全匹配的 planId 时才执行；预览后内容改变、链接重定向或原始目标路径交叠均拒绝执行。
4. 清理只将工作台创建的副本移入同项目 .trash，保留证据与报告，不永久删除、不终止外部进程、不修改原软件。关闭项目也不会自动清理文件。移动失败返回已完成项和失败原因，不声称全量成功。
5. analysis_restore_artifact({projectId,artifactId}) 可恢复未改变的隔离副本；目的路径已存在或隔离内容变化时拒绝覆盖。回收目录仍占磁盘空间，永久删除需另外明确处理。

副本不是网络隔离环境，创建副本也不扩大启动、修改或联网授权。不得把任何实际软件的补丁、账号信息、截图或采集材料写入通用插件包。
