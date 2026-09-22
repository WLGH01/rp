// TTS 语音标记链路回归测试
//
// 覆盖「自动语音」这套标记的纯逻辑：解析 / 清洗 / 按 provider 翻译 / 多角色分音色，
// 以及两条系统正则（语音朗读正则 + 语音标记清理）的**渲染顺序**契约。
//
// 为什么值得单独测：
//   1. sanitizeText 的规则顺序本身就是语义（文档里第 55/56 条踩坑），加规则极易破坏既有行为；
//   2. 两条正则的执行顺序是硬契约——清理若跑在渲染之前，[[/voice]] 会先被清掉，
//      成对匹配失效，标记就会原样显示在界面上；
//   3. 「美化卡」要求正则能作用在 HTML 面板内部，这与普通正则的「保护 HTML」策略相反。
//
// 被测对象是 assets/js/tts-services.js 的 window.RPHubTts（纯函数），
// 页面里 app.js 只是接线，因此这里通过的断言等价于线上逻辑。
//
// 用法：node tools/test-tts-voice.mjs

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const sandbox = {
    window: {},
    console,
    Blob,
    URL,
    URLSearchParams,
    TextDecoder,
    TextEncoder,
    setTimeout,
    clearTimeout,
    atob: globalThis.atob,
    btoa: globalThis.btoa
};
sandbox.globalThis = sandbox;
sandbox.self = sandbox;
vm.createContext(sandbox);
vm.runInContext(readFileSync(join(root, 'assets/js/built-in-content.js'), 'utf8'), sandbox, { filename: 'built-in-content.js' });
vm.runInContext(readFileSync(join(root, 'assets/js/core-utils.js'), 'utf8'), sandbox, { filename: 'core-utils.js' });
vm.runInContext(readFileSync(join(root, 'assets/js/tts-services.js'), 'utf8'), sandbox, { filename: 'tts-services.js' });

const tts = sandbox.window.RPHubTts;
const config = sandbox.window.RPHubConfig;
const prompts = sandbox.window.RPHubBuiltinContent.prompts || sandbox.window.RPHubBuiltinPrompts;

if (!tts) {
    console.error('✗ tts-services.js 未导出 RPHubTts');
    process.exit(1);
}

let failures = 0;
let checks = 0;

const assertEqual = (label, actual, expected) => {
    checks += 1;
    const ok = JSON.stringify(actual) === JSON.stringify(expected);
    if (ok) {
        console.log(`  ✓ ${label}`);
    } else {
        failures += 1;
        console.log(`  ✗ ${label}`);
        console.log(`      实际: ${JSON.stringify(actual)}`);
        console.log(`      期望: ${JSON.stringify(expected)}`);
    }
};

const assertTrue = (label, value) => assertEqual(label, !!value, true);

const settings = {
    ttsProvider: 'minimax',
    ttsMinimaxVoiceId: 'default-voice',
    ttsNovelVoice: 'Ligeia',
    ttsGsvRefAudio: '默认音色',
    ttsVoiceBindings: [
        { name: '小雨', voice: 'voice-xiaoyu' },
        { name: '阿强', voice: 'voice-aqiang' }
    ]
};

// 小米 MiMo-V2.5-TTS 的基准设置：三类音色各一条（预置 / 设计 / 克隆）。
const mimoSettings = {
    ttsProvider: 'mimo',
    ttsMimoKey: 'test-key',
    ttsMimoBaseUrl: 'https://api.xiaomimimo.com/v1',
    ttsMimoVoice: 'preset:冰糖',
    ttsMimoFormat: 'wav',
    ttsMimoVoiceDesigns: [{ name: '播音员', description: '中年男性，播音员风格，吐字工整字字顿挫。' }],
    ttsMimoVoiceClones: [{ name: '样本', mime: 'audio/wav', data: 'QUJD' }],
    ttsMimoDirections: [{ name: '姜黎', direction: '角色：冷面大当家。\n场景：祠堂阴影里。\n指导：语速极慢，句间留白。' }],
    ttsMimoDefaultDirection: '',
    ttsVoiceBindings: []
};

// ---------------------------------------------------------------------------
console.log('\n1) 语音标记解析：台词段 / 旁白段 / 角色名 / 情绪');
// ---------------------------------------------------------------------------
{
    const segments = tts.parseVoiceScript(
        '旁白。\n[[voice:小雨|happy]]你好呀！[[pause:0.5]]再见。[[/voice]]\n*动作*\n[[voice:阿强|angry]]你迟到了。[[/voice]]'
    );
    assertEqual('段数 = 4（旁白 + 台词 + 旁白 + 台词）', segments.length, 4);
    assertEqual('第 1 段是旁白', segments[0].type, 'narration');
    assertEqual('第 2 段角色名', segments[1].name, '小雨');
    assertEqual('第 2 段情绪', segments[1].emotion, 'happy');
    assertEqual('第 2 段是台词', segments[1].type, 'speech');
    assertEqual('第 3 段是旁白', segments[2].type, 'narration');
    assertEqual('第 4 段角色名', segments[3].name, '阿强');
    assertEqual('第 4 段情绪', segments[3].emotion, 'angry');

    const noEmotion = tts.parseVoiceScript('[[voice:小雨]]你好[[/voice]]');
    assertEqual('省略情绪时 emotion 为空串', noEmotion[0].emotion, '');

    const plain = tts.parseVoiceScript('纯旁白，没有任何标记。');
    assertEqual('无标记时只有一段旁白', plain.length, 1);
    assertEqual('无标记段是旁白', plain[0].type, 'narration');
}

// ---------------------------------------------------------------------------
console.log('\n2) 情绪归一化：英文 / 中文别名 / 非法值');
// ---------------------------------------------------------------------------
{
    assertEqual('happy 原样通过', tts.normalizeEmotion('happy'), 'happy');
    assertEqual('大小写不敏感', tts.normalizeEmotion('HAPPY'), 'happy');
    assertEqual('中文「高兴」→ happy', tts.normalizeEmotion('高兴'), 'happy');
    assertEqual('中文「生气」→ angry', tts.normalizeEmotion('生气'), 'angry');
    assertEqual('calm 归一到 neutral（官方文档两段自相矛盾，统一取 neutral）', tts.normalizeEmotion('calm'), 'neutral');
    assertEqual('非法值返回空串（宁可不发也不发错）', tts.normalizeEmotion('暴躁'), '');
    assertEqual('空值返回空串', tts.normalizeEmotion(''), '');
}

