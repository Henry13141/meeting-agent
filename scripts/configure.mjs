import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { configureLocalPaths } from './configuration.mjs';

try {
  const { values } = parseArgs({ args: process.argv.slice(2).filter((arg) => arg !== '--'), options: {
    'runtime-python': { type: 'string' }, 'asr-python': { type: 'string' },
    'asr-model': { type: 'string' },
  } });
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const overrides = {};
  for (const [flag, key] of [['runtime-python', 'runtimePython'], ['asr-python', 'asrPython'], ['asr-model', 'asrModelPath']]) {
    if (values[flag] !== undefined) overrides[key] = values[flag];
  }
  const result = await configureLocalPaths(root, overrides);
  console.log(JSON.stringify({ ...result,
    message: result.written ? '本机路径配置已保存。下一步执行 pnpm run doctor，再启动应用做实际录音和模型验证。'
      : '配置未写入。请由 Codex 补齐 missing 对应依赖或模型路径；不需要先接入云文档。',
    acceptance: '仅检查依赖文件，不代表真实录音、转写或模型验收通过',
  }, null, 2));
  if (!result.written) process.exitCode = 1;
} catch (error) {
  const code = /^LOCAL_CONFIG_[A-Z_]+$/.test(error.message || '') ? error.message : 'LOCAL_CONFIG_ARGUMENT_INVALID';
  console.error(JSON.stringify({ code, message: '请检查配置JSON及命令参数。已有配置未被覆盖；此文件只接受本机路径，不能放账号或密钥。' }));
  process.exitCode = 1;
}
