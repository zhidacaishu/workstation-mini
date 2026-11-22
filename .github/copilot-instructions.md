# 项目要求

- 日常推送至 `main` 和 PR 只自动运行 Linux 核心回归。优先本机测试。需要验证 Electron、原生依赖或打包改动时，从 CI 手动选择受影响的 Windows 或 macOS 平台。
- 正式版本使用与包版本一致的 `v*` 标签，保留 Linux 回归、Windows x64 和 macOS arm64 打包及打包态桌面测试作为发布条件。
- 修改工作流时遵循仓库根目录的[项目验证要求](../AGENTS.md)。