// ---------------------------------------------------------------------------
console.log('\n3) MiniMax emotion 模型白名单（官方文档只在部分模型上列出该字段）');
// ---------------------------------------------------------------------------
{
    assertTrue('speech-02-hd 支持 emotion', tts.supportsMinimaxEmotion('speech-02-hd'));
    assertTrue('speech-02-turbo 支持 emotion', tts.supportsMinimaxEmotion('speech-02-turbo'));
    assertTrue('speech-01-turbo 支持 emotion', tts.supportsMinimaxEmotion('speech-01-turbo'));
    assertTrue('speech-01-hd 支持 emotion', tts.supportsMinimaxEmotion('speech-01-hd'));
    assertEqual('裸 speech-01 不支持（官方列表里没有它）', tts.supportsMinimaxEmotion('speech-01'), false);
    assertEqual('未知模型不支持', tts.supportsMinimaxEmotion('speech-99'), false);
}

// ---------------------------------------------------------------------------
console.log('\n4) 多角色音色解析：绑定命中 / 未绑定回落默认 / 旁白走默认');
// ---------------------------------------------------------------------------
{
    assertEqual('已绑定角色取专属音色', tts.resolveVoiceForName(settings, '小雨'), 'voice-xiaoyu');
    assertEqual('另一个已绑定角色', tts.resolveVoiceForName(settings, '阿强'), 'voice-aqiang');
    assertEqual('未绑定角色回落默认音色', tts.resolveVoiceForName(settings, '路人甲'), 'default-voice');
    assertEqual('空角色名（旁白）走默认音色', tts.resolveVoiceForName(settings, ''), 'default-voice');
    assertEqual('绑定值为空时也回落默认音色', tts.resolveVoiceForName({
        ...settings, ttsVoiceBindings: [{ name: '小雨', voice: '' }]
    }, '小雨'), 'default-voice');

    assertEqual('NovelAI 默认音色取 ttsNovelVoice', tts.defaultVoiceFor({ ...settings, ttsProvider: 'novel' }), 'Ligeia');
    assertEqual('GPT-SoVITS 默认音色取 ttsGsvRefAudio', tts.defaultVoiceFor({ ...settings, ttsProvider: 'gpt-sovits' }), '默认音色');
}

// ---------------------------------------------------------------------------
console.log('\n5) 停顿翻译：只有 MiniMax 有原生语法，另两家退化为标点');
// ---------------------------------------------------------------------------
{
    assertEqual('MiniMax 译为 <#x#> 且补两位小数',
        tts.translatePauses('a[[pause:0.5]]b', 'minimax'), 'a<#0.50#>b');
    assertEqual('MiniMax 连续停顿合并成一个（官方明确不允许连续）',
        tts.translatePauses('a[[pause:0.3]][[pause:0.2]]b', 'minimax'), 'a<#0.50#>b');
    assertEqual('MiniMax 超出上限被夹到 99.99',
        tts.translatePauses('a[[pause:123.456]]b', 'minimax'), 'a<#99.99#>b');
    assertEqual('MiniMax 低于下限被夹到 0.01',
        tts.translatePauses('a[[pause:0]]b', 'minimax'), 'a<#0.01#>b');
    assertEqual('GPT-SoVITS 退化为逗号', tts.translatePauses('a[[pause:0.5]]b', 'gpt-sovits'), 'a，b');
    assertEqual('NovelAI 退化为逗号', tts.translatePauses('a[[pause:0.5]]b', 'novel'), 'a，b');
    assertEqual('退化后不与既有句末标点重复',
        tts.translatePauses('a[[pause:0.5]]。', 'novel'), 'a。');
    assertEqual('原生 <#0.5#> 会被归一后再按 provider 翻译（换服务不失效）',
        tts.translatePauses('a<#0.5#>b', 'gpt-sovits'), 'a，b');
    assertEqual('无停顿标记时原样返回', tts.translatePauses('普通文本', 'minimax'), '普通文本');
}

// ---------------------------------------------------------------------------
console.log('\n6) 文本清洗：不该念的东西一个都不能留（需求第 5 条）');
// ---------------------------------------------------------------------------
{
    const clean = (text, options = {}) => tts.sanitizeText(text, { stripActions: true, ...options });

    assertEqual('表情符号被清除', clean('你好😀！太好了🎉'), '你好！太好了');
    assertEqual('颜文字被清除（含装饰性外文字母）', clean('真的吗？(๑•̀ㅂ•́)و✧ 好的'), '真的吗？ 好的');
    assertEqual('语气词叠字被清除', clean('哈哈哈，你来了。'), '你来了。');
    assertEqual('生图 tag 连 image 前缀一起清除', clean('她笑了。image###1girl, smile### 走了。'), '她笑了。 走了。');
    assertEqual('图片 markdown 被清除', clean('看这个 ![图](http://x/y.png) 好'), '看这个 好');
    assertEqual('裸 URL 被清除', clean('详见 https://example.com/a?b=1 链接'), '详见 链接');
    assertEqual('代码块被清除', clean('```js\nvar a=1\n``` 结束'), '结束');
    assertEqual('HTML 标签被清除（保留文字）', clean('<div class="p"><span>你好</span></div>'), '你好');
    assertEqual('语音标记被剥掉（保留台词）',
        clean('[[voice:小雨|happy]]走吧[[pause:0.5]]！[[/voice]]'), '走吧！');
    assertEqual('未闭合的语音标记也被清除',
        clean('[[voice:小雨]]没闭合'), '没闭合');
    assertEqual('装饰性符号串被清除', clean('~~~~~ ===== *****'), '');
    assertEqual('纯表情返回空串', clean('😀🎉***'), '');
    assertEqual('粗体只去标记留文字', clean('这是 **重点** 内容'), '这是 重点 内容');
    assertEqual('标题/列表/引用只去标记', clean('## 标题\n- 项目\n> 引用'), '标题 项目 引用');

    // 开关语义不能被新规则破坏
    assertEqual('stripActions=false 时保留动作描写',
        tts.sanitizeText('她说道，*轻轻叹气*然后走了。', { stripActions: false }),
        '她说道，*轻轻叹气*然后走了。');
    assertEqual('readDialogueOnly=true 只留引号台词',
        tts.sanitizeText('旁白。\n“你好呀。”\n又一句旁白。', { readDialogueOnly: true, stripActions: true }),
        '“你好呀。”');

    // 顺序契约：生图 tag 必须早于标题井号
    assertEqual('行首生图 tag 不被当标题吃掉',
        clean('image###1girl###\n正文'), '正文');
}

