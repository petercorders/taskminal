/** links(62단계): 복사하지 않고 원본을 가리키는 링크로 만들 경로 — exists 면 건드리지 않는다(state: 같은 원본을 가리키는 링크 linked · 다른 것 kept) */
export interface EnvironmentPlan {root:string;target:string;signature:string;copies:Array<{path:string;size:number;exists:boolean}>;links:Array<{path:string;exists:boolean;state?:'linked'|'kept'}>;commands:Array<{file:string;args:string[]}>}
export interface Preparation {id:string;root:string;target:string;signature:string;state:'running'|'done'|'failed'|'unknown'|'stopped';log:string}
export interface ExtensionManifest {id:string;name:string;version:string;panels:Array<{id:string;title:string;body:string}>;commands:Array<{id:string;title:string;url:string}>}
export interface InstalledExtension {manifest:ExtensionManifest;signature:string;enabled:boolean}
export interface ExtensionPreview {path:string;signature:string;manifest:ExtensionManifest}
export interface DevelopmentApi {
 preview(root:string,target:string):Promise<EnvironmentPlan>
 prepare(root:string,plan:EnvironmentPlan,requestId:string):Promise<Preparation>
 preparations(root:string):Promise<Preparation[]>
 cancel(root:string,id:string):Promise<void>
 inspect(root:string,path:string):Promise<ExtensionPreview>
 install(root:string,preview:ExtensionPreview):Promise<void>
 extensions(root:string):Promise<InstalledExtension[]>
 enable(root:string,id:string,enabled:boolean):Promise<void>
 uninstall(root:string,id:string):Promise<void>
}

/** 56단계: 환경 준비 미리보기의 명령 한 줄 — 셸 없이 실행하는 프로그램 · 인자를 셸 꼴로 보인다(신뢰 확인 화면).
 *  공백 · 따옴표 · 셸 글자가 든 인자 · 빈 인자는 작은따옴표로, 안 보이거나 공백처럼 보이는 글자(제어 · 서식 · 방향 바꿈 · 폭 없음 · 태그 ·
 *  공백 닮은 글자 · 이음 선택자 · 채움 글자 · 할당 안 된 글자)는 \u{…} 로 드러낸다 — 보통 공백(U+0020)은 따옴표로 경계를 보인다 */
const HIDDEN = /[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Cn}\p{Zl}\p{Zp}\u00a0\u1680\u2000-\u200a\u202f\u205f\u3000\u034f\u115f\u1160\u17b4\u17b5\u180b-\u180f\u2800\u3164\uffa0\ufe00-\ufe0f\u{e0100}-\u{e01ef}]/gu
function shownWord(raw: string): string {
  const shown = raw.replace(HIDDEN, (ch) => `\\u{${ch.codePointAt(0)!.toString(16).padStart(4, '0')}}`)
  if (shown === raw && /^[\w@%+=:,./-]+$/u.test(raw)) return raw
  return `'${shown.replace(/'/g, `'\\''`)}'`
}
export function commandLine(command: { file: string; args: readonly string[] }): string {
  return [command.file, ...command.args].map(shownWord).join(' ')
}

/** 62단계: 환경 준비 미리보기의 링크 한 줄 — 링크는 워크트리에서 고치면 원본도 바뀐다는 것을 상태 옆에 보인다.
 *  대상에 다른 것이 이미 있으면 건드리지 않아 원본과 무관하므로 그 말을 붙이지 않는다 */
export function linkLine(link: EnvironmentPlan['links'][number]): string {
  if (!link.exists) return `${link.path} · 원본에 연결 · 원본과 함께 바뀌어요`
  return link.state === 'linked' ? `${link.path} · 이미 연결됨 · 원본과 함께 바뀌어요` : `${link.path} · 기존 것 보존`
}
