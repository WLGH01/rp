// 校验 unraid 规范化后的模板，并打印关键字段（避免 shell 引号问题）。
import fs from 'node:fs';

const file = process.argv[2];
const x = fs.readFileSync(file, 'utf8');
const field = (tag) => x.match(new RegExp(`<${tag}>([^<]*)</${tag}>`))?.[1] ?? '(无)';

console.log('文件大小:', Buffer.byteLength(x), '字节');
console.log('Name        :', field('Name'));
console.log('Repository  :', field('Repository'));
console.log('Network     :', field('Network'));
console.log('WebUI       :', field('WebUI'));
console.log('Category    :', field('Category'));
console.log('ExtraParams :', field('ExtraParams'));
console.log('TailscaleStateDir:', /TailscaleStateDir/.test(x) ? '有（unraid 自动添加）' : '无');
console.log('中文以实体存储   :', /&#x/.test(x) ? '是（unraid 规范化）' : '否');
console.log('XML 声明次数     :', (x.match(/<\?xml/g) || []).length);

const cfgs = [...x.matchAll(/<Config\s([^>]*)>([^<]*)<\/Config>/g)].map(m => {
    const pick = (key) => m[1].match(new RegExp(`${key}="([^"]*)"`))?.[1] ?? '';
    return { type: pick('Type'), name: pick('Name'), target: pick('Target'), mode: pick('Mode'), value: m[2].trim() };
});

console.log('\nConfig 数量:', cfgs.length);
for (const c of cfgs) {
    console.log(`  [${c.type}] ${c.name} -> ${c.target} = ${c.value}${c.mode ? ` (${c.mode})` : ''}`);
}

// 中文实体解码后再校验内容完整性
const decoded = x.replace(/&#x([0-9A-Fa-f]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)));
console.log('\n中文完整性:');
for (const s of ['跨设备同步', '数据持久化', '墨韵·造梦', '容器删除重建也不会丢失']) {
    console.log(`  ${decoded.includes(s) ? 'OK  ' : '缺失'} ${s}`);
}
