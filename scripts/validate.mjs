import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

// genealogy.js 是给浏览器直接加载的 classic script，用 vm 在隔离全局中读取。
const sandbox = {};
vm.runInNewContext(await readFile(path.join(ROOT, 'js', 'genealogy.js'), 'utf8'), sandbox);
const { countLineage, validateLineage } = sandbox.Genealogy;

async function readJson(relativePath) {
  return JSON.parse(await readFile(path.join(ROOT, relativePath), 'utf8'));
}

const manifest = await readJson('data/manifest.json');
const entries = Array.isArray(manifest.lineages) ? manifest.lineages : [];
if (!entries.length) throw new Error('manifest.json 中没有 lineages。');

let failed = false;
for (const meta of entries) {
  try {
    const data = await readJson(meta.file);
    validateLineage(data, meta.title || meta.id);
    const counts = countLineage(data);
    console.log(
      `✓ ${meta.id.padEnd(16)} ${String(counts.people).padStart(2)} 人 / ` +
        `${String(counts.generations).padStart(2)} 代 / ${String(counts.unions).padStart(2)} 组亲缘`
    );
  } catch (error) {
    failed = true;
    console.error(`✗ ${meta.id}: ${error.message}`);
  }
}

if (failed) process.exitCode = 1;
