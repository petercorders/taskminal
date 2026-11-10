ZDOTDIR=$TASKMINAL_USER_ZDOTDIR
[[ -r $ZDOTDIR/.zlogin ]] && builtin source $ZDOTDIR/.zlogin
# 이 셸 안에서 띄우는 zsh 는 사용자 설정을 바로 읽게 원래 ZDOTDIR 로 (원래 없었으면 지운다)
if [[ -n $__taskminal_had_zdotdir ]]; then ZDOTDIR=$TASKMINAL_USER_ZDOTDIR; else unset ZDOTDIR; fi
unset __taskminal_zdotdir __taskminal_had_zdotdir TASKMINAL_USER_ZDOTDIR
