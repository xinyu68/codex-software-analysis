# 0.2.0 验证记录

本次验证环境：Windows、Node.js 24.14.1、REA 6.4.0、MCP SDK 1.32.1、完整 JDK 21。

- 工作台扩展到 13 个 MCP 工具；REA 仍发现 170 个工具，这不代表逐一验证所有工具
- 自动准备流程实际下载并校验了匹配的 JADX headless 0.7.1 JAR；复用了 PATH 中的完整 JDK 21，没有修改原系统 JAVA_HOME
- 从不含 node_modules / 源目录本机配置的模拟缓存目录成功启动新版工作台和 REA MCP；JavaScript/HAR 的静态、证据、报告和关闭流程通过
- 本地网站端到端测试通过：HTTP 报价返回并显示、WebSocket 收到业务帧并显示、脚本导出及静态分析
- 大脚本响应实际触发 REA stdio 返回预算限制，自动导出 retained capture 后仍完成分析
- 本地验证页正确记录为 partial，没有将验证码页面当成业务成功
- 关闭项目取消正在运行的浏览器观察，MCP stdin 断开也回收活动浏览器；学习站点的 WebSocket 连接确认关闭
- 学习 APK 的真实包检查和 answer 方法反编译通过，得到 return 7；没有执行 APK，没有使用实际软件的账号或业务接口
- 自动测试覆盖大文本分页与完整性、URL 凭据、嵌套 provider 错误、token 验证范围、作用域配置、ZIP 安全解压、并发与进程清理
- 21 个自动测试全部通过；两个 Skill 的元数据校验和插件包结构检查通过
- 验证仅使用本地学习样本，没有调用第三方业务接口，没有启动模拟器，没有注册或安装到 Codex

完整验证材料在本机 `.runtime/verification/`、`.runtime/web-verification/` 和 `.runtime/android-verification/`，不进入源码包。

仍未验证另一台物理电脑的全新安装、独立 JDK 的完整网络下载分支、Android 设备/AVD 动态操作、全部 Flutter 版本和原生 provider。JDK ZIP 解压路径检查用本地 ZIP 验证，不能替代完整安装分支验证。Node/浏览器、SDK/镜像及可选 Flutter/native 工具仍需按任务准备。

## 0.1.0 历史验证

本次验证环境：Windows、Node.js 24.14.1、REA 6.4.0、MCP SDK 1.32.1。

- 11 个自动测试全部通过，覆盖参数边界、目标变化、并发保存、证据摘要、凭据过滤、目录 junction、项目关闭、超时/输出限制、子进程树和 MCP 退出清理
- 真实 SDK 客户端成功初始化两个 MCP：工作台发现 9 个工具，REA 发现 170 个工具
- 验证运行目录准备与锁定依赖安装；从不含 node_modules / 源目录本机配置的模拟缓存目录启动成功
- JavaScript 学习样本完成实际 REA 静态分析、证据读取、结论登记、报告生成和项目关闭；没有执行该样本
- 本地 HAR 样本的静态分析成功；没有回放 URL
- 本机已有 .NET 程序集的静态识别与元数据分析成功
- 没有调用实际软件的业务服务器，没有启动模拟器、浏览器或目标应用

没有验证 Android APK/JADX 的完整流程、Flutter AOT 深入分析、所有原生 provider、设备和浏览器动态操作。环境检测中的 SDK 文件存在不代表以上能力已验证。

完整机器记录和样本报告保存在本机 `.runtime/verification/`，不包含在源代码包中。当前只创建并测试了源码项目，未执行 Codex marketplace 注册、插件安装或账号上传。
