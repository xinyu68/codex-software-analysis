---
name: setup
description: 按分析路线检查和准备本地依赖，修复 REA MCP 连接；首次使用、开始新类型的软件或网站分析、工具缺失时使用
---

# 设置软件分析工作台

`analysis_status` 只查看配置和本工作台的活动任务。实际准备使用某条路线时，调用 `analysis_check_environment`，profile 选择 basic、web、android、android-runtime、flutter 或 native。它检查 MCP 工具、Java 模块等；不打开目标，不启动 adb 服务。不把依赖存在当成目标分析成功。

工具尚未加载时，已准备源目录依赖的情况下可以运行 `node scripts/cli.mjs status`。首次设置入口是 `node scripts/runtime.mjs setup`，它只依赖 Node 内置模块，不要求缓存目录含 node_modules。入口目录从当前 MCP 配置确定，不使用某次案例目录作为全局默认路径。

首次设置运行 `node scripts/runtime.mjs setup`，或源码项目中使用 `npm.cmd run setup`。它把运行代码和锁定依赖准备到稳定目录，并保存本机路径绑定；不修改插件缓存。开发源码项目需要测试时才在源目录运行 `npm.cmd ci --ignore-scripts`。

用户已要求分析目标或准备环境时，可按当前路线准备缺失依赖。先复用可用版本，随后用 `analysis_prepare_environment` 的 components 精确选择缺失的 rea/jadx/jdk，install=true 执行本地准备；没有安装需求时使用默认计划模式。替代入口 `node scripts/prepare-environment.mjs <profile>` 只检查并返回计划，添加 `--install` 才准备运行依赖和分析工具。用户只要求方案时不安装。

REA 默认安装到受管目录，版本固定 6.4.0；Android 配套使用其指定的 jadx-headless-mcp 0.7.1 JAR，按固定 SHA-256 核验，不以普通 JADX GUI 代替。优先复用 PATH 中包含 jdk.compiler 的完整 JDK；必要时为分析准备独立 Temurin 21，不改变公司项目的 Java 版本。工具路径变更后重新准备运行快照并刷新 MCP。详见 [环境配置](../../docs/setup.md)。

默认查找全局 npm 安装的 REA。自定义位置使用绝对路径环境变量 `SOFTWARE_ANALYSIS_REA_ROOT`。分析工作目录使用 `SOFTWARE_ANALYSIS_HOME`，Android SDK 使用 `SOFTWARE_ANALYSIS_ANDROID_SDK`。参考 [环境配置](../../docs/setup.md)。不要修改系统或用户级 JAVA_HOME、ANDROID_HOME 等变量。

仅在需要设备观察时准备 Android SDK 和所选设备/AVD；按 [设备准备](references/android-runtime.md) 复用或设置。Flutter/native 工具根据实际版本、ABI 和格式选择。Node、浏览器、SDK/镜像和可选原生工具有明确准备说明，目前不会由通用安装器全部下载。

用户要求安装插件时，使用文档中的本地 marketplace 安装方式；只要求创建项目或导出源码时，不改变 Codex 全局注册，不上传插件。安装后需要新会话才能刷新工具。缺少当前 MCP 工具时可以先使用本项目 CLI，不能声称工具已出现在会话里。

连接验证只做初始化、工具发现和环境检查；不要通过启动真实软件、登录账号、调用业务接口来测试 MCP 连接。
