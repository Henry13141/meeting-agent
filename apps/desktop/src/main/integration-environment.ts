import { lstat, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';

const ENVIRONMENT_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;

/** Only configured env references cross the owner bootstrap; never dump process.env. */
export async function integrationEnvironment(root: string, environment: NodeJS.ProcessEnv): Promise<Record<string, string>> {
  try {
    const canonicalRoot = await realpath(root);
    const directory = path.join(canonicalRoot, '.agent');
    if (await realpath(directory) !== directory) return {};
    const file = path.join(directory, 'extensions.json');
    const info = await lstat(file);
    if (!info.isFile() || info.size > 262_144) return {};
    const config = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>;
    if (config.schemaVersion !== 1 || !Array.isArray(config.servers) || config.servers.length > 16) return {};
    const result: Record<string, string> = {};
    for (const server of config.servers) {
      if (!server || typeof server !== 'object' || server.enabled !== true) continue;
      for (const refs of [server.env, server.headers]) {
        if (!refs || typeof refs !== 'object' || Array.isArray(refs)) continue;
        for (const reference of Object.values(refs)) {
          if (!reference || typeof reference !== 'object' || Array.isArray(reference)) continue;
          const name = (reference as Record<string, unknown>).env;
          if (typeof name !== 'string' || !ENVIRONMENT_NAME.test(name)) continue;
          const value = environment[name];
          if (typeof value === 'string' && value.length <= 8_192 && !/[\r\n\0]/.test(value)) result[name] = value;
        }
      }
    }
    if (Object.keys(result).length > 64 || Buffer.byteLength(JSON.stringify(result)) > 65_536) return {};
    return result;
  } catch {
    // Runtime reports invalid/missing extension config separately; capture remains usable.
    return {};
  }
}
