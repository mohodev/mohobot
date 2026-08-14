import{createHash}from'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

export interface CharacterRecord {
  id: string;
  name: string;
  promptFile: string;
  prompt: string;
  tags: string[];
  source?: string;
  updatedAt: string;
  revision: string;
}

function idFromFile(file: string): string {
  return path.basename(file, path.extname(file)).toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff_-]+/g, '-');
}

export class CharacterCatalog {
  readonly #dir: string;
  constructor(rootDir: string) {
    this.#dir = path.join(rootDir, 'data', 'characters');
  }

  async list(): Promise<CharacterRecord[]> {
    await fs.mkdir(this.#dir, { recursive: true });
    const files = (await fs.readdir(this.#dir)).filter((f) => /\.(md|txt)$/i.test(f)).sort();
    const records: CharacterRecord[] = [];
    for (const file of files) {
      const full = path.join(this.#dir, file);
      const prompt = await fs.readFile(full, 'utf8');
      const stat = await fs.stat(full);
      const firstHeading = prompt.match(/^#\s+(.+)$/m)?.[1]?.trim();
      records.push({
        id: idFromFile(file),
        name: firstHeading ?? path.basename(file, path.extname(file)),
        promptFile: file,
        prompt,
        tags: [],
        updatedAt: stat.mtime.toISOString(),
        revision: createHash('sha256').update(prompt).digest('hex'),
      });
    }
    return records;
  }

  async get(id: string): Promise<CharacterRecord | undefined> {
    return (await this.list()).find((item) => item.id === id || item.promptFile === id);
  }

  async save(input: { id?: string; name: string; prompt: string; source?: string;expectedRevision?:string }): Promise<CharacterRecord> {
    const safe = (input.id ?? input.name).toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff_-]+/g, '-').replace(/^-|-$/g, '');
    if (!safe) throw new Error('character id is empty');
    if (input.prompt.trim().length < 20) throw new Error('character prompt is too short');
    if(input.expectedRevision!==undefined){const current=await this.get(safe);if(!current)throw new Error('character not found');if(current.revision!==input.expectedRevision)throw new Error('character revision conflict');}
    await fs.mkdir(this.#dir, { recursive: true });
    const file = `${safe}.md`;
    const body = input.prompt.startsWith('# ') ? input.prompt : `# ${input.name}\n\n${input.prompt.trim()}\n`;
    await fs.writeFile(path.join(this.#dir, file), body, 'utf8');
    return (await this.get(safe))!;
  }
}
