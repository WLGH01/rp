// 校验 unraid 模板 XML 的良构性与关键字段（不引入依赖）。
import fs from 'node:fs';

const file = process.argv[2];
const xml = fs.readFileSync(file, 'utf8');

// unraid 的 Config 属性顺序不固定，因此逐个属性提取而不是依赖顺序。
const configs = [...xml.matchAll(/<Config\s([^>]*)>/g)].map(m => {
    const attrs = m[1];
    const pick = (key) => attrs.match(new RegExp(`${key}="([^"]*)"`))?.[1] ?? '';
    return { name: pick('Name'), target: pick('Target'), type: pick('Type'), def: pick('Default') };
});

const field = (tag) => xml.match(new RegExp(`<${tag}>([^<]*)</${tag}>`))?.[1] ?? null;

// 标签配对检查（忽略自闭合与 XML 声明）
const stack = [];
const tagRe = /<(\/?)([A-Za-z][\w.-]*)([^>]*?)(\/?)>/g;
let m, balanced = true, problem = '';
while ((m = tagRe.exec(xml))) {
    const [, closing, name, attrs, selfClose] = m;
    if (name === '?xml' || selfClose === '/') continue;
    if (closing) {
        if (stack.pop() !== name) { balanced = false; problem = `不匹配的结束标签 </${name}>`; break; }
    } else {
        stack.push(name);
    }
}
if (balanced && stack.length) { balanced = false; problem = `未闭合标签: ${stack.join(', ')}`; }

console.log('文件:', file);
console.log('良构:', balanced ? 'OK' : `失败 - ${problem}`);
console.log('Name:', field('Name'));
console.log('Repository:', field('Repository'));
console.log('WebUI:', field('WebUI'));
console.log('DateInstalled 占位符:', xml.includes('__DATE__') ? '仍存在（需替换）' : '已处理');
console.log('Config 数量:', configs.length);
for (const c of configs) {
    console.log(`  - [${c.type}] ${c.name} (${c.target}) default=${c.def}`);
}
const hasDataMount = configs.some(c => c.target === '/data' && c.type === 'Path');
const hasWebRoot = configs.some(c => c.target === '/usr/share/nginx/html');
const hasApiPort = configs.some(c => c.target === '80' && c.type === 'Port');
console.log('校验: /data 挂载=' + hasDataMount + ' WebRoot=' + hasWebRoot + ' 端口80=' + hasApiPort);