// ---------------------------------------------------------------------------
console.log('\n7) 保留停顿的清洗（点击单句台词朗读用）');
// ---------------------------------------------------------------------------
{
    assertEqual('台词中的停顿被保留',
        tts.sanitizeWithPauses('你好呀！[[pause:0.5]]今天天气真好。', { stripActions: true }),
        '你好呀！[[pause:0.5]]今天天气真好。');
    assertEqual('句首停顿被去掉（没有可停顿的前文）',
        tts.sanitizeWithPauses('[[pause:1]]开头', { stripActions: true }), '开头');
    assertEqual('句尾停顿被去掉', tts.sanitizeWithPauses('结尾[[pause:2]]', { stripActions: true }), '结尾');
    assertEqual('停顿不会被语气词规则连带吃掉',
        tts.sanitizeWithPauses('哈哈哈[[pause:0.3]]走吧', { stripActions: true }), '走吧');
}

// ---------------------------------------------------------------------------
console.log('\n8) 分片段构建：每段带自己的音色与情绪');
// ---------------------------------------------------------------------------
{
    const parts = tts.buildSpeechParts(
        '旁白。\n[[voice:小雨|happy]]你好。[[/voice]]\n[[voice:路人]]喂。[[/voice]]',
        settings, { stripActions: true }
    );
    assertEqual('片段数 = 3', parts.length, 3);
    assertEqual('旁白用默认音色', parts[0].voice, 'default-voice');
    assertEqual('旁白无情绪', parts[0].emotion, '');
    assertEqual('小雨用绑定音色', parts[1].voice, 'voice-xiaoyu');
    assertEqual('小雨带情绪', parts[1].emotion, 'happy');
    assertEqual('未绑定角色回落默认音色', parts[2].voice, 'default-voice');
    assertEqual('MiniMax 下停顿已翻译成原生语法',
        tts.buildSpeechParts('[[voice:小雨]]a[[pause:0.5]]b[[/voice]]', settings, {})[0].text,
        'a<#0.50#>b');
    assertEqual('GPT-SoVITS 下停顿退化为标点',
        tts.buildSpeechParts('[[voice:小雨]]a[[pause:0.5]]b[[/voice]]',
            { ...settings, ttsProvider: 'gpt-sovits' }, {})[0].text,
        'a，b');
    assertEqual('空正文返回空数组', tts.buildSpeechParts('', settings, {}), []);
}

// ---------------------------------------------------------------------------
console.log('\n9) 系统资产注册：世界书与正则名字必须被登记为「系统条目」');
// ---------------------------------------------------------------------------
{
    assertTrue('「语音朗读正则」在 systemRegexNames 里',
        config.systemRegexNames.includes('语音朗读正则'));
    assertTrue('「语音标记清理」在 systemRegexNames 里',
        config.systemRegexNames.includes('语音标记清理'));
    assertTrue('「语音语气词正则」在 systemRegexNames 里（MiMo 的 [[sfx:..]] 渲染）',
        config.systemRegexNames.includes('语音语气词正则'));
    assertTrue('「自动语音」在 systemWorldInfoNames 里',
        config.systemWorldInfoNames.includes('自动语音'));
    assertTrue('原有「NAI画图正则」仍在（没被覆盖）',
        config.systemRegexNames.includes('NAI画图正则'));
    assertTrue('原有「自动生图」仍在（没被覆盖）',
        config.systemWorldInfoNames.includes('自动生图'));
}

