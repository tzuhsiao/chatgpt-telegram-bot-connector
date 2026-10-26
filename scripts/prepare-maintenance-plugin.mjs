import {readFile,writeFile,mkdir,cp,access} from 'node:fs/promises';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';

// Prepare an overlay for an already inspected, eligible App-backed plugin.
// No account lookup, upload, new plugin, connection or deployment occurs here.
const [source,output,...extra]=process.argv.slice(2);
if(!source||!output||extra.length) throw new Error('Usage: node scripts/prepare-maintenance-plugin.mjs <current-plugin-source> <new-private-output-directory>');
const input=resolve(source),target=resolve(output);
try {await access(target);throw new Error('Output directory must not exist.');} catch(error) {if(error.code!=='ENOENT')throw error;}
const manifest=JSON.parse(await readFile(resolve(input,'plugin.json'),'utf8'));
const match=/^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/.exec(manifest.version);
if(!manifest.name||!match) throw new Error('Expected a current portable manifest with a strict stable semantic version; reconcile other formats through the supported plugin workflow.');
if(manifest.skills!==undefined)throw new Error('Reconcile unsupported portable skill declarations before preparing an overlay.');
const next=BigInt(match[3])+1n;
manifest.version=`${match[1]}.${match[2]}.${next}`;
let overlay;
try {overlay=JSON.parse(await readFile(resolve(input,'.codex-plugin/plugin.json'),'utf8'));} catch(error) {if(error.code!=='ENOENT')throw error;}
if(overlay) {
  if(overlay.skills!==undefined)throw new Error('Reconcile custom legacy skill discovery paths before preparing an overlay.');
  if(overlay.name!==manifest.name)throw new Error('Manifest identity mismatch.');
  overlay.version=manifest.version;
}
await mkdir(target,{recursive:true});
await writeFile(resolve(target,'plugin.json'),JSON.stringify(manifest,null,2)+'\n');
if(overlay) {await mkdir(resolve(target,'.codex-plugin'));await writeFile(resolve(target,'.codex-plugin/plugin.json'),JSON.stringify(overlay,null,2)+'\n');}
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
await cp(resolve(root,'.agents/skills/telegram-maintenance'),resolve(target,'skills/telegram-maintenance'),{recursive:true});
console.log('Prepared maintenance skill overlay; inspect preservation, archive privately, and update only the verified existing plugin with its expected release ID.');
