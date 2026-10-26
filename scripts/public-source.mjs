import {readFile, readdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {resolve} from 'node:path';

// Public, repository-controlled inputs only. Never scan the checkout or env:
// private hosting manifests and generated artifacts must not influence this ID.
export async function publicSource(root) {
  const paths=['worker/index.js','drizzle/meta/_journal.json','scripts/public-source.mjs','scripts/build.mjs','.agents/skills/telegram-maintenance/SKILL.md'];
  for(const name of (await readdir(resolve(root,'drizzle'))).sort()) if(/^[0-9]+_[a-z0-9_]+\.sql$/.test(name)) paths.push('drizzle/'+name);
  const files={};
  for(const path of paths.sort()) files[path]=createHash('sha256').update((await readFile(resolve(root,path),'utf8')).replaceAll('\r\n','\n')).digest('hex');
  return {version:'sha256:'+createHash('sha256').update(JSON.stringify(files)).digest('hex'),files};
}
