import type { TaskInfo, TaskManager } from '../core/task-manager.js';
export const SAFE_TASK_NAMES=['world-tick','model-health','housekeeping'] as const;
export type SafeTaskName=typeof SAFE_TASK_NAMES[number];
export class TaskControlError extends Error{constructor(readonly code:'not_found'|'not_controllable'|'invalid_state'){super(code);this.name='TaskControlError';}}
export interface ControlledTask extends Omit<TaskInfo,'history'>{controlName:SafeTaskName;history:NonNullable<TaskInfo['history']>;}
/** Only maps server-registered names to current interval task ids; no callbacks leak into HTTP. */
export class TaskControlFacade{
 readonly #tasks:TaskManager;readonly #allowed:ReadonlySet<SafeTaskName>;
 constructor(input:{tasks:TaskManager;allowed?:readonly SafeTaskName[]}){this.#tasks=input.tasks;this.#allowed=new Set(input.allowed??SAFE_TASK_NAMES);}
 list():ControlledTask[]{return this.#tasks.list().flatMap(task=>{const controlName=this.#controlName(task.name);return controlName&&task.kind==='interval'?[this.#project(task,controlName)]:[];});}
 pause(id:string):ControlledTask{return this.#mutate(id,'pause');}
 resume(id:string):ControlledTask{return this.#mutate(id,'resume');}
 async runNow(id:string):Promise<ControlledTask>{const task=this.#checked(id);if(!await this.#tasks.runNow(id))throw new TaskControlError('invalid_state');return this.#project(this.#tasks.get(id)!,task.controlName);}
 #mutate(id:string,action:'pause'|'resume'):ControlledTask{const task=this.#checked(id);const ok=action==='pause'?this.#tasks.pause(id):this.#tasks.resume(id);if(!ok)throw new TaskControlError('invalid_state');return this.#project(this.#tasks.get(id)!,task.controlName);}
 #checked(id:string):ControlledTask{const task=this.#tasks.get(id);if(!task)throw new TaskControlError('not_found');const controlName=this.#controlName(task.name);if(!controlName||task.kind!=='interval')throw new TaskControlError('not_controllable');return this.#project(task,controlName);}
 #controlName(name:string):SafeTaskName|undefined{const legacy=name.replace(/:/g,'-');const matched=SAFE_TASK_NAMES.find(candidate=>name===candidate||name.endsWith(`:${candidate}`)||legacy===candidate||legacy.endsWith(`-${candidate}`));return matched&&this.#allowed.has(matched)?matched:undefined;}
 #project(task:TaskInfo,controlName:SafeTaskName):ControlledTask{return{...task,paused:task.paused??false,controlName,history:(task.history??[]).map(row=>({...row}))};}
}
