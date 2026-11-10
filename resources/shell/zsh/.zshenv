# Taskminal 셸 통합 — ZDOTDIR 을 이 폴더로 바꿔 띄운 zsh 가 읽는다.
# 사용자 설정(.zshenv · .zprofile · .zshrc · .zlogin)은 원래 ZDOTDIR(없으면 $HOME)에서 그대로 읽고,
# 마지막에 프롬프트 · 명령 시작/끝 표시(OSC 133)만 더한다. 끝나면 ZDOTDIR 을 원래대로 돌려놓는다.
# 앱은 사용자의 원래 ZDOTDIR 이 있었을 때만 TASKMINAL_USER_ZDOTDIR 로 넘긴다
__taskminal_zdotdir=$ZDOTDIR
__taskminal_had_zdotdir=${TASKMINAL_USER_ZDOTDIR:+1}
ZDOTDIR=${TASKMINAL_USER_ZDOTDIR:-$HOME}
[[ -r $ZDOTDIR/.zshenv ]] && builtin source $ZDOTDIR/.zshenv
# 사용자 .zshenv 가 ZDOTDIR 을 바꿨으면 그 값을 따른다
[[ $ZDOTDIR != ${TASKMINAL_USER_ZDOTDIR:-$HOME} ]] && __taskminal_had_zdotdir=1
TASKMINAL_USER_ZDOTDIR=$ZDOTDIR
ZDOTDIR=$__taskminal_zdotdir
