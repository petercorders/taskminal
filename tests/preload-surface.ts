/**
 * renderer 에 여는 preload API 의 키 — 보안 기본값(좁은 API)의 허용 목록.
 * e2e `window.spec`(실제 renderer 에 노출된 것) 과 단위 `preload-surface.test`(preload 를 고친 턴 끝에 바로) 가 같이 본다.
 * preload 에 키를 더하거나 빼면 여기 한 곳을 고친다.
 */
export const PRELOAD_SURFACE = {
  apiKeys: ['remote', 'issues', 'worktrees', 'schedules', 'development', 'workflows', 'conversations', 'agentSessions', 'accounts', 'workspace', 'gitWorkflow', 'appInfo', 'pickFolder', 'onCommand', 'setQuitGuard', 'setBadge', 'beep', 'gitWorktreeAdd', 'gitBranches', 'openLink', 'setMenuKeys', 'filePath', 'pty', 'usage', 'sshHosts', 'scrollback', 'state', 'backup', 'redact', 'host', 'update', 'errlog', 'firstRunDone', 'history', 'inbox', 'chat', 'cli', 'review', 'ports', 'jira'],
  remote: ['connect','disconnect','workspaces','open','files','read','save','git','terminal','stream','resize','tail','write','stop','chat','send','history','answer','interrupt'],
  development: ['preview','prepare','preparations','cancel','inspect','install','extensions','enable','uninstall'],
  issues: ['list','configure','links','prepare','linkPr','close','repo'],
  worktrees: ['list','targets','create','open','remove','clean'],
  jira: ['status','save','clear','attach','transitions','transition','comment','writeState','refresh'],
  inbox: ['list','add','read','removeTask','clear'],
}

/** 키 목록까지 보는 묶음 이름 (apiKeys 를 뺀 것) */
export const PRELOAD_GROUPS = Object.keys(PRELOAD_SURFACE).filter((k) => k !== 'apiKeys')
