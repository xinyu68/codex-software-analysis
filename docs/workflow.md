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

非 unknown 结论至少引用一个登记过的证据；live_verified 至少引用一份 runtime / network_capture。材料种类检查不能证明验证充分，仍需要记录具体输入、输出和限制。外部导入的“成功”文本不会自动变成可信验证。

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
