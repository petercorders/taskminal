# Taskminal 명령 표시 훅 — .zshrc 가 사용자 설정을 읽은 뒤 불러온다.
# OSC 133: A 프롬프트 · C 명령 시작 · D;코드 명령 끝, OSC 6973;cmd;<글자> 명령 글자.
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
__taskminal_precmd() {
  local ret=$?
  if [[ -n $__taskminal_running ]]; then
    builtin printf '\e]133;D;%s\a' "$ret"
    __taskminal_running=
  fi
  builtin printf '\e]133;A\a'
}
