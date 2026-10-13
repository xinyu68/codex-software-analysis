# 按需准备 Android 运行环境

静态 APK 分析使用 android profile，只需 REA、匹配的 JADX headless JAR 和完整 JDK。不要为静态分析下载模拟器或系统镜像。

实际运行才使用 android-runtime profile。优先复用用户选定的手机或已存在的 AVD，检查 Android SDK 的 platform-tools；`adb version` 不启动服务，`adb devices` 可能启动服务，记录服务端口和所有权。依照当前 REA 发现到的 ADB 工具 schema 操作准确序列号，不操作另一台设备。

需要新环境时，从 [官方 Android 命令行工具](https://developer.android.com/tools) 获取当前平台的 command-line tools，放入单独 SDK 目录。仅安装任务需要的 platform-tools、emulator、所选 API/ABI 镜像：

```powershell
# 此处的 sdkmanager 路径和包名按实际下载与目标 ABI 选择
& "$sdkRoot\cmdline-tools\latest\bin\sdkmanager.bat" --sdk_root="$sdkRoot" "platform-tools" "emulator" "system-images;android-<API>;google_apis;<ABI>"
```

在调用进程设置独立 JDK 与 SOFTWARE_ANALYSIS_ANDROID_SDK，不修改系统 JAVA_HOME/ANDROID_HOME。阅读并接受 SDK 的许可后，用 avdmanager 创建独立 AVD；API/ABI 从 APK 的库、系统兼容性和任务深度决定，不把占位包名当成可执行命令。

REA 当前支持的设备能力以工具发现为准。新 AVD 不继承旧案例会话；只有用户任务包含运行验证时才安装和启动 APK。结束时用原工具关闭会话、停止本次拥有的模拟器或 ADB 实例，保留证据。通用安装器目前不自动下载镜像、创建 AVD、安装 Frida/Blutter 或替代商业工具授权。
