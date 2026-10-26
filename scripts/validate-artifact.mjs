import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import {join} from 'node:path';
import {publicSource} from './public-source.mjs';
import {fileURLToPath} from 'node:url';
const source = await readFile(new URL('../dist/server/index.js',import.meta.url),'utf8');
const config = JSON.parse(await readFile(new URL('../dist/.openai/hosting.json',import.meta.url),'utf8'));
assert.equal(config.d1,'DB');
assert.ok(config.capabilities.includes('mcp'));
const module = await import('data:text/javascript;base64,'+Buffer.from(source).toString('base64'));
assert.equal(typeof module.default?.fetch,'function');
const response = await module.default.fetch(new Request('https://connector.example/mcp',{method:'POST',body:JSON.stringify({jsonrpc:'2.0',id:1,method:'server/discover'})}),{});
assert.deepEqual((await response.json()).result.supportedVersions,['2026-07-28']);
console.log('Artifact is valid ESM with working MCP discovery.');

const root=fileURLToPath(new URL('..',import.meta.url));
const publicRecord=JSON.parse(await readFile(new URL('../dist/public-source.json',import.meta.url),'utf8'));
assert.deepEqual(publicRecord,await publicSource(root));
const denied=await module.default.fetch(new Request('https://connector.example/mcp',{method:'POST',body:JSON.stringify({jsonrpc:'2.0',id:2,method:'tools/call',params:{name:'get_connector_status'}})}),{});
const diagnostic=(await denied.json()).error.data.diagnostics;
assert.equal(diagnostic.source_version,publicRecord.version);
assert.match(diagnostic.source_version,/^sha256:[a-f0-9]{64}$/);
assert.equal(diagnostic.category,'permission');
async function skillTree(directory) {
  const files={};
  for(const entry of await readdir(directory,{withFileTypes:true})) {
    if(entry.isDirectory())for(const [path,bytes] of Object.entries(await skillTree(join(directory,entry.name))))files[entry.name+'/'+path]=bytes;
    else {assert.ok(entry.isFile(),'Skill payload must contain regular files only.');files[entry.name]=await readFile(join(directory,entry.name));}
  }
  return files;
}
assert.deepEqual(await skillTree(join(root,'dist/plugin-skills/skills/telegram-maintenance')),await skillTree(join(root,'.agents/skills/telegram-maintenance')));
assert.deepEqual(await readdir(join(root,'dist/plugin-skills/skills')),['telegram-maintenance']);
console.log('Public source fingerprint and canonical-plugin skill payload verified.');
