# 软件分析工作台

一个在本机运行的 Codex 插件项目，用于分析软件文件、应用目录、网站 URL 和已有网络记录。通过 REA 复用分析引擎，通过工作台管理环境、独立项目、证据、认证机制和报告。当前版本 0.2.0。

参考 `doubao-browser-bridge-tutorial` 的本地工具、MCP、Skill 和文档分层方式。这里提供两个 stdio MCP 服务，不需要常驻 HTTP 桥接服务、浏览器扩展或对外开放端口。

## 当前功能

| 功能 | 当前实现 |
| --- | --- |
| 环境诊断与准备 | 按 basic/web/android/android-runtime/flutter/native 路线检查；可按需准备 REA、匹配 JADX headless JAR 和独立 JDK |
| 分析项目 | 每个目标独立目录；记录问题、类型和文件 SHA-256 |
| 静态入口 | 固定调用 REA 的 artifact、Android、JavaScript/Electron、.NET 和 HAR 检查 |
| 深入分析 | 独立 `rea_analysis` MCP 入口，复用当前安装版本实际暴露的工具 |
| 网站分析 | URL 建项目 → 有时限的 REA 浏览器采集 → HTTP/WebSocket 摘要与页面文本 → 导出脚本 → 静态分析 → 报告 |
| 证据 | 保存静态输出、导入明确选取的 UTF-8 记录、摘要校验与分页读取 |
| 大份结果 | 浏览器返回超预算时自动导出 retained evidence；64 MiB 文本导入与分页读取；网站静态分析保存摘要与私有完整会话文件 |
| 认证机制 | 区分本地 token、服务器会话、请求签名、安全验证和未知，记录有效期、续期及验证范围 |
| 结论和报告 | 区分 observed / static_inference / live_verified / unknown，生成本地 Markdown 报告 |
| 任务管理 | 完成、失败、取消、项目关闭和 MCP/CLI 退出时回收本工作台拥有的命令、REA 连接、网站浏览器和临时入口 |

完成静态分析不代表业务接口已经调用成功。浏览器打开、授权响应、WebSocket 心跳、订阅与业务数据分别验证。工作台网站流程会回收自己的浏览器；设备、原生引擎和独立 rea_analysis 会话仍按具体工具管理。系统镜像、AVD 和可选 Flutter/native 工具按需准备，见环境说明。

## 准备环境

REA 6.4.0 支持 Node.js 22.19+（22 系列）、24.11+（24 系列）或 26+。本机验证使用 Node 24.14.1。

```powershell
git clone https://github.com/xinyu68/codex-software-analysis.git
Set-Location .\codex-software-analysis
npm.cmd ci --ignore-scripts
npm.cmd run setup
node scripts/prepare-environment.mjs basic --install
```

优先复用已经安装的兼容工具。按当前目标准备：

```powershell
node scripts/prepare-environment.mjs web
node scripts/prepare-environment.mjs android --install
```

`setup` 准备插件运行依赖；`prepare-environment` 默认检查并返回计划，`--install` 才准备缺失的受管工具。REA 固定 6.4.0，JADX 使用它指定的 headless 0.7.1 JAR 并核验 SHA-256；JDK 优先复用完整模块化版本，必要时在 Windows x64 准备独立 Temurin 21。不会修改系统 Java/Android 环境或启动模拟器。Node、浏览器、SDK 和镜像仍需按 [环境说明](docs/setup.md) 准备。

## 安装为本地 Codex 插件

这些命令已按本机 Codex CLI 0.153.4 的帮助核对。仅创建源码项目时不需要执行安装。

```powershell
codex plugin marketplace add (Get-Location).Path
codex plugin add codex-software-analysis@local-software-analysis
```

安装后在插件源目录运行 `npm.cmd run setup`，或让首次设置 Skill 准备运行目录，再打开新任务检查工具。两个 MCP 入口本身不自动下载安装依赖；未设置时会返回明确诊断。源码项目的创建和独立 MCP 测试，不代表插件已经安装或当前会话已经加载工具。

该 marketplace 使用本地目录作为源。不要编辑 Codex 插件缓存。运行目录默认是 `%LOCALAPPDATA%\codex-software-analysis\runtime`，可用 `SOFTWARE_ANALYSIS_RUNTIME_HOME` 改为其他绝对路径。代码和配置摘要变化时使用新的运行快照，保留已有会话和资料。REA 及分析引擎属于外部依赖，不打包进插件。

## 使用示例

> 分析 D:\samples\example.apk，看看首页搜索功能如何实现；先做静态分析。

> 分析这个 Electron 应用目录，梳理渲染进程与主进程的通信。

> 查看这个 DLL 的类型和依赖，再分析我指定的函数。

