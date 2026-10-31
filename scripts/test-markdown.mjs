// Rendering and path contracts, without opening any applications or reading user files.
import assert from 'node:assert/strict';
import {createServer} from 'vite';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
globalThis.window={desk:{platform:'win32'}};
const vite=await createServer({server:{middlewareMode:true,ws:false},appType:'custom'});
try{
  const {linkTarget,markdownUrl}=await vite.ssrLoadModule('/src/lib/links.ts');
  const file=(href,cwd,platform)=>linkTarget(href,cwd,platform);
  assert.deepEqual(file('C:/project/файл.ts:12:3','','win32'),{kind:'file',path:'C:\\project\\файл.ts',line:12,column:3});
  assert.deepEqual(file('/C:/project/file.ts#L12-L15','','win32'),{kind:'file',path:'C:\\project\\file.ts',line:12,endLine:15});
  assert.deepEqual(file('file:///C:/project/a%20b.ts#L3','','win32'),{kind:'file',path:'C:\\project\\a b.ts',line:3});
  assert.deepEqual(file('file://server/share/a.ts#L8','','win32'),{kind:'file',path:'\\\\server\\share\\a.ts',line:8});
  assert.deepEqual(file('/home/me/project/file.rs:7:2','','linux'),{kind:'file',path:'/home/me/project/file.rs',line:7,column:2});
  assert.deepEqual(file('../src/main.rs#L4','/home/project/docs','linux'),{kind:'file',path:'/home/project/src/main.rs',line:4});
  assert.deepEqual(file('main.rs:4','/project','linux'),{kind:'file',path:'/project/main.rs',line:4});
  assert.deepEqual(file(markdownUrl('Makefile:12:2'),'/project','linux'),{kind:'file',path:'/project/Makefile',line:12,column:2});
  assert.deepEqual(file('a%23b.md','/project','linux'),{kind:'file',path:'/project/a#b.md'});
  assert.equal(file('#заголовок','/project','linux').kind,'anchor');
  assert.equal(file('mailto:dev@example.invalid').kind,'external');
  for(const href of ['javascript:alert(1)','data:text/html;base64,abcd','vbscript:1','cmd:whoami','file:///tmp/a%00.txt'])assert.equal(markdownUrl(href),'',href);
  for(const href of ['C:/project/main.rs:4','file:///C:/a.md','/home/me/a.md','./a.md#L3','https://example.invalid','#part'])assert.equal(markdownUrl(href),href);
  const {Markdown}=await vite.ssrLoadModule('/src/components/Markdown.tsx');
  const source='# Heading\n\n[Windows](<C:/project/a.ts:12:3>) [Linux](/home/me/a.ts#L2) [relative](a.ts:3) [section](#heading) [web](https://example.invalid) [bad](javascript:alert%281%29)';
  const html=renderToStaticMarkup(createElement(Markdown,{text:source}));
  assert.match(html,/href="C:\/project\/a.ts:12:3"/);assert.match(html,/href="\/home\/me\/a.ts#L2"/);assert.match(html,/href="a.ts%3A3"/);assert.match(html,/data-md-heading="heading"/);assert.doesNotMatch(html,/href="javascript:/);
  console.log('PASS Markdown Windows/Linux/UNC/file URLs, Unicode, line/column/ranges, heading anchors and blocked active content');
}finally{await vite.close()}
