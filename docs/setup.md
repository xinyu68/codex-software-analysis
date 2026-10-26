# 本地环境

## 配置优先级

1. 当前进程的 `SOFTWARE_ANALYSIS_*` 环境变量
2. 源目录 `config/local.json`
3. setup 保存的稳定运行目录 `binding.json`
4. 标准安装位置与默认工作目录

所有自定义路径使用绝对路径。可参考 `config/local.example.json` 创建自己的 `config/local.json`，但不要把示例中的 `your-name` 当作实际路径。

| 配置 | 环境变量 | 含义 |
| --- | --- | --- |
| reaRoot | SOFTWARE_ANALYSIS_REA_ROOT | `rea-agents` 包根目录，不是 rea.cmd 文件路径 |
| workspaceRoot | SOFTWARE_ANALYSIS_HOME | 独立分析工作目录 |
| androidSdkRoot | SOFTWARE_ANALYSIS_ANDROID_SDK | SDK 根目录，含 platform-tools/ 和 emulator/ |
| javaHome | SOFTWARE_ANALYSIS_JAVA_HOME | 本次分析的完整 JDK，传给子进程 JAVA_HOME |
| jadxJar | SOFTWARE_ANALYSIS_JADX_JAR | REA 所需的 jadx-headless-mcp JAR，传给 REA_JADX_MCP_JAR |
| browserExecutable | SOFTWARE_ANALYSIS_BROWSER | Chrome/Edge 的绝对可执行文件路径 |
| ghidraRoot | SOFTWARE_ANALYSIS_GHIDRA_ROOT | 传给分析子进程的 GHIDRA_INSTALL_DIR |
| blutterRoot | SOFTWARE_ANALYSIS_BLUTTER_ROOT | 可选 Flutter 工具根目录，仅记录；按目标版本另行验证 |

运行代码和依赖默认放在 `%LOCALAPPDATA%\codex-software-analysis\runtime`，可用 `SOFTWARE_ANALYSIS_RUNTIME_HOME` 指定绝对路径。首次设置会安装锁定的插件 npm 依赖，使用 `--ignore-scripts`，然后记录本机路径绑定；不修改 Codex 注册。MCP 启动器只复用已经准备的快照，不在初始化中联网安装。

REA 默认查找插件目录中的 `node_modules/rea-agents`、Windows 全局 npm 目录和常见 Unix 全局目录。没有发现包时，工作台仍可创建项目、导入证据和生成报告；REA MCP 启动器会给出明确缺失错误。

Android SDK 还检查当前进程已有的 `ANDROID_SDK_ROOT`、`ANDROID_HOME` 或默认 `%LOCALAPPDATA%\Android\Sdk`。仅检测文件存在，不启动 adb 服务。

## 按软件类型准备依赖

| 类型 | 分析入口 | 附加条件 |
| --- | --- | --- |
| 包和文件 | artifact | 支持范围由 REA 当前版本决定 |
| JS / Electron | javascript | Node / REA；目标目录或 ASAR；不执行目标代码 |
| .NET PE/CLI | managed | 静态元数据分析不需要运行目标 |
| Android APK | android | REA 6.4.0 指定 jadx-headless-mcp 0.7.1 JAR 和完整 JDK；优先复用模块化 JDK，推荐已验证的 JDK 21 |
| Flutter 深入分析 | REA / 可选 Blutter | ABI、Dart/engine 版本与具体工具支持必须匹配 |
| 原生函数分析 | REA provider | 已安装兼容 Ghidra、IDA 或 Hopper；平台支持不同 |
| HAR | har | 本地已有 HAR 文件，不回放 URL |
| 设备观察 | REA ADB tools | 用户明确选定的设备、现有 adb 和当前任务范围 |

REA 6.4.0 与仓库 main 的工具不一定相同。先读取实际 `tools/list` 和 schema，再使用命令。REA 自身 provider 配置使用其文档和实际诊断支持的变量，例如 `GHIDRA_INSTALL_DIR` / `JAVA_HOME`；不要推测未验证的变量名。

