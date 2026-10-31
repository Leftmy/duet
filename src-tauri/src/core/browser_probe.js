(()=>{
 const changed=[...document.querySelectorAll('input,textarea,select')].some(e=>e.type==='checkbox'||e.type==='radio'?e.checked!==e.defaultChecked:e.tagName==='SELECT'?[...e.options].some((o,i)=>o.selected!==(o.defaultSelected||(!e.multiple&&i===0&&![...e.options].some(x=>x.defaultSelected)))):e.type==='file'?e.files?.length>0:e.value!==e.defaultValue);
 const media=[...document.querySelectorAll('audio,video')].some(e=>!e.paused&&!e.ended)||Boolean(document.pictureInPictureElement);
 return{url:location.href,title:document.title,x:scrollX,y:scrollY,dirty:changed||[...document.querySelectorAll('[contenteditable]:not([contenteditable=false])')].some(e=>Boolean(e.textContent?.trim()))||Boolean(window.__duetBrowserGuard?.dirty)||document.activeElement?.tagName==='IFRAME',media};
})()
