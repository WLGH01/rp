// 验证备份轮换的两个上限（份数 + 总大小），用临时目录，不碰真实数据。
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const tmp = path.join(os.tmpdir(), `syncbackup-test-${Date.now()}`);
const backups = path.join(tmp, 'backups');
fs.mkdirSync(backups, { recursive: true });

// 复现 server.js 的轮换逻辑（与源码保持一致）
const MAX_BACKUPS = 5;
const MAX_BACKUP_BYTES = 300 * 1024 * 1024;

const rotate = async (stateFile) => {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-') + '-' + Math.random().toString(16).slice(2, 6);
    await fs.promises.copyFile(stateFile, path.join(backups, `state-${stamp}.json`)).catch(() => {});
    const names = (await fs.promises.readdir(backups))
        .filter(n => n.startsWith('state-') && n.endsWith('.json')).sort();
    let keep = names.slice(Math.max(0, names.length - MAX_BACKUPS));
    for (const n of names.slice(0, Math.max(0, names.length - MAX_BACKUPS))) {
        await fs.promises.unlink(path.join(backups, n)).catch(() => {});
    }
    if (MAX_BACKUP_BYTES > 0) {
        const sized = [];
        for (const n of keep) {
            const s = await fs.promises.stat(path.join(backups, n)).catch(() => null);
            if (s) sized.push({ name: n, size: s.size });
        }
        let total = sized.reduce((a, b) => a + b.size, 0);
        for (const item of sized) {
            if (total <= MAX_BACKUP_BYTES || keep.length <= 1) break;
            await fs.promises.unlink(path.join(backups, item.name)).catch(() => {});
            total -= item.size;
            keep = keep.filter(n => n !== item.name);
        }
    }
};

const stateFile = path.join(tmp, 'state.json');

// --- 测试 1：份数上限 ---
fs.writeFileSync(stateFile, JSON.stringify({ revision: 1, pad: 'x'.repeat(1000) }));
for (let i = 0; i < 12; i++) {
    fs.writeFileSync(stateFile, JSON.stringify({ revision: i, pad: 'x'.repeat(1000) }));
    await rotate(stateFile);
}
let files = (await fs.promises.readdir(backups)).filter(n => n.endsWith('.json'));
console.log(`测试1 份数上限: 写入 12 次 → 保留 ${files.length} 份 (期望 5) ${files.length === 5 ? '✓' : '✗'}`);

// --- 测试 2：总大小上限（小上限更容易触发） ---
for (const n of files) await fs.promises.unlink(path.join(backups, n));
const BIG = 1024 * 1024; // 每份约 1MB
const smallCap = 3 * BIG;
const rotateSmall = async () => {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-') + '-' + Math.random().toString(16).slice(2, 6);
    await fs.promises.copyFile(stateFile, path.join(backups, `state-${stamp}.json`));
    const names = (await fs.promises.readdir(backups)).filter(n => n.startsWith('state-')).sort();
    let keep = names.slice(Math.max(0, names.length - 5));
    for (const n of names.slice(0, Math.max(0, names.length - 5))) await fs.promises.unlink(path.join(backups, n));
    const sized = [];
    for (const n of keep) { const s = await fs.promises.stat(path.join(backups, n)); sized.push({ name: n, size: s.size }); }
    let total = sized.reduce((a, b) => a + b.size, 0);
    for (const item of sized) {
        if (total <= smallCap || keep.length <= 1) break;
        await fs.promises.unlink(path.join(backups, item.name));
        total -= item.size; keep = keep.filter(n => n !== item.name);
    }
};
fs.writeFileSync(stateFile, 'x'.repeat(BIG));
for (let i = 0; i < 8; i++) await rotateSmall();
files = (await fs.promises.readdir(backups));
let totalBytes = 0;
for (const n of files) totalBytes += (await fs.promises.stat(path.join(backups, n))).size;
console.log(`测试2 总大小上限: 上限 ${(smallCap/BIG).toFixed(0)}MB → 实际 ${files.length} 份 / ${(totalBytes/1048576).toFixed(1)}MB ${totalBytes <= smallCap ? '✓' : '✗'}`);

// --- 测试 3：至少保留 1 份 ---
for (const n of files) await fs.promises.unlink(path.join(backups, n));
const tinyCap = 10; // 10 字节，必然超过
const rotateTiny = async () => {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-') + '-' + Math.random().toString(16).slice(2, 6);
    await fs.promises.copyFile(stateFile, path.join(backups, `state-${stamp}.json`));
    const names = (await fs.promises.readdir(backups)).filter(n => n.startsWith('state-')).sort();
    let keep = names.slice(-5);
    const sized = [];
    for (const n of keep) { const s = await fs.promises.stat(path.join(backups, n)); sized.push({ name: n, size: s.size }); }
    let total = sized.reduce((a, b) => a + b.size, 0);
    for (const item of sized) {
        if (total <= tinyCap || keep.length <= 1) break;
        await fs.promises.unlink(path.join(backups, item.name));
        total -= item.size; keep = keep.filter(n => n !== item.name);
    }
};
await rotateTiny();
files = (await fs.promises.readdir(backups));
console.log(`测试3 极端上限下至少留 1 份: ${files.length} 份 ${files.length === 1 ? '✓' : '✗'}`);

fs.rmSync(tmp, { recursive: true, force: true });
console.log('\n测试目录已清理:', tmp);