// ---------------------------------------------------------------------------
console.log('\n10) 语音链正则的渲染顺序契约（朗读 → 语气词 → 清理）');
// ---------------------------------------------------------------------------
{
    // 与 app.js 里 enforceVoiceRules 写入的内容逐字一致，任何一边改动都会在这里暴露。
    const renderScript = {
        regex: '/\\[\\[voice:\\s*([^\\]|"\'<>\\r\\n]{1,40}?)\\s*(?:\\|\\s*([^\\]|"\'<>\\r\\n]{1,24}?)\\s*)?\\]\\]\\s*([^"<>]*?)\\s*\\[\\[\\/voice\\]\\]/gi',
        replacement: '<button type="button" class="tts-voice-btn" data-tts-name="$1" data-tts-emotion="$2" data-tts-text="$3" title="朗读这句台词" aria-label="朗读这句台词"><svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M13 4.4v15.2a1 1 0 0 1-1.7.7L7.1 16H4.5A1.5 1.5 0 0 1 3 14.5v-5A1.5 1.5 0 0 1 4.5 8h2.6l4.2-4.3a1 1 0 0 1 1.7.7Z"/></svg></button>$3'
    };
    const sfxScript = {
        regex: '/\\[\\[sfx:\\s*([^\\]"\'<>|\\r\\n]{1,24}?)\\s*\\]\\]/gi',
        replacement: '（$1）'
    };
    const cleanupScript = {
        regex: '/(data-tts-text="[^"]*")|\\[\\[(?:pause:\\s*\\d+(?:\\.\\d+)?|emo:\\s*[a-zA-Z\\u4e00-\\u9fff]+|sfx:\\s*[^\\]]*|\\/?voice\\b[^\\]]*)\\]\\]|<#\\s*\\d+(?:\\.\\d+)?\\s*#>/gi',
        replacement: '$1'
    };
    const toRegExp = (source) => {
        const last = source.lastIndexOf('/');
        return new RegExp(source.slice(1, last), source.slice(last + 1));
    };
    const apply = (text, scripts) => scripts.reduce(
        (out, script) => out.replace(toRegExp(script.regex), script.replacement), text);

    const msg = '[[voice:小雨|happy]]你好呀！[[pause:0.5]]再见。[[sfx:叹气]][[/voice]]';

    const rendered = apply(msg, [renderScript, sfxScript, cleanupScript]);
    // 只看**可见文字**（剥掉标签属性），属性里按设计要保留停顿供点击朗读使用。
    const visibleText = rendered.replace(/<[^>]*>/g, '');
    assertTrue('渲染后产出语音按钮', rendered.includes('class="tts-voice-btn"'));
    assertTrue('按钮是 <button>（可聚焦、可键盘触发）', rendered.includes('<button type="button" class="tts-voice-btn"'));
    assertTrue('按钮排在台词**之前**', rendered.indexOf('tts-voice-btn') < rendered.indexOf('你好呀！'));
    assertTrue('台词本身不再被包成高亮块', !rendered.includes('>你好呀！[[pause:0.5]]再见。</span>'));
    assertTrue('渲染后可见文字里没有标记', !visibleText.includes('[[voice:'));
    assertTrue('渲染后可见文字里没有停顿标记', !visibleText.includes('[[pause:'));
    // 语气词正则与朗读正则一样作用于整段文本，因此属性里那份也一并被渲染成「（叹气）」。
    // 这不影响点击朗读：keepAudioTags 下（叹气）会被保留，翻译层只对 MiMo 生效，
    // 其他 provider 会在清洗期把它当动作补白删掉（见第 18 节）。
    assertTrue('属性里保留了停顿，语气词渲染成可读提示',
        rendered.includes('data-tts-text="你好呀！[[pause:0.5]]再见。（叹气）"'));
    assertTrue('角色名进了属性', rendered.includes('data-tts-name="小雨"'));
    assertTrue('情绪进了属性', rendered.includes('data-tts-emotion="happy"'));
    assertTrue('语气词在正文里渲染成可读提示「（叹气）」', visibleText.includes('（叹气）'));
    assertTrue('语气词不会被清理正则吃掉', !visibleText.includes('[[sfx:'));

    // 顺序反过来（先清理）会破坏成对匹配——这正是必须防住的回归。
    const wrongOrder = apply(msg, [cleanupScript, renderScript, sfxScript]);
    assertTrue('若清理先跑，成对匹配失效、渲染不出语音按钮（守住顺序契约）',
        !wrongOrder.includes('class="tts-voice-btn"'));

    // 语气词必须早于清理：晚于清理时标记已被抹掉，正文里的表演提示就消失了。
    const cleanupFirst = apply(msg, [renderScript, cleanupScript, sfxScript]);
    assertTrue('语气词若晚于清理，正文里的表演提示会消失（顺序契约：语气词必须先于清理）',
        !cleanupFirst.replace(/<[^>]*>/g, '').includes('（叹气）'));

    // 关掉自动语音时只剩清理正则：标记必须被抹掉而不是原样显示。
    const cleanupOnly = apply(msg, [cleanupScript]);
    assertTrue('关闭后标记不会漏到界面上',
        !cleanupOnly.includes('[[voice:') && !cleanupOnly.includes('[[pause:') && !cleanupOnly.includes('[[sfx:'));

    // 美化卡：正文在 HTML 面板内部时也必须能包上语音按钮。
    const fancy = '<div class="panel"><p style="color:red">[[voice:小雨|happy]]老板，来一杯。[[pause:1.2]][[sfx:轻笑]]谢谢！[[/voice]]</p></div>';
    const fancyRendered = apply(fancy, [renderScript, sfxScript, cleanupScript]);
    assertTrue('美化卡（HTML 面板内）也能渲染出语音按钮', fancyRendered.includes('class="tts-voice-btn"'));
    assertTrue('美化卡内属性保留停顿（语气词渲染成提示）',
        fancyRendered.includes('data-tts-text="老板，来一杯。[[pause:1.2]]（轻笑）谢谢！"'));
    assertTrue('美化卡内语气词渲染成「（轻笑）」', fancyRendered.replace(/<[^>]*>/g, '').includes('（轻笑）'));
    assertTrue('美化卡原有 HTML 结构未被破坏', fancyRendered.includes('<div class="panel">'));

    // MiMo 的复合情绪是自然语言（含逗号、顿号），不能把属性拼断。
    const compound = apply('[[voice:姜黎|温柔，但疲惫]]『嗯。』[[/voice]]', [renderScript, sfxScript, cleanupScript]);
    assertTrue('复合情绪（含中文逗号）整段进属性', compound.includes('data-tts-emotion="温柔，但疲惫"'));
    assertTrue('复合情绪不影响语音框渲染', compound.includes('class="tts-voice-btn"'));
    assertTrue('复合情绪可见文字里没有残留分隔符', !compound.replace(/<[^>]*>/g, '').includes('|温柔'));

    // 引号是属性注入的风险点：正文里带引号时不能把属性截断。
    const quoted = apply('[[voice:小雨]]他说"你好"[[/voice]]', [renderScript, sfxScript, cleanupScript]);
    assertTrue('台词含英文引号时不产出残缺属性', !/data-tts-name="[^"]*$/.test(quoted));
}

// ---------------------------------------------------------------------------
console.log('\n11) 提示词按 provider 能力分流（用哪家就按哪家写）');
// ---------------------------------------------------------------------------
{
    const minimaxPrompt = prompts.buildAutoVoicePrompt({ provider: 'minimax' });
    assertTrue('MiniMax 提示词给出情绪白名单', minimaxPrompt.includes('happy / sad / angry'));
    assertTrue('MiniMax 提示词给出停顿写法', minimaxPrompt.includes('[[pause:秒数]]'));
    assertTrue('提示词说明只标记人物说的话', minimaxPrompt.includes('人物说出口的台词'));
    assertTrue('提示词排除旁白/动作/心理描写', minimaxPrompt.includes('旁白、动作、心理与环境描写'));
    assertTrue('提示词要求兼容美化卡/HTML', minimaxPrompt.includes('美化面板'));

    const novelPrompt = prompts.buildAutoVoicePrompt({ provider: 'novel' });
    assertTrue('NovelAI 提示词明确说不支持情绪', novelPrompt.includes('不支持情绪控制'));
    assertTrue('NovelAI 提示词要求改用标点表达停顿', novelPrompt.includes('改用标点表达停顿'));
    assertTrue('NovelAI 提示词不再提 [[pause:]]', !novelPrompt.includes('[[pause:秒数]]'));

    const gsvPrompt = prompts.buildAutoVoicePrompt({ provider: 'gpt-sovits' });
    assertTrue('GPT-SoVITS 同样按「不支持情绪」处理', gsvPrompt.includes('不支持情绪控制'));

    const bound = prompts.buildAutoVoicePrompt({ provider: 'minimax', voiceBindings: [{ name: '小雨', voice: 'v1' }] });
    assertTrue('绑定了角色时提示词列出可用角色名', bound.includes('小雨'));

    const noBind = prompts.buildAutoVoicePrompt({ provider: 'minimax', voiceBindings: [] });
    assertTrue('未绑定角色时不输出第 6 条', !noBind.includes('以下角色已绑定专属音色'));
}

