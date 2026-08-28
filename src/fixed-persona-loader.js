import { readFile } from 'node:fs/promises';

export async function loadFixedPersona(filePath) {
  let content;
  try {
    content = await readFile(filePath, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') throw new Error(`固定角色卡不存在：${filePath}`);
    throw error;
  }

  const normalized = content.replace(/^\uFEFF/, '').trim();
  if (!normalized) throw new Error(`固定角色卡为空：${filePath}`);
  if (normalized.length > 50_000) throw new Error('固定角色卡过长（最大 50000 字符）');
  return normalized;
}
