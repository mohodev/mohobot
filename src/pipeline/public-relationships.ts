import fs from 'node:fs/promises';
import path from 'node:path';

export interface PublicRelationship{leftId:string;leftName:string;rightId:string;rightName:string;relation:'friends'|'close_friends'|'collaborators';visibility:'public';updatedAt:string;}
function norm(value:string):string{return value.trim().toLowerCase();}
function valid(row:unknown):row is PublicRelationship{if(!row||typeof row!=='object'||Array.isArray(row))return false;const value=row as Record<string,unknown>;return typeof value.leftId==='string'&&typeof value.leftName==='string'&&typeof value.rightId==='string'&&typeof value.rightName==='string'&&['friends','close_friends','collaborators'].includes(String(value.relation))&&value.visibility==='public'&&typeof value.updatedAt==='string';}
/** Explicit public facts only. Affinity scores, DMs and memory never populate this store. */
export class PublicRelationshipStore{
 readonly #rows:PublicRelationship[];
 constructor(rows:PublicRelationship[]=[]){this.#rows=rows.filter(valid);}
 /** Missing file is an empty roster; malformed data fails closed rather than exposing any relation. */
 static async load(rootDir:string,botId?:string):Promise<PublicRelationshipStore>{try{const file=botId?path.join(rootDir,'data','bots',botId,'relationships','public.json'):path.join(rootDir,'data','relationships','public.json');const raw=JSON.parse(await fs.readFile(file,'utf8'));return new PublicRelationshipStore(Array.isArray(raw)?raw:[]);}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return new PublicRelationshipStore();return new PublicRelationshipStore();}}
 findNamed(text:string):PublicRelationship|undefined{return this.#rows.find(row=>text.includes(row.leftName)&&text.includes(row.rightName));}
 describe(text:string):string|undefined{const row=this.findNamed(text);if(!row)return undefined;const names=[row.leftName,row.rightName];if(row.relation==='close_friends')return`${names[0]}和${names[1]}关系很好`;
 if(row.relation==='friends')return`${names[0]}和${names[1]}是朋友`;
 return`${names[0]}和${names[1]}在一起做事`;
 }
 hasPerson(idOrName:string):boolean{const id=norm(idOrName);return this.#rows.some(row=>norm(row.leftId)===id||norm(row.rightId)===id||norm(row.leftName)===id||norm(row.rightName)===id);}
}
