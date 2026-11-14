export interface BrowserCommand {
  task: string
  tabId?: string
  action: 'tabs' | 'navigate' | 'snapshot' | 'click' | 'fill' | 'screenshot'
  url?: string
  ref?: string
  value?: string
  expectUrl?: string
}
const id = (v: unknown): v is string => typeof v === 'string' && /^[\w-]{1,100}$/.test(v)
export function validBrowserCommand(value: unknown): value is BrowserCommand {
  if(!value||typeof value!=='object')return false
  const v=value as BrowserCommand
  if(!id(v.task)||!['tabs','navigate','snapshot','click','fill','screenshot'].includes(v.action))return false
  if(v.action!=='tabs'&&!id(v.tabId))return false
  if(v.expectUrl!==undefined&&(typeof v.expectUrl!=='string'||v.expectUrl.length>4096))return false
  if(v.action==='navigate'&&(typeof v.url!=='string'||v.url.length>4096))return false
  if(['click','fill'].includes(v.action)&&(typeof v.ref!=='string'||!/^r[a-f0-9]{24}:\d{1,3}$/.test(v.ref)))return false
  return v.action!=='fill'||(typeof v.value==='string'&&v.value.length<=100000)
}
export function parseBrowserCommand(args: string[]): { command: BrowserCommand; json: boolean } | { error: string } {
  const action=args[0] as BrowserCommand['action'],task=args[1]
  const options:Record<string,string>={};let json=false
  for(let i=2;i<args.length;i++){
    const flag=args[i]!
    if(flag==='--json'){json=true;continue}
    if(!['--tab','--url','--ref','--value','--expect-url'].includes(flag)||args[i+1]===undefined||flag in options)return {error:'browser 옵션과 값을 확인해 주세요'}
    options[flag]=args[++i]!
  }
  const command={action,task,tabId:options['--tab'],url:options['--url'],ref:options['--ref'],value:options['--value'],expectUrl:options['--expect-url']} as BrowserCommand
  return validBrowserCommand(command)?{command,json}:{error:'browser <tabs|navigate|snapshot|click|fill|screenshot> <일감 ID> --tab <탭 ID> [--url|--ref|--value|--expect-url 값]'}
}
