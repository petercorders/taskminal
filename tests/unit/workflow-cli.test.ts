import { expect,test } from 'vitest'
import { parseArgs,isCliRequest } from '../../src/shared/cli'
test('workflow CLI parses quoted payloads and rejects malformed operation targets',()=>{
 expect(parseArgs(['workflow','view','--json'])).toMatchObject({kind:'request',json:true,req:{op:'workflow',action:'view'}})
 expect(parseArgs(['workflow','message','run',JSON.stringify({id:'msg',text:'message'})])).toMatchObject({kind:'request',req:{op:'workflow',runId:'run',input:{id:'msg',text:'message'}}})
 expect(parseArgs(['workflow','append','run','invalid'])).toMatchObject({kind:'usage'})
 expect(isCliRequest({op:'workflow',action:'answer',runId:'run',messageId:'q',text:'yes'})).toBe(true)
 expect(isCliRequest({op:'workflow',action:'unknown',runId:'run'})).toBe(false)
 expect(isCliRequest({op:'workflow',action:'answer',runId:'../',messageId:'q',text:'yes'})).toBe(false)
})
