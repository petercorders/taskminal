#!/usr/bin/env bash
# 앱 아이콘: resources/icon/icon.svg → resources/icon/icon.png(1024, 개발 Dock) · resources/icon/icon.icns(패키징) — 만든 파일도 커밋한다
# macOS 기본 도구만 쓴다: qlmanage(SVG → PNG, 투명 유지) · sips(크기) · iconutil(.icns).
#   bash scripts/build-icon.sh
set -euo pipefail
root=$(cd "$(dirname "$0")/.." && pwd)
src="$root/resources/icon/icon.svg"
out="$root/resources/icon"
work=$(mktemp -d)
trap 'rm -r "$work"' EXIT
mkdir -p "$out"

qlmanage -t -s 1024 -o "$work" "$src" >/dev/null 2>&1
png="$work/icon.svg.png"
[ -f "$png" ] || { echo "qlmanage 가 PNG 를 만들지 못함: $src" >&2; exit 1; }
size=$(sips -g pixelWidth "$png" | awk '/pixelWidth/ {print $2}')
alpha=$(sips -g hasAlpha "$png" | awk '/hasAlpha/ {print $2}')
[ "$size" = 1024 ] && [ "$alpha" = yes ] || { echo "PNG 가 1024 투명이 아님 (폭 $size · 투명 $alpha)" >&2; exit 1; }

set_dir="$work/icon.iconset"
mkdir "$set_dir"
for s in 16 32 128 256 512; do
  sips -z $s $s "$png" --out "$set_dir/icon_${s}x${s}.png" >/dev/null
  d=$((s * 2))
  sips -z $d $d "$png" --out "$set_dir/icon_${s}x${s}@2x.png" >/dev/null
done
iconutil -c icns "$set_dir" -o "$out/icon.icns"
cp "$png" "$out/icon.png"
echo "resources/icon/icon.icns · icon.png ($(du -h "$out/icon.icns" | cut -f1))"
