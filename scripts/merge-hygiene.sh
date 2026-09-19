#!/usr/bin/env bash
#
# merge-hygiene.sh — 列出「混合体」文件：既不是 fork 基线、也不是官方版本的第三种内容。
#
# 自动三方合并会产出这种文件。它们能编译、不报错，但语义是错的，是历次合并
# 出问题的主要来源（详见 docs/merge-notes.md 第 2 节）。合并后第一件事就是跑它。
#
#   bash scripts/merge-hygiene.sh              # 默认：跳过文档/清单/lockfile
#   FORCE=1 bash scripts/merge-hygiene.sh      # 全量，含被跳过的那几类
#   PKG=packages/client bash scripts/merge-hygiene.sh   # 只看某个子树
#
# 判定：current != fork && current != official && fork != official
# 默认排除（仍是混合体，只是不需要人工裁决）：
#   *.md  *.i18n.yaml  package.json  pnpm-lock.yaml  bun.lock
set -uo pipefail

FORK=${FORK:-ee6950e87c}                     # fork 基线；tag backup/pre-merge-official-882-20260918
OFFICIAL=${OFFICIAL:-origin/master}
PKG=${PKG:-}

cd "$(git rev-parse --show-toplevel)" || exit 1

md5_of() { git show "$1:$2" 2>/dev/null | md5 -q 2>/dev/null || md5sum 2>/dev/null | cut -d' ' -f1; }

skipped=0
count=0
declare -a hits=()

# 文件清单以 fork 基线为准：fork 没有的文件不是"混合体"，是官方新增。
while IFS= read -r f; do
  case "$f" in
    *.md|*.i18n.yaml|package.json|pnpm-lock.yaml|bun.lock)
      [ "${FORCE:-0}" = "1" ] || { skipped=$((skipped + 1)); continue; } ;;
  esac

  [ -f "$f" ] || continue                    # 本地删除了该文件：不属于混合体

  fork_md5=$(git show "$FORK:$f" 2>/dev/null | md5 -q 2>/dev/null)
  up_md5=$(git show "$OFFICIAL:$f" 2>/dev/null | md5 -q 2>/dev/null)
  cur_md5=$(md5 -q "$f" 2>/dev/null)

  [ -n "$fork_md5" ] && [ -n "$up_md5" ] || continue
  [ "$fork_md5" = "$up_md5" ] && continue     # 两边一致：没有冲突可言
  [ "$cur_md5" = "$fork_md5" ] && continue     # 已是 fork 内容：合规
  [ "$cur_md5" = "$up_md5" ] && continue       # 已是官方内容：由 fork-delta 规则处理，不是混合体

  hits+=("$f"); count=$((count + 1))
done < <(git ls-tree -r "$FORK" --name-only ${PKG:+-- "$PKG"})

if [ "$count" -eq 0 ]; then
  echo "merge-hygiene: 未发现混合体（已跳过 $skipped 个文档/清单文件）。"
  exit 0
fi

echo "merge-hygiene: $count 个混合体文件（跳过 $skipped 个文档/清单文件）"
echo "全部裁决完成前不要认为合并可用。裁决顺序见 docs/merge-notes.md 第 2 节。"
echo
printf '%s\n' "${hits[@]}" | awk '
  { n = split($0, seg, "/")
    pkg = (n >= 3) ? seg[1] "/" seg[2] : (n == 2 ? seg[1] : "(repo root)")
    if (!(pkg in seen)) { seen[pkg] = 1; order[++count] = pkg }
    files[pkg] = files[pkg] "\n  " $0 }
  END { for (i = 1; i <= count; i++) { print order[i] files[order[i]] } }'
echo
echo "下一步：对每个文件 diff fork 与官方两个版本，按 fork-wins 裁决；"
echo "运行时语义文件取 fork 语义 + 只吸收官方明确的修复，样式/overlay 回退 fork。"
