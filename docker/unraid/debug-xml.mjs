// 定位 XML 标签配对问题：打印每个标签在文本中的位置与前后文。
import fs from 'node:fs';
const xml = fs.readFileSync(process.argv[2], 'utf8');
const tagRe = /<(\/?)([A-Za-z][\w.-]*)([^>]*?)(\/?)>/g;
const stack = [];
let m;
while ((m = tagRe.exec(xml))) {
    const [, closing, name, attrs, selfClose] = m;
    const line = xml.slice(0, m.index).split('\n').length;
    if (name === '?xml') continue;
    if (selfClose === '/') continue;
    if (closing) {
        const top = stack.pop();
        if (top?.name !== name) {
            console.log(`!! 行${line}: 期望 </${top?.name}> (行${top?.line})，实际 </${name}>`);
            console.log(`   上下文: ${JSON.stringify(xml.slice(Math.max(0, m.index - 120), m.index + 40))}`);
            process.exit(1);
        }
    } else {
        stack.push({ name, line });
    }
}
console.log('剩余未闭合:', JSON.stringify(stack));
if (!stack.length) console.log('标签配对 OK');
