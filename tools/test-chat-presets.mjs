// 预设集（多预设 + 酒馆预设导入）回归测试
//
// 覆盖三件事：
//   1. 酒馆（SillyTavern）预设的解析：prompts / prompt_order / 采样参数 / 自带正则；
//   2. 默认预设「可以修改、不能删除」：用户改过的不被代码覆盖、删掉的不复活、
//      没改过的跟随版本升级；
//   3. 多预设的切换、重命名、导入导出闭环，以及坏输入不会产出脏数据。
//
// 被测对象是 assets/js/core-utils.js 里的 window.RPHubChatPresets（纯函数），
// 页面里 app.js 只是接线，因此这里通过的断言等价于线上逻辑。
//
// 用法：node tools/test-chat-presets.mjs
// 可选：node tools/test-chat-presets.mjs "D:/角色卡/破甲/Reborn2.3.json"   —— 顺便校验真实酒馆预设文件

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

// --- 在 Node 里加载浏览器脚本 ---
const sandbox = {
    window: {},
    crypto: globalThis.crypto,
    URL,
    URLSearchParams,
    TextDecoder,
    TextEncoder,
    console,
    setTimeout,
    clearTimeout,
    atob: globalThis.atob,
    btoa: globalThis.btoa
};
sandbox.globalThis = sandbox;
sandbox.self = sandbox;
vm.createContext(sandbox);
// core-utils 依赖 built-in-content（内置预设内容），按 index.html 的加载顺序先注入。
vm.runInContext(readFileSync(join(root, 'assets/js/built-in-content.js'), 'utf8'), sandbox, { filename: 'built-in-content.js' });
vm.runInContext(readFileSync(join(root, 'assets/js/core-utils.js'), 'utf8'), sandbox, { filename: 'core-utils.js' });

const presets = sandbox.window.RPHubChatPresets;
const builtin = sandbox.window.RPHubBuiltinPresets;

if (!presets) {
    console.error('✗ core-utils.js 未导出 RPHubChatPresets');
    process.exit(1);
}

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
const section = (title) => console.log(`\n${title}`);

// --- 1. 预设集归一化 ---
section('1) 预设集：归一化与默认预设不可变');
assertEqual('默认预设 id 固定', presets.DEFAULT_PRESET_SET_ID, 'default');
const emptySets = presets.normalizePresetSets([]);
assertEqual('空存档也补出默认预设', emptySets.length, 1);
assertEqual('补出来的是内置默认预设', emptySets[0].builtin, true);
assertEqual('默认预设名固定', emptySets[0].name, '默认预设');
const withUsers = presets.normalizePresetSets([
    { id: 'a', name: '甲', prompts: [{ name: 'P', content: 'x' }] },
    { id: 'b', name: '乙', prompts: [] }
]);
assertEqual('默认预设排第一', withUsers[0].id, 'default');
assertEqual('用户预设顺序保持', withUsers.slice(1).map(s => s.id), ['a', 'b']);
const messy = presets.normalizePresetSets([
    null, 'nope', { id: 'a', name: '甲' }, { id: 'a', name: '重复 id' }, { name: '' }
]);
assertEqual('坏条目被丢掉且 id 去重', messy.map(s => s.id), ['default', 'a', 'set-3']);
assertTrue('空条目数组是合法状态（用户可能全删了）', Array.isArray(messy[1].prompts) && messy[1].prompts.length === 0);
assertEqual('预设数量上限生效',
    presets.normalizePresetSets(Array.from({ length: 200 }, (_, i) => ({ id: `s${i}`, name: `n${i}` }))).length,
    presets.PRESET_SET_LIMIT);

