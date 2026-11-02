import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { resolveLocalPaths, inspectLocalPaths } from './configuration.mjs';
import { loadModelEnvironment } from '../apps/desktop/src/main/model-environment.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let config;
try { config = await resolveLocalPaths(root); }
catch { console.error(JSON.stringify({ configurationValid: false, message: '本机配置JSON无效，请交给Codex检查，现有文件未改动。' })); process.exit(1); }
const python = process.env.MEETING_AGENT_RUNTIME_PYTHON || config.runtimePython;
const asrPython = config.asrPython;
const exists = (p) => Boolean(p && fs.existsSync(p));
const report = { node: process.version, platform: process.platform, runtimePython: exists(python),
  asrPython: exists(asrPython), built: exists(path.join(root, 'apps/desktop/out/main/index.js')),
  modelEnvironmentValid: true, modelConfigured: false,
  modelFiles: (await inspectLocalPaths(root)).checks.asrModelPath,
  cloudDocumentsRequiredForFirstStep: false,
  acceptance: '仅检查配置和模块存在性；模型已配置不代表连通。真实麦克风、转写、模型问答和纪要须分别验证。' };
try {
  const model = await loadModelEnvironment(root);
  report.modelConfigured = Boolean(model.MEETING_AGENT_API_BASE?.trim() && model.MEETING_AGENT_MODEL?.trim());
} catch { report.modelEnvironmentValid = false; }
function modulesAvailable(executable, modules) {
  const check = spawnSync(executable, ['-B', '-c', `import importlib.util; print(all(importlib.util.find_spec(x) is not None for x in ${JSON.stringify(modules)}))`],
    { encoding: 'utf8', timeout: 10_000, env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot,
      WINDIR: process.env.WINDIR, TEMP: process.env.TEMP, TMP: process.env.TMP, PYTHONDONTWRITEBYTECODE: '1' } });
  return check.status === 0 && check.stdout.trim() === 'True';
}
report.runtimeDependencies = report.runtimePython && modulesAvailable(python, ['fastapi', 'httpx', 'uvicorn', 'mcp', 'yaml', 'jsonschema']);
report.asrDependencies = report.asrPython && modulesAvailable(asrPython, ['fastapi', 'funasr', 'torch', 'torchaudio']);
report.ffmpeg = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore', timeout: 10_000 }).status === 0;
console.log(JSON.stringify(report, null, 2));
if (!report.runtimeDependencies || !report.asrDependencies || !report.modelFiles || !report.ffmpeg || !report.modelEnvironmentValid) process.exitCode = 1;
