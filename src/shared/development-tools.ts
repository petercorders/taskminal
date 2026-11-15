export interface EnvironmentPlan {root:string;target:string;signature:string;copies:Array<{path:string;size:number;exists:boolean}>;commands:Array<{file:string;args:string[]}>}
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