// --- 2. 默认预设：可修改、不能删除 ---
section('2) 默认预设：用户改过的不被覆盖、删掉的不复活');
const syncInput = {
    prompts: [
        { name: 'A', content: '用户改过的 A', role: 'system', enabled: true },
        { name: 'B', content: '旧的 B', role: 'system', enabled: false },
        { name: '我的条目', content: '自己加的', role: 'user', enabled: true }
    ],
    defaults: [
        { name: 'A', content: '代码的 A', role: 'system' },
        { name: 'B', content: '新的 B', role: 'system' },
        { name: 'C', content: '新增的 C', role: 'system' }
    ],
    baseline: { A: '代码的 A', B: '旧的 B' },
    removed: []
};
const synced = presets.syncBuiltinPresetEntries(syncInput);
const byName = Object.fromEntries(synced.prompts.map(item => [item.name, item]));
assertEqual('用户改过的条目内容被保留', byName.A.content, '用户改过的 A');
assertEqual('没改过的条目跟随代码升级', byName.B.content, '新的 B');
assertEqual('没改过的条目保留用户的开关', byName.B.enabled, false);
assertEqual('用户自己加的条目原样保留', byName['我的条目'].content, '自己加的');
assertEqual('代码新增的条目被补进来', byName.C.content, '新增的 C');
assertEqual('新增条目插在被锚定条目之后', synced.prompts.map(p => p.name), ['A', 'B', 'C', '我的条目']);
assertEqual('基线被更新为本次代码内容', synced.baseline, { A: '代码的 A', B: '新的 B', C: '新增的 C' });
assertTrue('本次有变化时 changed 为真', synced.changed);

const withRemoved = presets.syncBuiltinPresetEntries({
    prompts: [{ name: 'A', content: '代码的 A', role: 'system', enabled: true }],
    defaults: [{ name: 'A', content: '代码的 A' }, { name: 'C', content: '新增的 C' }],
    baseline: { A: '代码的 A' },
    removed: ['C']
});
assertEqual('被删掉的内置条目不再补回', withRemoved.prompts.map(p => p.name), ['A']);
assertEqual('删除记录被持久化', withRemoved.removed, ['C']);

const readded = presets.syncBuiltinPresetEntries({
    prompts: [{ name: 'C', content: '新增的 C', role: 'system', enabled: true }],
    defaults: [{ name: 'C', content: '新增的 C' }],
    baseline: {},
    removed: ['C']
});
assertEqual('手动加回后撤销删除标记', readded.removed, []);
assertEqual('手动加回的条目保留', readded.prompts.map(p => p.name), ['C']);

// 幂等：同样的输入跑两次结果必须稳定，否则每次启动都会误判成「有变化」。
const twice = presets.syncBuiltinPresetEntries({
    prompts: synced.prompts,
    defaults: syncInput.defaults,
    baseline: synced.baseline,
    removed: []
});
assertEqual('第二次同步不再改动条目',
    twice.prompts.map(p => [p.name, p.content]), synced.prompts.map(p => [p.name, p.content]));
assertEqual('第二次同步无变化', twice.changed, false);
assertEqual('基线归一化会丢掉坏值',
    presets.normalizePresetBaseline({ A: 'x', B: 3, '': 'y' }), { A: 'x' });

// 版本升级：代码改了内置内容，只有没被改过的条目跟着变。
const afterUpgrade = presets.syncBuiltinPresetEntries({
    prompts: synced.prompts,
    defaults: syncInput.defaults.map(d => d.name === 'B' ? { ...d, content: '更新的 B' } : d),
    baseline: synced.baseline,
    removed: []
});
const upByName = Object.fromEntries(afterUpgrade.prompts.map(p => [p.name, p]));
assertEqual('升级后：用户改过的条目仍保留用户版本', upByName.A.content, '用户改过的 A');
assertEqual('升级后：没改过的条目拿到新内容', upByName.B.content, '更新的 B');