// ---------------------------------------------------------------------------
console.log('\n12) next_response 提示词带上自动语音指令');
// ---------------------------------------------------------------------------
{
    const on = prompts.buildNextResponsePrompt({ autoVoiceEnabled: true });
    assertTrue('开启时要求使用语音标记', on.includes('[[voice:角色名|情绪]]'));
    assertTrue('开启时交代「标记在外、引号在内」', on.includes('标记在外、引号在内'));
    assertTrue('开启时禁止「只写引号不写标记」', on.includes('只写引号而不写标记是不允许的'));
    const off = prompts.buildNextResponsePrompt({ autoVoiceEnabled: false });
    assertTrue('关闭时不含语音标记说明', !off.includes('[[voice:角色名|情绪]]'));
}

// ---------------------------------------------------------------------------
console.log('\n13) 提示词必须交代「台词本身怎么写」（第一版漏了：AI 只写『』不写标记）');
// ---------------------------------------------------------------------------
{
    const p = prompts.buildAutoVoicePrompt({ provider: 'minimax', voiceBindings: [{ name: '姜黎', voice: 'v1' }] });
    assertTrue('写明「标记在外、引号在内」', p.includes('标记在外、引号在内'));
    assertTrue('示例把引号包在标记内部', p.includes('[[voice:姜黎|happy]]『哟，人都齐了吧。』[[/voice]]'));
    assertTrue('示例使用用户已绑定的角色名', p.includes('姜黎'));
    assertTrue('明确禁止「只写引号不写标记」', p.includes('而不写 [[voice:...]] 标记是不允许的'));
    assertTrue('解释为什么：引号界定不了说话人', p.includes('界定说话人的是标记'));
    assertTrue('要求原有引号保留在标记内部', p.includes('保留在标记内部'));
    assertTrue('声明本规则优先于卡片/预设的对白格式', p.includes('优先于角色卡、预设'));

    // 未绑定角色时示例退化为占位名，但写法说明不能少
    const noBind = prompts.buildAutoVoicePrompt({ provider: 'novel' });
    assertTrue('无绑定时仍有写法说明', noBind.includes('标记在外、引号在内'));
    assertTrue('无绑定时仍禁止只写引号', noBind.includes('而不写 [[voice:...]] 标记是不允许的'));
}

// ---------------------------------------------------------------------------
console.log('\n14) 源码级断言：开关两个方向都要同步世界书与「语音朗读正则」');
// ---------------------------------------------------------------------------
{
    // 这是第一版的第二个真 bug：开启时会把正则打开，关闭时却只关了世界书，
    // 正则一直留在打开状态，两处状态不一致。属于「不报错、只是行为不对」的类型，
    // 纯函数测不到，因此按仓库既有做法做源码级断言。
    const appSource = readFileSync(join(root, 'assets/js/app.js'), 'utf8');
    assertTrue('enforceVoiceRules 把正则开关对齐到世界书条目',
        appSource.includes('if (renderRegex) renderRegex.enabled = !!voiceWI.enabled;'));
    assertTrue('清理正则被强制保持启用（关掉会让历史标记漏到界面）',
        appSource.includes('forceEnabled: true'));

    const watcherAt = appSource.indexOf('watch(isAutoVoiceEnabled');
    assertTrue('存在 isAutoVoiceEnabled 的 watcher', watcherAt >= 0);
    const watcherBlock = appSource.slice(watcherAt, watcherAt + 400);
    assertTrue('watcher 里没有「只在开启时动作」的提前 return（旧 bug）',
        !/if\s*\(\s*!newVal\s*\)\s*return/.test(watcherBlock));
    assertTrue('watcher 两个方向都会调用 enforceVoiceRules',
        watcherBlock.includes('enforceVoiceRules()'));

    // MiMo 接入后新增的契约（语气词正则 + 世界书提示词收到导演演绎）。
    assertTrue('enforceVoiceRules 里登记了「语音语气词正则」',
        appSource.includes("const voiceSfxRegexName = '语音语气词正则';"));
    assertTrue('语气词正则排在朗读正则之后、清理之前',
        appSource.includes('upsertSystemRegex(voiceSfxRegexContent, voiceRegexName);')
        && appSource.includes('upsertSystemRegex(voiceCleanupRegexContent, voiceSfxRegexName, { forceEnabled: true });'));
    assertTrue('语气词正则的开关也跟随世界书条目',
        appSource.includes('if (sfxRegex) sfxRegex.enabled = !!voiceWI.enabled;'));
    assertTrue('世界书提示词收到导演演绎列表',
        appSource.includes('mimoDirections: settings.ttsMimoDirections'));
    assertTrue('processRegex 里显式固定「朗读 → 语气词」的相对顺序',
        appSource.includes('const voiceRank = (name) => (name === voiceRegexName ? 0 : name === voiceSfxRegexName ? 1 : null);'));
    assertTrue('语气词正则与朗读正则一样作用于整段文本（美化卡内也要生效）',
        appSource.includes('|| scriptName === voiceSfxRegexName'));
    assertTrue('MiMo 走 OpenAI 兼容的 chat/completions',
        readFileSync(join(root, 'assets/js/tts-services.js'), 'utf8').includes('/chat/completions'));
}

