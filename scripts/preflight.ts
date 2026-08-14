import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { ConfigLoader } from '../src/config/loader.js';
import { createNullLogger } from '../src/core/logger.js';
import { SqliteStorage } from '../src/storage/sqlite.js';
export interface PreflightResult{rootDir:string;nodeMajor:number;bots:number;storage:{driver:string;path:string;checked:boolean};writableDirectories:string[];}
const WRITABLE=['data','data/backups','data/runtime','logs']as const;
async function writable(dir:string){await fs.mkdir(dir,{recursive:true});const probe=path.join(dir,`.mohobot-write-probe-${process.pid}-${Date.now()}`);try{await fs.writeFile(probe,'',{flag:'wx',mode:0o600});}finally{await fs.rm(probe,{force:true});}}
export async function runPreflight(root=process.cwd(),nodeVersion=process.version):Promise<PreflightResult>{const rootDir=path.resolve(root);const nodeMajor=Number.parseInt(nodeVersion.replace(/^v/,'').split('.')[0]??'',10);if(!Number.isSafeInteger(nodeMajor)||nodeMajor<22)throw new Error(`Node.js 22 or newer is required; found ${nodeVersion}`);await fs.access(path.join(rootDir,'package-lock.json'));for(const relative of WRITABLE)await writable(path.join(rootDir,relative));const config=await new ConfigLoader({rootDir,logger:createNullLogger()}).load();if(config.bots.length===0)throw new Error('configuration resolved zero runnable bots');const storagePath=config.global.storage.path===':memory:'?':memory:':path.resolve(rootDir,config.global.storage.path);let checked=false;if(config.global.storage.driver==='sqlite'){const storage=new SqliteStorage({path:storagePath,logger:createNullLogger()});await storage.init();await storage.close();checked=true;}return{rootDir,nodeMajor,bots:config.bots.length,storage:{driver:config.global.storage.driver,path:storagePath,checked},writableDirectories:[...WRITABLE]};}
if(process.argv[1]&&path.resolve(process.argv[1])===path.resolve(fileURLToPath(import.meta.url))){runPreflight().then(r=>console.log(`Preflight passed: Node ${r.nodeMajor}, ${r.bots} bot(s), storage ${r.storage.driver}${r.storage.checked?' checked':''}.`)).catch((error:unknown)=>{console.error(`Preflight failed: ${error instanceof Error?error.message:String(error)}`);process.exitCode=1;});}
