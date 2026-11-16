# Taskminal 명령 표시 훅 — .zshrc 가 사용자 설정을 읽은 뒤 불러온다.
# OSC 133: A 프롬프트 · C 명령 시작 · D;코드 명령 끝, OSC 6973;cmd;<글자> 명령 글자, OSC 7 지금 폴더(file://호스트/경로).
# 명령 글자의 \ · ; · 제어 문자(0x01~0x1f · 0x7f)는 \xNN 으로 바꿔 보낸다 — 그대로 보내면 xterm 이 OSC 를 중간에 끊는다.
__taskminal_running=
__taskminal_preexec() {
  local c=${1//\\/\\\\} i ch
  c=${c//;/\\x3b}
  for i in {1..31} 127; do
    ch=${(#)i}
    [[ $c == *$ch* ]] && c=${c//$ch/\\x${(l:2::0:)$(( [##16] i ))}}
  done
  __taskminal_running=1
  builtin printf '\e]6973;cmd;%s\a\e]133;C\a' "$c"
}
# 폴더 경로를 바이트 단위로 퍼센트 인코딩 — 한글(UTF-8) · 공백 · ; · % · 제어 문자가 OSC 를 깨지 않게
__taskminal_cwd() {
  emulate -L zsh
  local LC_ALL=C p=$PWD out= i ch
  for (( i = 1; i <= ${#p}; i++ )); do
    ch=${p[i]}
    if [[ $ch == [A-Za-z0-9/._~-] ]]; then out+=$ch
    else builtin printf -v ch '%%%02X' "'$ch"; out+=$ch; fi  # -v: 글자마다 서브셸을 띄우지 않게
  done
  builtin printf '\e]7;file://%s%s\a' "$HOST" "$out"
}
__taskminal_precmd() {
  local ret=$?
  if [[ -n $__taskminal_running ]]; then
    builtin printf '\e]133;D;%s\a' "$ret"
    __taskminal_running=
  fi
  __taskminal_cwd
  builtin printf '\e]133;A\a'
}

# 51단계: 터미널에서 띄운 claude · codex 의 상태 훅. 앱이 변수를 줄 때만(설정 '에이전트 상태 알아내기') 감싼다.
# claude 는 이 실행에만 --settings(훅 → pane 기록 파일), codex 는 -c notify(턴 끝). 사용자 전역 설정은 건드리지 않는다.
# 사용자가 같은 이름의 alias · 함수를 두었으면 덮지 않는다. 하위 명령 · 이미 --settings 를 준 실행은 그대로 넘긴다.
# `function 이름 {` 으로 정의한다 — `이름() {` 은 읽을 때 사용자 alias 로 펼쳐져 구문 오류가 난다(조건이 거짓이어도 읽는다).
__taskminal_agent_exit() {
  [[ -n ${TASKMINAL_AGENT_EVENTS-} ]] || return 0
  { builtin printf 'v1\t%s\t%s\tTaskminalExit\t\n' "$(command date +%s)" "$1" >> "$TASKMINAL_AGENT_EVENTS"; } 2>/dev/null
}
# 감쌀 수 있나: 앱이 값을 줬고 사용자 alias · 함수가 없다(case 패턴은 사용자 sh_glob 같은 옵션에도 그대로 돈다)
__taskminal_agent_wrappable() {
  [[ -n $2 ]] || return 1
  case $(builtin whence -w $1) in (*alias|*function) return 1 ;; esac
  return 0
}
if __taskminal_agent_wrappable claude "${TASKMINAL_CLAUDE_SETTINGS-}"; then
  function claude {
    local a ret
    case ${1-} in
      (agents|attach|auth|auto-mode|config|doctor|gateway|import|install|kill|logs|mcp|migrate-installer|plugin|plugins|purge|respawn|rm|setup-token|stop|ultrareview|update|upgrade|-h|--help|-v|--version)
        command claude "$@"; return ;;
    esac
    for a in "$@"; do
      [[ $a == --settings || $a == --settings=* ]] && { command claude "$@"; return; }
    done
    command claude --settings "$TASKMINAL_CLAUDE_SETTINGS" "$@"
    ret=$?
    __taskminal_agent_exit claude
    return $ret
  }
fi
if __taskminal_agent_wrappable codex "${TASKMINAL_CODEX_NOTIFY-}"; then
  function codex {
    local ret
    case ${1-} in
      (agents|app|app-server|apply|archive|cloud|completion|debug|delete|doctor|exec-server|features|help|login|logout|mcp|mcp-server|migrate-nfs-db|migrate-rollouts|plugin|queue|remote-control|sandbox|unarchive|update|-h|--help|-V|--version)
        command codex "$@"; return ;;
    esac
    command codex -c "$TASKMINAL_CODEX_NOTIFY" "$@"
    ret=$?
    __taskminal_agent_exit codex
    return $ret
  }
fi
