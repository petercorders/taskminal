ZDOTDIR=$TASKMINAL_USER_ZDOTDIR
# macOS /etc/zshrc 는 ZDOTDIR 이 이 폴더일 때 HISTFILE=${ZDOTDIR:-$HOME}/.zsh_history 를 정한다 → 사용자 쪽으로 되돌린다
[[ $HISTFILE == $__taskminal_zdotdir/.zsh_history ]] && HISTFILE=$ZDOTDIR/.zsh_history
[[ -r $ZDOTDIR/.zshrc ]] && builtin source $ZDOTDIR/.zshrc
ZDOTDIR=$__taskminal_zdotdir

if [[ -z ${__taskminal_hooked-} ]]; then
  __taskminal_hooked=1
  builtin source $__taskminal_zdotdir/taskminal-hooks.zsh
  # precmd 는 맨 앞에 — 다른 훅이 돌기 전의 $? 를 읽는다
  precmd_functions=(__taskminal_precmd ${precmd_functions[@]})
  preexec_functions+=(__taskminal_preexec)
fi
