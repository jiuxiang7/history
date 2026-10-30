import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const manifestPath = path.join(root, 'data', 'manifest.json');
const outputPath = path.join(root, 'data', 'lineages.js');

const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
const lineages = {};

for (const meta of manifest.lineages) {
  const filePath = path.join(root, meta.file);
  const lineage = JSON.parse(await readFile(filePath, 'utf8'));
  lineages[meta.id] = lineage;
  // 左侧「系谱」列表上的人数直接按数据算，避免 manifest 里手写的数字过期
  meta.peopleCount = Array.isArray(lineage.people) ? lineage.people.length : 0;
}

const header = [
  '/* 此文件由 scripts/build-data.mjs 生成，请勿手工编辑。 */',
  '/* 数据源：data/manifest.json 与各谱系 JSON。 */',
  '',
].join('\n');

const body = `window.LINEAGE_LIBRARY = ${JSON.stringify({ manifest, lineages }, null, 2)};\n`;
await writeFile(outputPath, header + body, 'utf8');

const bytes = Buffer.byteLength(header + body, 'utf8');
console.log(`已生成 data/lineages.js（${manifest.lineages.length} 套谱系，${(bytes / 1024).toFixed(1)} KB）`);
