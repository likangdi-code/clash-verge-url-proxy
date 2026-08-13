<h1 align="center">
  <img src="./src-tauri/icons/icon.png" alt="Clash" width="128" />
  <br>
  Clash Verge（网址代理版）
</h1>

<p align="center">
  基于 <a href="https://github.com/clash-verge-rev/clash-verge-rev">Clash Verge Rev</a> 定制，新增 <strong>「网址代理」</strong> 功能，支持 Windows、macOS 与 Linux。
</p>

## 简介

Clash Verge 是一款基于 **Rust + Tauri 2** 的 [Clash Meta (mihomo)](https://github.com/MetaCubeX/mihomo) 图形化客户端，简洁高效，支持系统代理、TUN 虚拟网卡、配置文件增强（Merge / Script）等功能。

> 本项目是官方 [clash-verge-rev](https://github.com/clash-verge-rev/clash-verge-rev) 的定制分支，官方版本的原有功能与本版完全一致，本版额外提供 **「网址代理」** 功能，并内置一条**命令桥**，让外部 CLI（如 [Clash Proxy](https://github.com/likangdi-code/clash-verge-url-proxy-cli)）也能自动化建组。

## Preview

![预览](./docs/preview.png)

## 新增功能：网址代理

「网址代理」允许你为**任意网址**单独指定代理节点，而不是让所有流量都走同一个代理组。

### 使用教程

1. 打开左侧菜单的「**网址代理**」页。
2. 在顶部输入框输入网址（例如 `https://example.com`，或 Tor 的 `.onion` 域名），点击「**新建**」。
3. 展开该网址的卡片，从节点列表中**手动点击**选择某个代理节点。
4. 也可以点击「**⚡ 测速**」按钮，测试所有节点对该网址的延迟，并自动选择延迟最低的节点。
5. 点击 **AUTO** 按钮开启自动选择，之后每次进入页面都会自动测速并选中最优节点。

### 功能细节

- **独立代理组**：每个网址对应一个独立的 `URL-Proxy-*` 选择器组，互不影响。
- **Tor 支持**：`.onion` 域名自动标注 TOR 标签，并使用 HTTP 协议。
- **持久化**：网址与节点映射保存在本地，跨环境自动从订阅增强文件恢复。
- **不干扰代理页**：`URL-Proxy-*` 组已被过滤，「代理」页显示不受影响。

## 与 Clash Proxy CLI 联合使用

[Clash Proxy](https://github.com/likangdi-code/clash-verge-url-proxy-cli) 是本仓库「网址代理」功能的 **CLI 配套工具**——让 agent / 脚本在下载前针对下载链接自动选择延迟最低的节点，再走代理下载。两者**共用同一份网址代理组与规则**，互补使用：

| | 本仓库（GUI） | Clash Proxy（CLI） |
|---|---|---|
| 角色 | 可视化管理「网址代理」 | 自动化测速选节点 |
| 建组 | 界面手动新建 `URL-Proxy-*` 组 | `add` 全自动建组（走命令桥） |
| 选节点 | 手动点击 / ⚡ 测速 / AUTO | `pick` 自动切最低延迟 |
| 适用 | 日常手动使用 | agent / 脚本 / 下载自动化 |

**联合工作流（AI agent 下载场景）**：

```bash
# 1. 全自动：为下载链接建组 + 选最优节点（本软件在跑即可）
clash-proxy add "https://example.com/big-file.zip"

# 2. 走 mihomo 混入端口下载（命中网址代理规则 → 走刚选中的节点）
curl --proxy http://127.0.0.1:7897 -L -o big-file.zip "https://example.com/big-file.zip"
```

- **共用同一份组/规则**：GUI 建的组，CLI 能 `pick`；CLI `add` 建的组，回到本软件「网址代理」页即可看到并手动调整。
- **互补**：GUI 适合可视化巡检和手动微调，CLI 适合把「下载前选最优节点」自动化（尤其 agent 自主执行）。
- **安装 Clash Proxy**：Windows `irm https://raw.githubusercontent.com/likangdi-code/clash-verge-url-proxy-cli/main/install.ps1 | iex`；macOS / Linux `curl -fsSL https://raw.githubusercontent.com/likangdi-code/clash-verge-url-proxy-cli/main/install.sh | sh`

> ⚠️ Clash Proxy 的 `add` 依赖本软件的**命令桥**（`/commands/profile-save`），需要**含命令桥的构建**（本次发布的安装包已含此能力）；旧版仍可用 `pick` 对已建组测速切换。

## 下载

到 [Release 页面](https://github.com/likangdi-code/clash-verge-url-proxy/releases) 下载对应平台的安装包：

| 平台 | 安装包 |
| :--- | :--- |
| Windows x64 | `Clash.Verge_2.5.3_Windows_x64-setup.exe` |
| Windows ARM64 | `Clash.Verge_2.5.3_Windows_arm64-setup.exe` |
| Windows x64（内置 WebView2） | `Clash.Verge_2.5.3_Windows_x64_WebView2-setup.exe` |
| Windows ARM64（内置 WebView2） | `Clash.Verge_2.5.3_Windows_arm64_WebView2-setup.exe` |
| macOS（Apple M 芯片） | `Clash.Verge_2.5.3_macOS_Apple_M_Chip.dmg` |
| macOS（Intel） | `Clash.Verge_2.5.3_macOS_Intel_Chip.dmg` |
| Linux amd64 (x64) | `Clash.Verge_2.5.3_Linux_amd64.deb` |
| Linux x86_64 | `Clash.Verge-2.5.3-Linux_x86_64.rpm` |

> 内置 WebView2 版体积较大（约 200MB），仅在系统无法安装 WebView2 或企业环境使用。
> Linux 目前仅提供 amd64（x64）安装包。

> ⚠️ **macOS 安装**：本版本未签名、未公证（无 Apple 开发者证书），首次打开会被 Gatekeeper 拦截（提示「已损坏，无法打开」——这是拦截，**文件并未损坏**）。**推荐一键安装**：
>
> 1. 下载 [Install.command](./Install.command)（或从 Release 页面下载）
> 2. 双击运行（若被拦截，右键 → 打开 → 仍要打开）
> 3. 脚本自动完成「复制到应用程序 → 清除隔离 → 重新签名 → 启动」
>
> 手动方式（终端执行，需先把 `Clash Verge.app` 拖入「应用程序」）：
>
> ```bash
> sudo xattr -cr "/Applications/Clash Verge.app"
> sudo codesign --force --deep --sign - "/Applications/Clash Verge.app"
> open "/Applications/Clash Verge.app"
> ```

## 特性

- 基于 Rust + Tauri 2，内置 [mihomo](https://github.com/MetaCubeX/mihomo) 内核，支持切换 Alpha 版本内核
- **网址代理**：为任意网址单独指定节点，支持 TOR（.onion）
- **命令桥**：本地 HTTP 接口（`/commands/profile-save` 等），供外部 CLI 自动化建组
- 简洁美观的界面，支持自定义主题、代理组/托盘图标与 CSS Injection
- 配置文件管理与增强（Merge / Script），语法提示
- 系统代理与守卫、TUN（虚拟网卡）模式
- 可视化节点与规则编辑
- WebDAV 配置备份与同步

## 开发

参见 [CONTRIBUTING.md](./CONTRIBUTING.md)。安装 Tauri 依赖后：

```shell
pnpm i
pnpm run prebuild
pnpm dev
```

## 致谢

- [clash-verge-rev](https://github.com/clash-verge-rev/clash-verge-rev)：本项目的基础
- [zzzgydi/clash-verge](https://github.com/zzzgydi/clash-verge)
- [tauri-apps/tauri](https://github.com/tauri-apps/tauri)
- [MetaCubeX/mihomo](https://github.com/MetaCubeX/mihomo)

## License

[GPL-3.0](./LICENSE)
