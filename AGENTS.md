# 项目要求

## GitHub Actions 与验证

- 推送至 `main` 和提交 PR 时，CI 自动运行 Linux 核心回归（`npm test`）。日常开发优先在本机运行相关测试。
- 修改 Electron、原生依赖或打包配置时，先在本机验证。需要远端平台验证时，在 **Actions → CI → Run workflow** 中只勾选受影响的平台（`verify_windows`、`verify_macos`）。两个选项默认关闭。`build_installer` 会同时启用 Windows 验证并生成 NSIS 安装器。
- 正式发布使用与包版本一致的 `v*` 标签。Release 必须通过 Linux 回归、Windows x64 和 macOS arm64 打包及打包态桌面测试后，才能发布安装包。
- 排查失败时先读日志，确认需要重跑后只重跑失败的作业。账号级 Actions 付费预算由仓库所有者在 GitHub 账单设置中管理。