依赖诊断与安装分开。`analysis_status` 成功只证明它能读取本机配置；JADX、native provider、设备连接与实际目标分析仍需相应验证。

不修改系统/用户级 JAVA_HOME 或 Android 变量；不同项目需要不同版本时在启动相应 MCP 的进程环境中设置。Windows 建议用本项目 CLI 的 `--request` UTF-8 文件方式，避免原生命令传递中文 JSON 时的引号和编码问题。

## 按需准备入口

Node 必须已可用，版本符合 package.json 的 engines；缺少时从 [Node 官方下载](https://nodejs.org/en/download) 准备兼容版本。浏览器可以复用已有 Chrome/Edge，工作台检查常见安装位置，自定义时设置 SOFTWARE_ANALYSIS_BROWSER。

```powershell
node scripts/runtime.mjs setup
node scripts/prepare-environment.mjs basic --install
node scripts/prepare-environment.mjs web
node scripts/prepare-environment.mjs android --install
```

默认环境命令只检查并返回计划；若源码没有依赖、缓存没有运行快照，需要先 setup。`--install` 将插件运行依赖和选定缺失工具准备到稳定目录。MCP 对应 analysis_check_environment / analysis_prepare_environment；后者默认 install=false，不联网安装工具。

受管工具位于运行根目录的 tools/：REA 使用固定 npm 包 6.4.0，JADX 使用 [匹配的 headless 0.7.1 发布](https://github.com/1013503897/jadx-headless-mcp/releases/tag/v0.7.1) 并校验 REA 指定的 SHA-256。独立 JDK 的自动下载目前支持 Windows x64，使用 [Temurin 官方发布](https://adoptium.net/installation/) 的 21 系列 ZIP 和发布校验值；解压前检查路径与链接条目。下载失败或摘要不匹配会报错，不执行该文件。

### 0.2.1 的能力与连接诊断

native 检查读取 REA providers 的真实 availability / diagnostics，而非仅检测引擎目录。缺少引擎会返回 ready=false，并保留不依赖 REA 的 localStatic 能力。provider 可用仍不代表所选格式或具体函数已经验证；检查不打开目标。

analysis_diagnose_connections 通过两个独立短连接分别检查工作台与 REA，返回服务版本、工具数量、必需工具缺失项和当前源/运行/工作目录。hostToolExposure 始终是 not_verified：子进程发现正常不能证明当前聊天工具目录已刷新。工具缺失时先区分服务失败、宿主暴露和旧运行快照，按需重新 setup/reload；不要直接修改缓存。

### 可恢复的受管依赖下载

JADX / 独立 JDK 下载使用稳定的 .part 与元数据检查点。只有源标识、预期 SHA-256 和服务器 validator 一致时才发送 Range / If-Range；服务器返回完整 200 时重新写入，绝不把整包追加到旧片段。206 必须符合 Content-Range，最终完整 SHA-256 匹配才写入正式依赖文件。HTTPS 跳转不得降为 HTTP。

默认单文件上限仍为 384 MiB、单次总时限 10 分钟；这不是新增 Ghidra 自动安装入口。失败片段保留供重试，锁在正常结束/取消时释放。进程被强制终止可能留下 .lock；需先核对该受管准备任务是否仍运行再处理，不能据 PID 文件直接终止未知进程。下载器不会自动清空运行目录或系统临时目录。

选用的 Java/JADX 路径保存到本机 binding.json，并在启动子进程时传入；不会修改系统 Java/Android 环境。源码 config/local.json 的显式路径优先级更高；若人为指定了失效路径，应修正该配置。路径变更后重新执行 setup，让新快照绑定实际路径，随后重新连接 MCP。

Android SDK、系统镜像、AVD、Frida、Blutter 及原生商业引擎目前提供按任务准备说明，未覆盖自动安装。具体设备步骤见 [设备准备](../skills/setup/references/android-runtime.md)。Android 静态分析不需要模拟器或镜像。
