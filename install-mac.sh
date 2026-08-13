#!/bin/bash
#==============================================
#  install-mac.sh — Clash Verge（网址代理版）macOS 一条指令安装脚本
#
#  一条指令（自动检测 Apple M / Intel 芯片，下载对应 dmg 并安装）：
#     curl -fsSL https://raw.githubusercontent.com/likangdi-code/clash-verge-url-proxy/main/install-mac.sh | bash
#
#  指定版本（默认最新 release）：
#     curl -fsSL https://raw.githubusercontent.com/likangdi-code/clash-verge-url-proxy/main/install-mac.sh | bash -s v2.5.2
#
#  自动完成：
#     ① 检测芯片，从 GitHub Release 元数据定位对应 dmg（官方 sha256 digest）
#     ② 本地已下载且 sha256 一致 → 跳过下载；缺失 / 不一致 → 重新下载
#     ③ 下载后再次校验 sha256
#     ④ 挂载 dmg → 复制到 /Applications → 清除隔离 → 重新签名 → 启动
#==============================================

set -euo pipefail

REPO="likangdi-code/clash-verge-url-proxy"
TAG_OR_LATEST="${1:-latest}"
APP_NAME="Clash Verge.app"
DEST="/Applications/$APP_NAME"
GREEN=$'\033[0;32m'; RED=$'\033[0;31m'; YELLOW=$'\033[1;33m'; NC=$'\033[0m'

say()  { echo -e "$*"; }
ok()   { echo -e "${GREEN}✓ $*${NC}"; }
warn() { echo -e "${YELLOW}⚠ $*${NC}"; }
fail() { echo -e "${RED}✗ $*${NC}"; exit 1; }

echo "=============================================="
echo "      Clash Verge 一条指令安装 (macOS)"
echo "=============================================="
echo ""

# ── ① 检测芯片 ──
ARCH="$(uname -m)"
case "$ARCH" in
  arm64)  CHIP="Apple_M_Chip" ;;
  x86_64) CHIP="Intel_Chip" ;;
  *) fail "不支持的系统架构: $ARCH（仅支持 arm64 / x86_64）" ;;
esac
say "${YELLOW}检测到芯片: ${CHIP}（${ARCH}）${NC}"

# ── ② 获取 Release 元数据（含 GitHub 官方 sha256 digest）──
if [ "$TAG_OR_LATEST" = "latest" ]; then
  API="https://api.github.com/repos/$REPO/releases/latest"
else
  API="https://api.github.com/repos/$REPO/releases/tags/$TAG_OR_LATEST"
fi
say "获取 Release 信息（${TAG_OR_LATEST}）..."
json="$(curl -fsSL --max-time 30 "$API" 2>/dev/null)" || fail "获取 Release 信息失败（网络问题或版本不存在），请检查网络后重试"

marker="\"name\":\"[^\"]*${CHIP}\\.dmg\""
name="$(printf '%s' "$json" | grep -oE "$marker" | head -1 | sed -E 's/"name":"(.*)"/\1/' || true)"
[ -n "$name" ] || fail "Release 中未找到 ${CHIP} 对应的 dmg"

rest="${json#*"$name"}"
digest="$(printf '%s' "$rest" | grep -oE '"digest":"sha256:[0-9a-f]+"' | head -1 | cut -d: -f3 | tr -d '"' || true)"
dl_url="$(printf '%s' "$rest" | grep -oE '"browser_download_url":"[^"]*"' | head -1 | sed -E 's/"browser_download_url":"(.*)"/\1/' || true)"
[ -n "$digest" ] && [ -n "$dl_url" ] || fail "解析 Release 元数据失败"
say "  版本资产   : ${name}"
say "  官方 sha256: ${digest}"

# ── ③ 本地缓存判断：已下载且哈希一致 → 跳过；缺失 / 不一致 → 重新下载 ──
LOCAL="$HOME/Downloads/$name"
if [ -f "$LOCAL" ]; then
  local_hash="$(shasum -a 256 "$LOCAL" | awk '{print $1}')"
  if [ "$local_hash" = "$digest" ]; then
    ok "本地已存在且哈希一致，跳过下载"
  else
    warn "本地哈希不一致（实际 ${local_hash:0:12}...）→ 重新下载"
    rm -f "$LOCAL"
    curl -fL --retry 3 --progress-bar -o "$LOCAL" "$dl_url" || fail "下载失败"
  fi
else
  say "本地未找到 $name → 开始下载"
  curl -fL --retry 3 --progress-bar -o "$LOCAL" "$dl_url" || fail "下载失败"
fi

# 下载后（或复用本地后）一律再校验一次 sha256
got="$(shasum -a 256 "$LOCAL" | awk '{print $1}')"
if [ "$got" != "$digest" ]; then
  rm -f "$LOCAL"
  fail "sha256 校验失败（实际 ${got:0:12}...，期望 ${digest:0:12}...）→ 已删除损坏文件，请重试"
fi
ok "sha256 校验通过"

# ── ④ 挂载 dmg ──
echo ""
say "${YELLOW}[1/4] 挂载 dmg ...${NC}"
attach_out="$(hdiutil attach -nobrowse -plist "$LOCAL" || true)"
mount_point="$(printf '%s' "$attach_out" | grep -A1 '<key>mount-point</key>' | grep '<string>' | sed -E 's/.*<string>(.*)<\/string>.*/\1/' | head -1 || true)"
[ -n "$mount_point" ] || fail "挂载 dmg 失败"
trap 'hdiutil detach "$mount_point" >/dev/null 2>&1 || true' EXIT
ok "已挂载: $mount_point"

SRC="$mount_point/$APP_NAME"
[ -d "$SRC" ] || fail "挂载卷中未找到 $APP_NAME"

# ── ⑤ 复制到应用程序 ──
say "${YELLOW}[2/4] 复制到【应用程序】...${NC}"
rm -rf "$DEST"
if ! cp -R "$SRC" "$DEST" 2>/dev/null; then
  warn "权限不足，改用管理员权限复制..."
  sudo cp -R "$SRC" "$DEST" || fail "复制失败（sudo 被取消或密码错误）"
fi

# ── ⑥ 清除隔离 + 重新签名 ──
say "${YELLOW}[3/4] 清除隔离标记 + 重新签名...${NC}"
xattr -cr "$DEST" 2>/dev/null || sudo xattr -cr "$DEST"
if ! command -v codesign >/dev/null 2>&1; then
  fail "缺少 codesign 工具，请先安装 Xcode 命令行工具：xcode-select --install"
fi
codesign --force --deep --sign - "$DEST" 2>/dev/null || sudo codesign --force --deep --sign - "$DEST"

# ── ⑦ 验证签名 + 启动 ──
say "${YELLOW}[4/4] 验证签名并启动...${NC}"
if codesign --verify --deep --strict "$DEST" >/dev/null 2>&1; then
  ok "签名验证通过"
else
  warn "签名有警告（仍尝试启动）"
fi
open "$DEST"
ok "安装完成，Clash Verge 已启动！"

echo ""
echo "如果仍提示「已损坏」，请打开："
echo "  系统设置 → 隐私与安全性 → 仍要打开"