// ---------------------------------------------------------------------------
console.log('\n15) MiMo 音色标识：预置 / 设计 / 克隆，裸名兜底');
// ---------------------------------------------------------------------------
{
    assertEqual('preset: 前缀 → 预置音色', tts.resolveMimoVoice(mimoSettings, 'preset:冰糖').kind, 'preset');
    assertEqual('design: 前缀 → 音色设计', tts.resolveMimoVoice(mimoSettings, 'design:播音员').kind, 'design');
    assertEqual('clone: 前缀 → 音色克隆', tts.resolveMimoVoice(mimoSettings, 'clone:样本').kind, 'clone');
    assertEqual('裸名命中设计库', tts.resolveMimoVoice(mimoSettings, '播音员').kind, 'design');
    assertEqual('裸名命中克隆库', tts.resolveMimoVoice(mimoSettings, '样本').kind, 'clone');
    assertEqual('裸名都不命中时按预置音色处理', tts.resolveMimoVoice(mimoSettings, '茉莉').kind, 'preset');
    assertEqual('设计音色带出描述', tts.resolveMimoVoice(mimoSettings, 'design:播音员').entry.description,
        '中年男性，播音员风格，吐字工整字字顿挫。');
    assertEqual('音色值统一带类型前缀', tts.mimoVoiceValue('design', '播音员'), 'design:播音员');
    assertEqual('克隆样本拼成 DataURL',
        tts.buildMimoVoiceSampleUrl({ mime: 'audio/mpeg', data: 'QUJD' }), 'data:audio/mpeg;base64,QUJD');
    assertEqual('已经是 DataURL 时原样返回',
        tts.buildMimoVoiceSampleUrl({ data: 'data:audio/wav;base64,QQ==' }), 'data:audio/wav;base64,QQ==');
    assertEqual('base 不带 /v1 时自动补上',
        tts.normalizeMimoBaseUrl('https://gw.example.com'), 'https://gw.example.com/v1');
    assertEqual('base 已带 /v1 时不动（含尾斜杠）',
        tts.normalizeMimoBaseUrl('https://api.xiaomimimo.com/v1/'), 'https://api.xiaomimimo.com/v1');
    assertEqual('默认音色取 ttsMimoVoice', tts.defaultVoiceFor(mimoSettings), 'preset:冰糖');
    assertEqual('白名单外的裸值按预置处理并带前缀',
        tts.resolveMimoVoice(mimoSettings, '白桦').value, 'preset:白桦');

    const voices = tts.listVoices(mimoSettings);
    assertTrue('音色下拉同时列出三类',
        voices.some(i => i.value === 'preset:冰糖')
        && voices.some(i => i.value === 'design:播音员')
        && voices.some(i => i.value === 'clone:样本'));
    assertTrue('预置音色标签带语言/性别/风格', voices.find(i => i.value === 'preset:冰糖').label.includes('活泼少女'));
}

// ---------------------------------------------------------------------------
console.log('\n16) MiMo 请求载荷：模型由音色决定，台词进 assistant，风格进 user');
// ---------------------------------------------------------------------------
{
    const req = tts.buildMimoRequest('你好', mimoSettings, {});
    assertEqual('预置音色 → mimo-v2.5-tts', req.model, 'mimo-v2.5-tts');
    assertEqual('URL 是 OpenAI 兼容的 chat/completions',
        req.url, 'https://api.xiaomimimo.com/v1/chat/completions');
    assertEqual('audio.voice 是预置音色 ID', req.audio.voice, '冰糖');
    assertEqual('audio.format 跟随设置', req.audio.format, 'wav');
    assertEqual('台词放在最后一条 assistant 里', req.messages.at(-1).role, 'assistant');
    assertEqual('assistant.content 就是台词', req.messages.at(-1).content, '你好');
    assertTrue('走 Bearer 鉴权', req.headers.Authorization === 'Bearer test-key');

    // 情绪：既作为整体风格标签贴到文本开头（官方规定必须在开头），也作为 user 侧风格指令。
    const emotional = tts.buildMimoRequest('唔……', mimoSettings, { name: '姜黎', emotion: '压抑的愤怒' });
    assertEqual('情绪变成文本开头的整体风格标签',
        emotional.messages.at(-1).content, '（压抑的愤怒）唔……');
    assertEqual('风格指令是第一条 user 消息', emotional.messages[0].role, 'user');
    assertTrue('user 里交代了本轮情绪', emotional.messages[0].content.includes('【本轮情绪】压抑的愤怒'));
    assertTrue('user 里带上了该角色的导演演绎', emotional.messages[0].content.includes('【导演演绎】'));
    assertTrue('导演演绎内容原样带入', emotional.messages[0].content.includes('冷面大当家'));

    const fallback = tts.buildMimoRequest('嗯', {
        ...mimoSettings, ttsMimoDirections: [], ttsMimoDefaultDirection: '角色：旁白。\n指导：平稳叙述。'
    }, { name: '路人' });
    assertTrue('没专属设定时用通用导演演绎', fallback.messages[0].content.includes('平稳叙述'));

    const noStyle = tts.buildMimoRequest('嗯', { ...mimoSettings, ttsMimoDirections: [], ttsMimoDefaultDirection: '' }, {});
    assertEqual('没有任何风格指令时只有一条 assistant 消息', noStyle.messages.length, 1);

    // 音色设计：模型由音色类型决定，且**不传 voice**（音色完全由描述决定）。
    const design = tts.buildMimoRequest('今天天气不错。', { ...mimoSettings, ttsMimoVoice: 'design:播音员' }, {});
    assertEqual('设计音色 → mimo-v2.5-tts-voicedesign', design.model, 'mimo-v2.5-tts-voicedesign');
    assertEqual('设计音色不传 audio.voice', design.audio.voice, undefined);
    assertTrue('设计音色的描述进 user', design.messages[0].content.includes('【音色】中年男性，播音员风格'));

    // 音色克隆：DataURL 放 audio.voice。
    const clone = tts.buildMimoRequest('复刻一下。', { ...mimoSettings, ttsMimoVoice: 'clone:样本' }, {});
    assertEqual('克隆音色 → mimo-v2.5-tts-voiceclone', clone.model, 'mimo-v2.5-tts-voiceclone');
    assertEqual('克隆音色的样本以 DataURL 下发', clone.audio.voice, 'data:audio/wav;base64,QUJD');

    const expectThrow = (label, fn) => {
        checks += 1;
        let threw = false;
        try { fn(); } catch { threw = true; }
        if (threw) console.log(`  ✓ ${label}`);
        else { failures += 1; console.log(`  ✗ ${label}`); }
    };
    expectThrow('没填 Key 时直接报可操作的错',
        () => tts.buildMimoRequest('你好', { ...mimoSettings, ttsMimoKey: '' }, {}));
    expectThrow('设计音色缺描述时报错（而不是发一个必然失败的请求）',
        () => tts.buildMimoRequest('你好', {
            ...mimoSettings, ttsMimoVoice: 'design:没描述', ttsMimoVoiceDesigns: []
        }, {}));
    expectThrow('克隆音色缺样本时报错',
        () => tts.buildMimoRequest('你好', {
            ...mimoSettings, ttsMimoVoice: 'clone:没样本', ttsMimoVoiceClones: []
        }, {}));
}

