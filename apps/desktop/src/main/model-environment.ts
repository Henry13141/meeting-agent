import { readFile, lstat } from 'node:fs/promises';
import path from 'node:path';

const KEYS = new Set(['MEETING_AGENT_API_BASE', 'MEETING_AGENT_API_KEY', 'MEETING_AGENT_MODEL']);

/** A literal, bounded data file. Never execute shell expansion or evaluate its content. */
export function parseModelEnvironment(text: string): NodeJS.ProcessEnv {
  if (Buffer.byteLength(text) > 16_384) throw new Error('MODEL_ENV_INVALID');
  const values: NodeJS.ProcessEnv = {};
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const match = /^([A-Z_]+)\s*=\s*(.*)$/.exec(trimmed);
    if (!match || !KEYS.has(match[1]!) || Object.hasOwn(values, match[1]!)) throw new Error('MODEL_ENV_INVALID');
    let value = match[2]!;
    if (/^["']/.test(value)) {
      if (value.length < 2 || value.at(-1) !== value[0]) throw new Error('MODEL_ENV_INVALID');
      value = value.slice(1, -1);
    }
    if (/[\0\r\n]/.test(value) || value.length > 4_096) throw new Error('MODEL_ENV_INVALID');
    values[match[1]!] = value;
  }
  return values;
}

export async function loadModelEnvironment(root: string, environment: NodeJS.ProcessEnv = process.env): Promise<NodeJS.ProcessEnv> {
  const file = path.join(root, '.env.local');
  let values: NodeJS.ProcessEnv = {};
  try {
    const info = await lstat(file);
    if (!info.isFile() || info.size > 16_384) throw new Error('MODEL_ENV_INVALID');
    values = parseModelEnvironment(await readFile(file, 'utf8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('MODEL_ENV_INVALID');
  }
  return { ...values, ...environment };
}