// --- 3. 重名收敛 ---
section('3) 预设集：重名收敛');
assertEqual('不冲突时原名返回', presets.uniquePresetSetName([{ name: '甲' }], '乙'), '乙');
assertEqual('重名自动加序号', presets.uniquePresetSetName([{ name: '甲' }], '甲'), '甲 (2)');
assertEqual('连续重名继续递增',
    presets.uniquePresetSetName([{ name: '甲' }, { name: '甲 (2)' }], '甲'), '甲 (3)');
assertEqual('空名兜底', presets.uniquePresetSetName([], '   '), '新预设');
assertEqual('超长预设名被截断',
    presets.normalizePresetSet({ name: 'x'.repeat(500), id: 's' }, 1).name.length <= presets.PRESET_SET_NAME_MAX, true);

// --- 4. 酒馆预设解析 ---
section('4) 酒馆预设：prompts + prompt_order + 采样参数 + 正则');
const stFixture = {
    temperature: 1.08,
    frequency_penalty: 0.25,
    presence_penalty: -0.5,
    top_p: 0.98,
    top_k: 40,
    min_p: 0.05,
    openai_max_context: 2000000,
    openai_max_tokens: 65535,
    reasoning_effort: 'high',
    prompts: [
        { identifier: 'main', name: '主提示', role: 'system', system_prompt: true, content: '主提示内容', enabled: true },
        { identifier: 'worldInfoBefore', name: 'World Info (before)', role: 'system', marker: true, system_prompt: true, content: '', enabled: true },
        { identifier: 'chatHistory', name: 'Chat History', role: 'system', marker: true, system_prompt: true, content: '', enabled: true },
        { identifier: 'p1', name: '条目一', role: 'system', content: '第一条', enabled: false },
        { identifier: 'p2', name: '条目二', role: 'user', content: '第二条', enabled: true },
        { identifier: 'p3', name: '空的', role: 'system', content: '   ', enabled: true },
        { identifier: 'p4', name: '未被排序', role: 'assistant', content: '第四条', enabled: true }
    ],
    prompt_order: [
        { character_id: 100000, order: [] },
        { character_id: 100001, order: [
            { identifier: 'main', enabled: true },
            { identifier: 'worldInfoBefore', enabled: true },
            { identifier: 'p2', enabled: true },
            { identifier: 'p1', enabled: true },
            { identifier: 'chatHistory', enabled: true },
            { identifier: 'p3', enabled: true }
        ] }
    ],
    extensions: {
        regex_scripts: [
            { id: 'r1', scriptName: '思维链隐藏', findRegex: '/<think>[\\s\\S]*?<\\/think>/g', replaceString: '', placement: [2], disabled: false, markdownOnly: true, promptOnly: false },
            { id: 'r2', scriptName: '坏的', findRegex: '', replaceString: '' }
        ]
    }
};
assertTrue('识别为酒馆预设', presets.isSillyTavernPreset(stFixture));
const stParsed = presets.parsePresetImport(stFixture, { fileName: 'Reborn2.3.json' });
assertEqual('识别成预设集（不是散条目）', stParsed.kind, 'set');
assertEqual('文件名去掉扩展名当预设名', stParsed.name, 'Reborn2.3');
assertEqual('marker 与空条目被丢弃', stParsed.prompts.length, 4);
assertEqual('丢弃的 marker 数被如实统计', stParsed.stats.skippedMarkers, 2);
assertEqual('丢弃的空条目数被如实统计', stParsed.stats.skippedEmpty, 1);
assertEqual('顺序按 prompt_order 还原', stParsed.prompts.map(p => p.name), ['主提示', '条目二', '条目一', '未被排序']);
assertEqual('prompt_order 里的 enabled 覆盖 prompts 的 enabled', stParsed.prompts[2].enabled, true);
assertEqual('prompt_order 未提到的条目保留自己的 enabled', stParsed.prompts[3].enabled, true);
assertEqual('role 原样保留', stParsed.prompts.map(p => p.role), ['system', 'user', 'system', 'assistant']);
assertEqual('条目名不为空', stParsed.prompts.every(p => String(p.name).trim().length > 0), true);
assertEqual('内容不为空', stParsed.prompts.every(p => String(p.content).trim().length > 0), true);

