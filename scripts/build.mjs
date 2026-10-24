import {mkdir, readFile, writeFile, cp, access} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';

const root = fileURLToPath(new URL('..',import.meta.url));
const has = async path => {try {await access(path); return true;} catch {return false;}};
const manifest = resolve(root,'.openai/hosting.json');
const source = await readFile(await has(manifest)?manifest:resolve(root,'.openai/hosting.example.json'),'utf8');
const config = JSON.parse(source);
if (config.d1 !== 'DB' || !config.capabilities?.includes('mcp')) throw new Error('The connector requires the DB binding and MCP capability.');
await mkdir(resolve(root,'dist/server'),{recursive:true});
await mkdir(resolve(root,'dist/.openai'),{recursive:true});
await cp(resolve(root,'worker/index.js'),resolve(root,'dist/server/index.js'));
await writeFile(resolve(root,'dist/.openai/hosting.json'),JSON.stringify(config,null,2)+'\n');
if (await has(resolve(root,'drizzle'))) await cp(resolve(root,'drizzle'),resolve(root,'dist/.openai/drizzle'),{recursive:true});
console.log('Built Worker artifact. Deployment identity remains local.');
