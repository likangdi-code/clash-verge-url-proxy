#!/bin/bash
#==============================================
#  Clash Verge 一键安装脚本
#  自动完成：复制到应用程序 → 清除隔离 → 重新签名 → 启动
#  适用：macOS Apple Silicon (M芯片) / Intel
#  用法：双击运行；若被拦截，右键 → 打开 → 仍要打开
#        或在终端执行  bash <本脚本路径>
#==============================================

APP_NAME="Clash Verge.app"
DEST="/Applications/$APP_NAME"

GREEN=$'\033[0;32m'; RED=$'\033[0;31m'; YELLOW=$'\033[1;33m'; NC=$'\033[0m'

echo "=============================================="
echo "        Clash Verge 一键安装"
echo "=============================================="
echo ""

# ── ① 定位 app（依次找 dmg 挂载卷 / 下载 / 桌面 / 当前目录）──
SRC=""
for cand in \
  "/Volumes/Clash Verge/$APP_NAME" \
  "/Volumes/Clash Verge 1/$APP_NAME" \
  "/Volumes/Clash Verge 2/$APP_NAME" \
  "$HOME/Downloads/$APP_NAME" \
  "$HOME/Desktop/$APP_NAME" \
  "$HOME/下载/$APP_NAME" \
  "$PWD/$APP_NAME"; do
  if [ -d "$cand" ]; then SRC="$cand"; break; fi
done

if [ -z "$SRC" ]; then
  echo -e "${RED}未找到 $APP_NAME${NC}"
  echo ""
  echo "请把 dmg 里的「$APP_NAME」拖到【应用程序】文件夹，"
  echo "然后重新双击本脚本运行。"
  echo ""
  read -r -p "按回车键退出..."
  exit 1
fi

echo -e "${YELLOW}已找到: $SRC${NC}"
echo ""

# ── ② 复制到应用程序 ──
echo -e "[1/4] 复制到【应用程序】..."
rm -rf "$DEST"
if ! cp -R "$SRC" "$DEST" 2>/dev/null; then
  echo -e "${YELLOW}  权限不足，改用管理员权限复制...${NC}"
  sudo cp -R "$SRC" "$DEST" || { echo -e "${RED}复制失败${NC}"; read -r -p "按回车键退出..."; exit 1; }
fi

# ── ③ 清除隔离属性（quarantine）──
echo -e "[2/4] 清除隔离标记..."
xattr -cr "$DEST" 2>/dev/null || sudo xattr -cr "$DEST"

# ── ④ 重新签名（Apple Silicon 必需，含 mihomo 内核 sidecar）──
echo -e "[3/4] 重新签名..."
if ! command -v codesign >/dev/null 2>&1; then
  echo -e "${RED}缺少 codesign 工具，请先安装 Xcode 命令行工具：${NC}"
  echo "  在终端执行:  xcode-select --install"
  read -r -p "按回车键退出..."
  exit 1
fi
codesign --force --deep --sign - "$DEST" 2>/dev/null || sudo codesign --force --deep --sign - "$DEST"

# ── ⑤ 验证并启动 ──
echo -e "[4/4] 验证并启动..."
if codesign --verify --deep --strict "$DEST" >/dev/null 2>&1; then
  echo -e "${GREEN}✔ 签名验证通过${NC}"
else
  echo -e "${YELLOW}⚠ 签名有警告（仍尝试启动）${NC}"
fi

open "$DEST"

echo ""
echo -e "${GREEN}=============================================${NC}"
echo -e "${GREEN}  安装完成！Clash Verge 正在启动...${NC}"
echo -e "${GREEN}=============================================${NC}"
echo ""
echo "如果仍提示「已损坏」，请打开："
echo "  系统设置 → 隐私与安全性 → 仍要打开"
echo ""
read -r -p "按回车键关闭本窗口..."