section('4b) 酒馆预设：采样参数映射与「不限制」收敛');
const stParams = stParsed.params;
assertEqual('temperature 直传', stParams.temperature, 1.08);
assertEqual('top_p → topP', stParams.topP, 0.98);
assertEqual('frequency_penalty → frequencyPenalty', stParams.frequencyPenalty, 0.25);
assertEqual('presence_penalty → presencePenalty（负值保留）', stParams.presencePenalty, -0.5);
assertEqual('openai_max_tokens=65535（不限制）不下发', stParams.maxTokens, null);
assertEqual('reasoning_effort=high 保留', stParams.reasoningEffort, 'high');
assertEqual('auto 视为未指定', presets.normalizePresetParams({ reasoningEffort: 'auto' }).reasoningEffort, '');
assertEqual('未知档位被丢掉', presets.normalizePresetParams({ reasoningEffort: 'turbo' }).reasoningEffort, '');
const clamped = presets.normalizePresetParams({ temperature: 9, topP: 5, frequencyPenalty: -9, presencePenalty: 9 });
assertEqual('温度夹到 2', clamped.temperature, 2);
assertEqual('top_p 夹到 1', clamped.topP, 1);
assertEqual('频率惩罚夹到 -2', clamped.frequencyPenalty, -2);
assertEqual('存在惩罚夹到 2', clamped.presencePenalty, 2);
assertEqual('负数 max_tokens 收敛成 null', presets.normalizePresetParams({ maxTokens: -5 }).maxTokens, null);
assertEqual('超阈值 max_tokens 收敛成 null', presets.normalizePresetParams({ maxTokens: 999999 }).maxTokens, null);
assertEqual('正常 max_tokens 取整保留', presets.normalizePresetParams({ maxTokens: 4096.7 }).maxTokens, 4097);
assertEqual('缺省参数全是 null（不下发）',
    presets.normalizePresetParams({}),
    { temperature: null, topP: null, frequencyPenalty: null, presencePenalty: null, maxTokens: null, reasoningEffort: '' });

section('4c) 酒馆预设：自带正则一并带出');
assertEqual('正则脚本被带出', stParsed.regexScripts.length, 2);
assertEqual('正则名保留', stParsed.regexScripts[0].scriptName, '思维链隐藏');

// --- 5. 导入/导出闭环 ---
section('5) 导入导出：本站预设集、旧条目数组与闭环');
const rpHubSet = presets.parsePresetImport({
    type: 'rp-hub-preset-set',
    name: '我的预设',
    params: { temperature: 0.8, topP: 0.9 },
    prompts: [{ name: 'A', content: 'a', enabled: true, role: 'system' }]
});
assertEqual('识别为预设集', rpHubSet.kind, 'set');
assertEqual('名字取自文件内容', rpHubSet.name, '我的预设');
assertEqual('条目原样载入', rpHubSet.prompts.length, 1);
assertEqual('参数原样载入', rpHubSet.params.topP, 0.9);
const legacyEntries = presets.parsePresetImport([{ name: '旧条目', content: 'x' }]);
assertEqual('旧条目数组识别为 entries', legacyEntries.kind, 'entries');
assertEqual('旧条目保留', legacyEntries.prompts.length, 1);
assertEqual('旧条目没有采样参数', legacyEntries.params, null);
const roundTrip = presets.parsePresetImport(
    presets.toPresetSetExportEntry({ name: '往返', prompts: [{ name: 'A', content: 'a' }], params: { topP: 0.5 } })
);
assertEqual('导出→导入闭环：名字', roundTrip.name, '往返');
assertEqual('导出→导入闭环：条目', roundTrip.prompts.length, 1);
assertEqual('导出→导入闭环：参数', roundTrip.params.topP, 0.5);

