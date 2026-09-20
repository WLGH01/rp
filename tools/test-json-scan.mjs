// 顶层 JSON 扫描器的单元测试
//
// json-scan.js 是这次内存优化的地基：服务端靠它拿到各字段的字节区间，
// 从而完全不 JSON.parse 整份快照。它按**字节**扫描，因此必须证明：
//   * UTF-8 多字节字符（中文、emoji）不会被误当成结构字符
//   * 字符串里的转义引号、反斜杠不会打断字符串状态
//   * 嵌套对象/数组的括号配对正确，复合值的区间精确
//   * 非法结构（截断、括号不匹配、顶层非对象）会被明确拒绝
//
// 用法：node tools/test-json-scan.mjs

import { scanBufferTopLevel, createScanner, scanFileTopLevel } from '../sync-server/json-scan.js';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

let failures = 0;
let checks = 0;

const assertEqual = (label, actual, expected) => {
    checks += 1;
    const ok = JSON.stringify(actual) === JSON.stringify(expected);
    if (ok) console.log(`  ✓ ${label}`);
    else {
        failures += 1;
        console.log(`  ✗ ${label}\n      期望: ${JSON.stringify(expected)}\n      实际: ${JSON.stringify(actual)}`);
    }
};
const assertTrue = (label, value) => assertEqual(label, Boolean(value), true);

// 用区间把原文字节切出来，应当与「JSON.parse 后再 stringify」的语义等价。
//
// 注意必须按 **字节** 切（Buffer.subarray），不能用 JS 字符串的 slice：
// 扫描器给的是字节偏移，而中文字符在 UTF-8 里占 3 字节、在 JS 字符串里只算 1 个字符，
// 两者下标并不一致。真实服务端就是从 Buffer/文件里按字节切的。
const sliceField = (text, range) => Buffer.from(text, 'utf8').subarray(range.start, range.end).toString('utf8');

const checkField = (label, text, field, expected) => {
    const scanned = scanBufferTopLevel(Buffer.from(text, 'utf8'));
    if (!scanned.ok) {
        failures += 1;
        checks += 1;
        console.log(`  ✗ ${label}：扫描失败 ${scanned.error}`);
        return;
    }
    const range = scanned.fields[field];
    if (!range) {
        failures += 1;
        checks += 1;
        console.log(`  ✗ ${label}：没找到字段 ${field}`);
        return;
    }
    let actual;
    try {
        actual = JSON.parse(sliceField(text, range));
    } catch (error) {
        failures += 1;
        checks += 1;
        console.log(`  ✗ ${label}：切出的字节不是合法 JSON（${error.message}）`);
        return;
    }
    assertEqual(label, actual, expected);
};

console.log('1) 基本字段与区间精度');
{
    const text = '{"revision":42,"deviceId":"abc-123","force":true,"payload":{"a":1}}';
    const scanned = scanBufferTopLevel(Buffer.from(text, 'utf8'));
    assertTrue('扫描成功', scanned.ok);
    const expected = JSON.parse(text);
    for (const field of ['revision', 'deviceId', 'force', 'payload']) {
        checkField(`${field} 切出的字节可解析且值正确`, text, field, expected[field]);
    }
}

console.log('\n2) UTF-8 多字节内容（中文 / emoji）');
{
    const text = JSON.stringify({
        updatedAt: 1,
        payload: { name: '角色卡·测试🎭', desc: '含中文与 emoji 的头像说明', avatar: 'data:image/png;base64,AAAA' }
    });
    checkField('中文与 emoji 不破坏结构', text, 'payload', JSON.parse(text).payload);
    const scanned = scanBufferTopLevel(Buffer.from(text, 'utf8'));
    assertEqual('顶层字段数量正确', Object.keys(scanned.fields).sort(), ['payload', 'updatedAt']);
}

console.log('\n3) 字符串里的转义序列');
{
    const tricky = '{"a":"quote: \\" backslash: \\\\ slash: \\/ unicode: \\u4e2d","b":{"c":[1,2,{"d":"}}"}]},"e":1}';
    checkField('转义引号/反斜杠不打断字符串', tricky, 'a', JSON.parse(tricky).a);
    checkField('嵌套结构里的 } 不提前结束', tricky, 'b', JSON.parse(tricky).b);
    checkField('紧跟在复合值后的字段仍能解析', tricky, 'e', JSON.parse(tricky).e);
}

