import { expect, test } from 'vitest'
import {parseBrowserCommand,validBrowserCommand} from '../../src/shared/browser-automation'
test('browser CLI requires exact task/tab and snapshot-scoped refs',()=>{
 expect(parseBrowserCommand(['tabs','task','--json'])).toMatchObject({json:true,command:{action:'tabs',task:'task'}})
 expect(parseBrowserCommand(['snapshot','task'])).toHaveProperty('error')
 expect(parseBrowserCommand(['snapshot','task','--tab','tab','--json'])).toMatchObject({command:{tabId:'tab'}})
 expect(validBrowserCommand({action:'click',task:'task',tabId:'tab',ref:'r'+'a'.repeat(24)+':3'})).toBe(true)
 expect(validBrowserCommand({action:'click',task:'task',tabId:'tab',ref:'javascript:alert(1)'})).toBe(false)
 expect(parseBrowserCommand(['snapshot','task','--tab','one','--tab','two'])).toHaveProperty('error')
 expect(validBrowserCommand({action:'fill',task:'task',tabId:'tab',ref:'r'+'a'.repeat(24)+':1',value:'x'.repeat(100001)})).toBe(false)
})