// ---------------------------------------------------------------------------
console.log('\n17) MiMo 标记翻译：停顿 → 音频标签、语气词 → 括号、其他家丢弃');
// ---------------------------------------------------------------------------
{
    assertEqual('0.5 秒 → （停顿0.5秒）', tts.translatePauses('a[[pause:0.5]]b', 'mimo'), 'a（停顿0.5秒）b');
    assertEqual('≥1 秒 → （长停顿2秒）', tts.translatePauses('a[[pause:2]]b', 'mimo'), 'a（长停顿2秒）b');
    assertEqual('连续停顿合并成一个', tts.translatePauses('a[[pause:0.3]][[pause:0.2]]b', 'mimo'), 'a（停顿0.5秒）b');
    assertEqual('秒数被夹到合理区间', tts.translatePauses('a[[pause:999]]b', 'mimo'), 'a（长停顿10秒）b');
    assertEqual('语气词翻成官方音频标签', tts.translateSfx('a[[sfx:叹气]]b', 'mimo'), 'a（叹气）b');
    assertEqual('语气词对其他家直接丢弃（否则会被念出来）', tts.translateSfx('a[[sfx:叹气]]b', 'minimax'), 'ab');
    assertEqual('NovelAI 同样丢弃语气词', tts.translateSfx('a[[sfx:轻笑]]b', 'novel'), 'ab');
    assertEqual('统一入口一次翻完停顿与语气词',
        tts.translateVoiceMarkers('a[[sfx:轻笑]][[pause:1]]b', 'mimo'), 'a（轻笑）（长停顿1秒）b');
    assertEqual('MiniMax 的停顿语义没被改动',
        tts.translatePauses('a[[pause:0.5]]b', 'minimax'), 'a<#0.50#>b');
}

// ---------------------------------------------------------------------------
console.log('\n18) MiMo 清洗：发声标签保住、动作补白照删');
// ---------------------------------------------------------------------------
{
    const keep = { stripActions: true, keepAudioTags: true };
    assertEqual('括号音频标签被保住', tts.sanitizeText('她说道（叹气），走了。', keep), '她说道（叹气）走了。');
    assertEqual('多个标签都保住', tts.sanitizeText('（低声）别这样。（长叹一口气）', keep), '（低声）别这样。（长叹一口气）');
    assertEqual('动作补白仍然被删掉', tts.sanitizeText('她走了。（她走上舞台）', keep), '她走了。');
    assertEqual('非 MiMo 路径行为不变（默认删括号）',
        tts.sanitizeText('她说道（叹气），走了。', { stripActions: true }), '她说道，走了。');
    assertEqual('标记形式的停顿与语气词在合成清洗里都保住',
        tts.sanitizeWithPauses('唔[[pause:0.5]]好[[sfx:轻笑]]', { stripActions: true }),
        '唔[[pause:0.5]]好[[sfx:轻笑]]');
    assertTrue('音频标签识别函数只认发声词表',
        tts.isMimoAudioTagInner('叹气') && tts.isMimoAudioTagInner('停顿 0.5 秒') && !tts.isMimoAudioTagInner('她走上舞台'));
}

// ---------------------------------------------------------------------------
console.log('\n19) MiMo 分片段：复合情绪不被英文白名单吃掉，风格标签贴到文本开头');
// ---------------------------------------------------------------------------
{
    const parts = tts.buildSpeechParts(
        '[[voice:姜黎|压抑的愤怒]]唔[[pause:0.5]]好[[/voice]]', mimoSettings, { stripActions: true });
    assertEqual('片段数 = 1', parts.length, 1);
    assertEqual('复合情绪原样保留（不查英文白名单）', parts[0].emotion, '压抑的愤怒');
    assertEqual('风格标签贴到文本开头 + 停顿已翻译',
        parts[0].text, '（压抑的愤怒）唔（停顿0.5秒）好');
    assertEqual('未绑定角色回落默认音色', parts[0].voice, 'preset:冰糖');

    const noEmotion = tts.buildSpeechParts('[[voice:姜黎]]嗯[[/voice]]', mimoSettings, {});
    assertEqual('省略情绪时不贴风格标签', noEmotion[0].text, '嗯');

    const miniParts = tts.buildSpeechParts('[[voice:小雨|暴躁]]走[[/voice]]',
        { ...settings, ttsProvider: 'minimax' }, {});
    assertEqual('MiniMax 下非法情绪仍然被丢弃（行为不变）', miniParts[0].emotion, '');
}