// --- 6. 对抗检查 ---
section('6) 对抗检查：坏输入不产出脏数据');
const hostile = [
    ['null', null],
    ['数组里的 null', [null]],
    ['纯字符串', 'hello'],
    ['prompts 不是数组', { prompts: 'x', temperature: 1 }],
    ['prompts 里有 null', { prompts: [null, { name: 'ok', content: 'c' }] }],
    ['prompt_order 指向不存在的 id', { prompts: [{ identifier: 'x', name: 'a', content: 'b' }], prompt_order: [{ order: [{ identifier: 'nope', enabled: true }] }] }],
    ['巨大的 max_tokens', { prompts: [{ name: 'a', content: 'b' }], openai_max_tokens: 1e12 }],
    ['负温度', { prompts: [{ name: 'a', content: 'b' }], temperature: -99 }]
];
hostile.forEach(([label, input]) => {
    let outcome;
    try { outcome = { ok: true, value: presets.parsePresetImport(input) }; }
    catch (error) { outcome = { ok: false, error: error.message }; }
    if (outcome.ok) {
        const value = outcome.value;
        const clean = Array.isArray(value.prompts) && value.prompts.every(entry => (
            typeof entry.name === 'string' && entry.name.length
            && typeof entry.content === 'string'
            && ['system', 'user', 'assistant'].includes(entry.role)
        ));
        assertTrue(`坏输入「${label}」→ 要么抛错、要么产出干净数据`, clean);
    } else {
        assertTrue(`坏输入「${label}」→ 抛出可读错误`, typeof outcome.error === 'string' && outcome.error.length > 0);
    }
});
const protoInput = JSON.parse('{"prompts":[{"name":"a","content":"b"}],"__proto__":{"polluted":true}}');
presets.parsePresetImport(protoInput);
assertEqual('原型未被污染', ({}).polluted, undefined);
const frozen = Object.freeze({ name: 'F', content: 'c', role: 'system' });
const frozenBefore = JSON.stringify(frozen);
presets.normalizePresetEntry(frozen);
assertEqual('归一化不修改入参', JSON.stringify(frozen), frozenBefore);

// --- 7. 真实酒馆预设文件（可选）---
const realFile = process.argv[2];
if (realFile) {
    section(`7) 真实酒馆预设文件：${realFile}`);
    let parsed;
    try {
        parsed = presets.parsePresetImport(JSON.parse(readFileSync(realFile, 'utf8')), { fileName: realFile.split(/[\\/]/).pop() });
    } catch (error) {
        assertTrue(`解析 ${realFile}`, false);
        console.error(`      ${error.message}`);
        parsed = null;
    }
    if (parsed) {
        console.log(`      条目 ${parsed.prompts.length}（启用 ${parsed.stats.enabled}）· 跳过占位 ${parsed.stats.skippedMarkers} · 跳过空 ${parsed.stats.skippedEmpty} · 正则 ${parsed.regexScripts.length}`);
        assertTrue('解析出条目', parsed.prompts.length > 0);
        assertTrue('没有空内容条目', parsed.prompts.every(p => String(p.content).trim().length > 0));
        assertTrue('没有 marker 占位残留', parsed.prompts.every(p => !/^(World Info|Char |Chat History|Scenario|Persona)/.test(p.name)));
        assertTrue('role 合法', parsed.prompts.every(p => ['system', 'user', 'assistant'].includes(p.role)));
        assertTrue('max_tokens 未误传 65535', parsed.params.maxTokens !== 65535);
        assertTrue('归一化后条目数不变',
            presets.normalizePresetSet({ ...parsed, id: 'x', builtin: false }, 1).prompts.length === parsed.prompts.length);
    }
}

console.log(`\n结果: ${failures === 0 ? '通过' : '失败'} — ${checks - failures}/${checks} 项断言`);
process.exit(failures === 0 ? 0 : 1);
