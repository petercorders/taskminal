ZDOTDIR=$TASKMINAL_USER_ZDOTDIR
[[ -r $ZDOTDIR/.zshrc ]] && builtin source $ZDOTDIR/.zshrc
ZDOTDIR=$__taskminal_zdotdir

# ─── 명령 표시 (OSC 133: A 프롬프트 · C 명령 시작 · D;코드 명령 끝) + 명령 글자(OSC 6973;cmd) ───
if [[ -z ${__taskminal_hooked-} ]]; then
  __taskminal_hooked=1
  __taskminal_running=
  __taskminal_preexec() {
    local c=${1//\\/\\\\}
    c=${c//;/\\x3b}; c=${c//$'\n'/\\x0a}; c=${c//$'\a'/\\x07}; c=${c//$'\e'/\\x1b}
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
  # precmd 는 맨 앞에 — 다른 훅이 돌기 전의 $? 를 읽는다
  precmd_functions=(__taskminal_precmd ${precmd_functions[@]})
  preexec_functions+=(__taskminal_preexec)
fi
