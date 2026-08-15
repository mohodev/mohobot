export interface PublicRelationship{leftId:string;leftName:string;rightId:string;rightName:string;relation:'friends'|'close_friends'|'collaborators';visibility:'public';updatedAt:string;}
function norm(value:string):string{return value.trim().toLowerCase();}
/** Explicit public facts only. Affinity scores, DMs and memory never populate this store. */
export class PublicRelationshipStore{
 readonly #rows:PublicRelationship[];
 constructor(rows:PublicRelationship[]=[]){this.#rows=rows.filter(row=>row.visibility==='public');}
 findNamed(text:string):PublicRelationship|undefined{return this.#rows.find(row=>text.includes(row.leftName)&&text.includes(row.rightName));}
 describe(text:string):string|undefined{const row=this.findNamed(text);if(!row)return undefined;const names=[row.leftName,row.rightName];if(row.relation==='close_friends')return`${names[0]}和${names[1]}关系很好`;
 if(row.relation==='friends')return`${names[0]}和${names[1]}是朋友`;
 return`${names[0]}和${names[1]}在一起做事`;
 }
 hasPerson(idOrName:string):boolean{const id=norm(idOrName);return this.#rows.some(row=>norm(row.leftId)===id||norm(row.rightId)===id||norm(row.leftName)===id||norm(row.rightName)===id);}
}