> 分析我提供的 HAR，解释请求和响应，不回放其中的 URL。

> 用 REA 分析这个网站，看看数据接口与更新方式；记录安全验证和未确认事项。

工作流：检查环境 → 创建项目 → 选择分析路线 → 读取证据 → 记录带证据的结论 → 生成报告 → 关闭会话和本次任务。

## MCP 工具

| 工具 | 用途 |
| --- | --- |
| `analysis_status` | 只读环境诊断与本服务活动任务 |
| `analysis_create_project` | 建立目标项目与初步身份记录 |
| `analysis_get_project` | 查看项目、运行记录、证据和结论 |
| `analysis_run_static` | 运行固定静态 profile 并保存结果 |
| `analysis_import_evidence` | 导入选取的本地文本证据，最多 64 MiB |
| `analysis_read_evidence` | 按字符分页读取证据，返回 nextOffset |
| `analysis_record_finding` | 记录结论、证据引用与限制 |
| `analysis_report` | 生成本地 Markdown 报告 |
| `analysis_close_project` | 关闭项目、停止本工作台拥有的分析任务并保留材料 |
| `analysis_check_environment` | 按路线执行依赖检查和 MCP/版本验证 |
| `analysis_prepare_environment` | 返回准备计划；install=true 时准备所选受管工具 |
| `analysis_capture_website` | 有时限地访问网站，保存网络与页面证据、导出脚本并回收资源 |
| `analysis_record_auth` | 记录认证机制、来源、期限、续期及验证范围 |

REA 工具列表以实际 MCP 发现结果为准。命令行备用方式、profile 与字段说明见 [工作流说明](docs/workflow.md)。

## 工作目录与资料

默认工作目录是 `%LOCALAPPDATA%\codex-software-analysis\workspace`，可用 `SOFTWARE_ANALYSIS_HOME` 指定绝对路径。配置文件 `config/local.json` 只用于本机，不提交、不进入发布包。

项目包含 `project.json`、`evidence/` 和 `reports/`。源软件不自动复制，不执行其中的脚本；证据保存时过滤常见凭据字段，但不能保证识别所有秘密。软件本体不会由工作台自动上传，MCP 返回的分析结果会交给调用它的 AI 客户端。

插件源码不包含任何具体软件的业务域名、密钥、会话、账号或接口规则。联网验证、实际运行和持续监测分别按用户当前任务范围决定，不因静态分析而自动启动。

## 验证与维护

```powershell
npm.cmd test
npm.cmd run check
npm.cmd run verify
npm.cmd run verify:web
npm.cmd run verify:android
npm.cmd run package
```

- `test` 检查项目边界、证据完整性、结论分级、并发保存和进程回收
- `check` 检查本包结构、manifest、MCP 入口及 Skill 元数据
- `verify` 用真实 SDK 客户端连接两个 MCP，发现工具，并用本仓库学习样本完成 REA 静态分析、证据读取、报告和关闭流程；不调用真实业务接口
- `package` 按源文件允许列表生成父目录下的 tar.gz，保留单一插件根目录，排除依赖、运行资料和本机配置

验证记录放在 `.runtime/`，属于本机运行数据。网站和 APK 验证使用本地学习样本，不访问业务服务器；Android 验证只做静态检查和方法反编译。没有验证全部原生引擎、Android 设备/模拟器和所有 Flutter 版本。

本版本的具体结果见 [验证记录](docs/verification.md)。

## 目录结构

```text
lib/                  配置、目标识别、项目与进程管理
mcp/                  工作台 MCP 与输入 schema
scripts/              CLI、REA MCP 启动器、验证和包检查
skills/               首次设置与通用分析工作流
config/               本机配置示例
docs/                 环境与工作流说明
test/                 边界测试与本地学习样本
assets/               插件图标
.agents/plugins/      本地 marketplace
plugin.json           Agent Plugins manifest
mcp.json              两个 stdio MCP 的启动配置
```

## 依赖与许可

本项目新代码使用 MIT 许可。REA 和其他外部分析工具保留各自许可；安装本插件不授予 IDA、Hopper、JEB 等商业工具的许可。REA 文档和能力范围见 [官方项目](https://github.com/morluto/rea)。

作者：[xinyu68](https://github.com/xinyu68)，联系邮箱：1693784423@qq.com。

公开仓库只包含通用工作台、文档及虚构的学习样本。不要提交本机 `config/local.json`、`.runtime/`、`.env`、分析工作目录、实际软件文件或抓包材料；`.gitignore` 和源码打包脚本已排除本机配置与运行资料。仅分析你有权研究的软件和数据，使用时遵守适用的授权、服务条款及工具许可。