console.log('\n4) 深层嵌套与数组');
{
    const deep = JSON.stringify({ payload: { main: { list: Array.from({ length: 50 }, (_, i) => ({ i, s: `[${i}]` })) } }, updatedAt: 9 });
    checkField('深层嵌套数组区间精确', deep, 'payload', JSON.parse(deep).payload);
    checkField('复合值后的字段正确', deep, 'updatedAt', 9);
}

console.log('\n5) 空白与紧凑格式');
{
    const spaced = '{\n  "updatedAt" : 100 ,\n\t"payload" : { "x" : [ 1 , 2 ] }\n}';
    checkField('带空白的格式', spaced, 'payload', JSON.parse(spaced).payload);
    checkField('带空白的数字', spaced, 'updatedAt', 100);
}

console.log('\n6) payload 为 null 与各种字面量');
{
    const text = '{"updatedAt":5,"payload":null,"deviceId":"d","force":false}';
    const scanned = scanBufferTopLevel(Buffer.from(text, 'utf8'));
    assertEqual('null 字段区间正好 4 字节', scanned.fields.payload.end - scanned.fields.payload.start, 4);
    checkField('null 可被识别', text, 'payload', null);
    checkField('false 可被识别', text, 'force', false);
    assertTrue('数字字面量合法', scanBufferTopLevel(Buffer.from('{"a":-1.5e3}', 'utf8')).ok);
}

console.log('\n7) 非法结构必须被拒绝');
{
    const bad = [
        ['截断的对象', '{"a":1'],
        ['截断的字符串', '{"a":"x'],
        ['括号不匹配', '{"a":[1,2}'],
        ['顶层是数组', '[1,2,3]'],
        ['顶层是标量', '42'],
        ['空内容', ''],
        ['字段值后多余内容', '{"a":1 "b":2}'],
        ['根对象后多余内容', '{"a":1} trailing'],
        ['非法字面量', '{"a":xyz}']
    ];
    for (const [label, text] of bad) {
        const scanned = scanBufferTopLevel(Buffer.from(text, 'utf8'));
        assertEqual(`${label} → 被拒`, scanned.ok, false);
    }
}

console.log('\n8) 增量 push（分片边界）');
{
    // 逐字节喂进去，模拟任意 chunk 边界，结果必须与一次喂完一致。
    const text = '{"updatedAt":7,"payload":{"s":"中文\\"引号","n":[[1],[2]]},"deviceId":"dev"}';
    const scanner = createScanner();
    const buffer = Buffer.from(text, 'utf8');
    for (let i = 0; i < buffer.length; i += 1) scanner.push(buffer.subarray(i, i + 1), i);
    const scanned = scanner.finish();
    assertTrue('逐字节分片扫描成功', scanned.ok);
    const field = JSON.parse(sliceField(text, scanned.fields.payload));
    assertEqual('逐字节分片下 payload 正确', field, JSON.parse(text).payload);
}

console.log('\n9) 空对象与只含一个字段');
{
    assertTrue('空对象合法', scanBufferTopLevel(Buffer.from('{}', 'utf8')).ok);
    assertTrue('只有空白包裹的空对象合法', scanBufferTopLevel(Buffer.from('  {  }  ', 'utf8')).ok);
    const single = '{"payload":{"a":1}}';
    checkField('只含 payload 一个字段', single, 'payload', JSON.parse(single).payload);
}

console.log('\n10) 文件扫描（含大 payload，内存与文件大小无关）');
{
    const dir = await mkdtemp(path.join(tmpdir(), 'jsonscan-'));
    const file = path.join(dir, 'state.json');
    const payload = { avatars: Array.from({ length: 8 }, (_, i) => ({ i, b64: 'A'.repeat(256 * 1024) })) };
    await writeFile(file, JSON.stringify({ revision: 1, updatedAt: 2, deviceId: 'x', payload }));
    const scanned = await scanFileTopLevel(file);
    assertTrue('文件扫描成功', scanned.ok);
    const raw = await (await import('node:fs/promises')).readFile(file);
    const onDisk = JSON.parse(raw.toString('utf8'));
    const sliced = JSON.parse(raw.subarray(scanned.fields.payload.start, scanned.fields.payload.end).toString('utf8'));
    assertEqual('文件区间与解析结果一致', JSON.stringify(sliced), JSON.stringify(onDisk.payload));
    await rm(dir, { recursive: true, force: true });
}

console.log(`\n结果: ${failures === 0 ? '通过' : '失败'} — ${checks - failures}/${checks} 项断言`);
process.exit(failures === 0 ? 0 : 1);
