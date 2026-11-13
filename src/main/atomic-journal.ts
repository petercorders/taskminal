import { mkdirSync, readSync, openSync, constants, fstatSync, fchmodSync, writeFileSync, fsyncSync, closeSync, renameSync, rmSync } from 'node:fs'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
/** Local durable state: fail closed on corrupt/oversized files and never overwrite them. */
export class AtomicJournal<T> {
 private failure=''
 constructor(private readonly file:string,private readonly valid:(v:unknown)=>v is T){}
 load(fallback:T):T{
  try{
   const fd=openSync(this.file,constants.O_RDONLY|constants.O_NOFOLLOW)
   let bytes:Buffer
   try{
    if(!fstatSync(fd).isFile()||fstatSync(fd).size>10*1024*1024)throw new Error('기록 크기 제한')
    bytes=Buffer.alloc(10*1024*1024+1)
    let size=0,n=0
    do{n=readSync(fd,bytes,size,bytes.length-size,null);size+=n}while(n>0&&size<bytes.length)
    if(size>10*1024*1024)throw new Error('기록 크기 제한')
    bytes=bytes.subarray(0,size)
   }finally{closeSync(fd)}
   const value:unknown=JSON.parse(bytes.toString('utf8'))
   if(!this.valid(value))throw new Error('기록 형식')
   return value
  }catch(e){
   if((e as NodeJS.ErrnoException).code==='ENOENT')return fallback
   this.failure='기록 파일을 읽지 못했어요. 원본을 보존했으며 자동으로 덮어쓰지 않아요.'
   throw new Error(this.failure)
  }
 }
 save(value:T){
  if(this.failure)throw new Error(this.failure)
  if(!this.valid(value))throw new Error('저장할 기록을 확인해 주세요')
  const bytes=JSON.stringify(value)
  if(Buffer.byteLength(bytes)>10*1024*1024)throw new Error('기록 크기 제한')
  const dir=dirname(this.file),tmp=this.file+'.'+randomUUID()+'.tmp'
  mkdirSync(dir,{recursive:true,mode:0o700})
  try{
   const fd=openSync(tmp,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600)
   try{fchmodSync(fd,0o600);writeFileSync(fd,bytes);fsyncSync(fd)}finally{closeSync(fd)}
   renameSync(tmp,this.file)
   if(process.platform!=='win32'){const folder=openSync(dir,'r');try{fsyncSync(folder)}finally{closeSync(folder)}}
  }catch{try{rmSync(tmp,{force:true})}catch{};throw new Error('기록을 저장하지 못해 실행을 멈췄어요.')}
 }
}
