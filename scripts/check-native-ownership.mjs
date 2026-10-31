import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
const root=fileURLToPath(new URL('../',import.meta.url));
const source=new Map();
function scan(dir){
  for(const entry of fs.readdirSync(dir,{withFileTypes:true})){
    const file=path.join(dir,entry.name);
    if(entry.isDirectory())scan(file);
    else if(entry.name.endsWith('.mjs')){
      const text=fs.readFileSync(file,'utf8');
      for(const match of text.matchAll(/\b(?:handle|own)\(\s*(['"])([^'"]+)\1/g)){
        const files=source.get(match[2])||new Set();files.add(path.relative(root,file).replaceAll('\\','/'));source.set(match[2],files);
      }
    }
  }
}
scan(path.join(root,'electron'));
const rust=fs.readFileSync(path.join(root,'src-tauri/src/core/mod.rs'),'utf8');
const native=[...rust.match(/pub const CHANNELS:[\s\S]*?=\s*&\[([\s\S]*?)\];/)[1].matchAll(/"([^"]+)"/g)].map(m=>m[1]);
const rustModule=channel=>channel==='desk:history-context'?'core/history.rs':channel.startsWith('cmd:')||channel.startsWith('instr:')?'core/config.rs':channel.startsWith('sched:')?'core/scheduler.rs':channel.startsWith('tg:')?'core/telegram.rs':channel.startsWith('pr:')?'core/pr.rs':channel.startsWith('stats:')?'core/stats.rs':channel.startsWith('agent:')&&/listSessions|loadSession|loadSubagent|segments/.test(channel)?'core/history.rs':channel.startsWith('agent:')||channel.startsWith('mcp:')||['desk:codex','desk:switch-provider','desk:summarize','desk:release','desk:skills','app:commitMessage'].includes(channel)?'core/agents.rs':channel.startsWith('search:')?'core/search.rs':channel.startsWith('term:')?'core/terminal.rs':channel.startsWith('app:git')||channel.startsWith('wt:')?'core/git.rs':channel==='fs:index'?'core/project_index.rs':['app:getSettings','app:setSettings'].includes(channel)?'core/storage.rs':['desk:native-core','app:pathExists'].includes(channel)?'core/mod.rs':channel.startsWith('files:')||channel.startsWith('fs:')?'core/files.rs':'core/desktop.rs';
for(const channel of native)if(!source.has(channel))source.set(channel,new Set());
const expected={version:1,target:'rust',channels:[...source].sort(([a],[b])=>a.localeCompare(b,'en')).map(([channel,files])=>({
  channel,owner:native.includes(channel)?'rust':'node-legacy',legacySources:[...files].sort(),
  ...(native.includes(channel)?{rustModule:rustModule(channel)}:{}),
}))};
const file=path.join(root,'desktop/ipc-ownership.json');
if(process.argv.includes('--write'))fs.writeFileSync(file,JSON.stringify(expected,null,2)+'\n');
assert.deepEqual(JSON.parse(fs.readFileSync(file,'utf8')),expected,'IPC ownership manifest is stale; update it with node scripts/check-native-ownership.mjs --write');
assert.equal(new Set(native).size,native.length,'Duplicate native IPC channel');
console.log(`IPC ownership: ${native.length} Rust / ${expected.channels.length-native.length} legacy Node commands`);
