Workstation Mini 0.3.3

- 修复原生跨页过渡期间按钮、链接和保存点击偶发失效。工作区改用 140ms 普通 CSS 淡入，侧栏保持稳定，动画期间可正常操作；减少动态效果设置仍受支持。
- 新增延长动画期间的真实坐标点击回归，覆盖复习入口、翻面按钮和编辑器保存。
- 包含 0.3.2 的编辑器增强、快速待办、复习撤销、历史对比、同步冲突处理及数据保全修复。

安装包：Windows x64 使用 setup.exe；Apple Silicon Mac 使用 mac-arm64.dmg。SHA256SUMS.txt 提供校验值。

Windows 安装包未配置代码签名；macOS 为 ad-hoc 签名，未经 Apple 公证。Mini 不自动更新，请手动下载安装。

多设备使用时请一同升级，以正确识别复习撤销事件。完整变更见 CHANGELOG.md。