// ---------------------------------------------------------------------------
console.log('\n20) MiMo 提示词：世界书教复合情绪与语气词，AI 代写音色描述与导演演绎');
// ---------------------------------------------------------------------------
{
    const p = prompts.buildAutoVoicePrompt({ provider: 'mimo' });
    assertTrue('给出复合情绪示例（自然语言）', p.includes('压抑的愤怒'));
    assertTrue('说明情绪可以省略', p.includes('省略「|情绪」'));
    assertTrue('给出语气词标记写法', p.includes('[[sfx:叹气]]'));
    assertTrue('语气词只写声音、不写身体动作', p.includes('不要写身体动作'));
    assertTrue('给出停顿写法与秒数范围', p.includes('[[pause:0.5]]') && p.includes('0.1–10'));
    assertTrue('说明唱歌模式', p.includes('唱歌'));
    assertTrue('不再沿用 MiniMax 的英文情绪白名单', !p.includes('happy / sad / angry'));
    assertTrue('写法与优先级声明保持', p.includes('标记在外、引号在内') && p.includes('优先于角色卡、预设'));
    assertTrue('仍然禁止只写引号', p.includes('而不写 [[voice:...]] 标记是不允许的'));

    const directed = prompts.buildAutoVoicePrompt({
        provider: 'mimo', mimoDirections: [{ name: '姜黎', direction: 'x' }]
    });
    assertTrue('已有导演演绎的角色会被点名，避免 AI 用文字改音色', directed.includes('姜黎'));
    const notDirected = prompts.buildAutoVoicePrompt({ provider: 'mimo' });
    assertTrue('没有导演演绎时不输出该条', !notDirected.includes('专属的「导演演绎」声线设定'));

    const minimaxUnchanged = prompts.buildAutoVoicePrompt({ provider: 'minimax' });
    assertTrue('MiniMax 提示词未被 MiMo 分支污染',
        minimaxUnchanged.includes('happy / sad / angry') && !minimaxUnchanged.includes('[[sfx:叹气]]'));

    const design = prompts.buildMimoVoiceDesignPrompt({ characterName: '姜黎', characterInfo: '冷面大当家' });
    assertTrue('音色描述提示词要求身份锚点与声音质感',
        design.includes('身份锚点') && design.includes('声音质感'));
    assertTrue('音色描述提示词禁止写场景/动作',
        design.includes('不要写场景') && design.includes('不要写动作'));
    assertTrue('音色描述提示词带上角色设定', design.includes('冷面大当家'));

    const direction = prompts.buildMimoDirectionPrompt({ characterName: '姜黎', characterInfo: '冷面大当家' });
    assertTrue('导演演绎提示词要求角色/场景/指导三段',
        direction.includes('角色：') && direction.includes('场景：') && direction.includes('指导：'));
    assertTrue('导演演绎提示词要求可执行的发声指导', direction.includes('语速与顿挫'));
    assertTrue('导演演绎提示词强调可跨场景复用（声线底稿）', direction.includes('声线底稿'));
}

// ---------------------------------------------------------------------------
console.log('\n21) MiniMax 语气词标签：官方是 speech-2.8 专有 → 本站不实现，一律丢弃');
// ---------------------------------------------------------------------------
{
    // 官方 T2A HTTP 文档写明：interjection tags 仅在 speech-2.8-hd / speech-2.8-turbo 上生效，
    // speech-02 系列不支持。本站默认跑 speech-02，做半套映射只会让默认配置听到
    // 「（sighs）」被逐字念出来，因此对 MiniMax 一律丢弃 [[sfx:...]]（与另两家同策）。
    assertEqual('MiniMax 下语气词一律丢弃',
        tts.translateSfx('a[[sfx:叹气]]b', 'minimax'), 'ab');
    assertEqual('即使显式传 2.8 也丢弃（本站不启用该能力）',
        tts.translateSfx('a[[sfx:叹气]]b', 'minimax', { minimaxModel: 'speech-2.8-hd' }), 'ab');
    assertEqual('MiniMax 的停顿语义未被影响',
        tts.translateVoiceMarkers('a[[sfx:叹气]][[pause:0.5]]b', 'minimax'), 'a<#0.50#>b');
    assertEqual('MiMo 仍保留语气词（唯一支持的一家）',
        tts.translateSfx('a[[sfx:叹气]]b', 'mimo'), 'a（叹气）b');
    assertEqual('服务层不再导出语气词白名单（避免「半套能力」复活）',
        typeof tts.supportsMinimaxInterjection, 'undefined');
    assertEqual('也不再导出语气词映射表', typeof tts.normalizeMinimaxInterjection, 'undefined');
    assertTrue('2.8 仍留在模型列表与情绪白名单里（它本身是更新的模型）',
        tts.MINIMAX_MODELS.some(item => item.value === 'speech-2.8-hd')
        && tts.supportsMinimaxEmotion('speech-2.8-hd'));
    assertEqual('默认模型仍是 speech-02-hd（不擅自把默认值换成 2.8）',
        tts.DEFAULTS.ttsMinimaxModel, 'speech-02-hd');
}

// ---------------------------------------------------------------------------
console.log('\n22) MiniMax 世界书：情绪粒度（一块一个情绪 → 拆块换情绪）');
// ---------------------------------------------------------------------------
{
    const p = prompts.buildAutoVoicePrompt({ provider: 'minimax' });
    assertTrue('明确「一个语音块只能有一个情绪」', p.includes('一个语音块只能有一个情绪'));
    assertTrue('给出同角色拆块换情绪的示例', p.includes('『哦？』[[/voice]][[voice:'));
    assertTrue('指出复合情绪不是合法取值', p.includes('复合情绪不是合法取值'));
    assertTrue('保留 7 种情绪枚举', p.includes('happy / sad / angry'));
    assertTrue('保留停顿写法', p.includes('[[pause:秒数]]'));
    assertTrue('不出现语气词标记（官方专有、本站不实现）', !p.includes('[[sfx:'));
    assertTrue('不出现英文语气词标签', !p.includes('(sighs)'));

    const bound = prompts.buildAutoVoicePrompt({
        provider: 'minimax', voiceBindings: [{ name: '姜黎', voice: 'v1' }]
    });
    assertTrue('拆块示例使用用户真实绑定的角色名', bound.includes('[[voice:姜黎|neutral]]'));
    assertTrue('拆块示例把两种情绪写进两个块', bound.includes('|angry]]『你再说一遍试试。』[[/voice]]'));

    const mimo = prompts.buildAutoVoicePrompt({ provider: 'mimo' });
    assertTrue('MiMo 分支仍保留语气词写法', mimo.includes('[[sfx:叹气]]'));
    const novel = prompts.buildAutoVoicePrompt({ provider: 'novel' });
    assertTrue('NovelAI 提示词不提语气词', !novel.includes('[[sfx:'));
}

// ---------------------------------------------------------------------------
console.log(`\n结果: ${failures === 0 ? '通过' : '失败'} — ${checks - failures}/${checks} 项断言`);
if (failures > 0) process.exit(1);
