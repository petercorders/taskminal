// Runs only in an isolated browser world. No Node, preload, or application API is exposed.
export function snapshotScript(nonce: string) {
  return `(() => {
    const nodes = [...document.querySelectorAll('a,button,input,textarea,select,[role="button"],[role="link"],[contenteditable="true"]')]
      .filter(n => n.getClientRects().length && !n.closest('input[type="password"],input[type="hidden"],input[type="file"]')).slice(0,150);
    globalThis.__taskminalAutomation = { nonce: ${JSON.stringify(nonce)}, nodes };
    const scrub = (node) => {
      const clone = node?.cloneNode(true);
      if (clone?.matches?.('input,textarea,select,[contenteditable],iframe,object,embed')) return '';
      clone?.querySelectorAll?.('script,style,input,textarea,select,[contenteditable],iframe,object,embed').forEach(n => n.remove());
      return clone?.textContent || '';
    };
    const text = scrub(document.body);
    return {title:document.title, text:text.replace(/\\s+/g,' ').slice(0,12000), elements:nodes.map((n,i)=>({
      ref:${JSON.stringify(nonce)}+':'+i, role:n.getAttribute('role')||n.tagName.toLowerCase(),
      label:(n.getAttribute('aria-label')||n.getAttribute('placeholder')||scrub(n.labels?.[0])||(n.matches('input,textarea,select,[contenteditable]')?'':scrub(n))||'').trim().slice(0,160),
      disabled:!!n.disabled
    }))};
  })()`
}
export function interactionScript(nonce: string, index: number, action: 'click'|'fill', value = '') {
  return `(() => {
    const state=globalThis.__taskminalAutomation;
    if(!state||state.nonce!==${JSON.stringify(nonce)})throw Error('snapshot이 바뀌었어요');
    const node=state.nodes[${index}];
    if(!node?.isConnected||!node.getClientRects().length||node.disabled)throw Error('요소가 사라졌거나 비활성 상태예요');
    if(${JSON.stringify(action)}==='click'){node.click();return {acted:true};}
    if(node.matches('input[type="password"],input[type="file"],input[type="hidden"]')||node.readOnly)throw Error('이 입력칸은 자동 입력할 수 없어요');
    if(node instanceof HTMLInputElement||node instanceof HTMLTextAreaElement){
      const proto=node instanceof HTMLInputElement?HTMLInputElement.prototype:HTMLTextAreaElement.prototype;
      Object.getOwnPropertyDescriptor(proto,'value').set.call(node,${JSON.stringify(value)});
    }else if(node.isContentEditable){node.textContent=${JSON.stringify(value)};}else throw Error('텍스트 입력칸을 골라 주세요');
    node.dispatchEvent(new Event('input',{bubbles:true}));node.dispatchEvent(new Event('change',{bubbles:true}));return {acted:true};
  })()`
}

// CDP resolves each target into a fresh isolated world. Inline important wins
// over page styles; opacity also hides descendants that override visibility.
export const maskNodeFunction = `function() {
  if (!(this instanceof Element)) throw Error('Cannot mask this node');
  const style = this.getAttribute('style');
  try {
    this.style.setProperty('transition', 'none', 'important');
    this.style.setProperty('animation', 'none', 'important');
    this.style.setProperty('visibility', 'hidden', 'important');
    this.style.setProperty('opacity', '0', 'important');
    if (getComputedStyle(this).opacity !== '0') throw Error('Input masking failed');
    return {style};
  } catch (error) {
    if (style === null) this.removeAttribute('style'); else this.setAttribute('style', style);
    throw error;
  }
}`
export const restoreNodeFunction = `function(style) {
  if (style === null) this.removeAttribute('style');
  else this.setAttribute('style', style);
}`
