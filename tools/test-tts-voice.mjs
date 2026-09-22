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
    assertTrue('「自动语音」在 systemWorldInfoNames 里',
        config.systemWorldInfoNames.includes('自动语音'));
    assertTrue('原有「NAI画图正则」仍在（没被覆盖）',
        config.systemRegexNames.includes('NAI画图正则'));
    assertTrue('原有「自动生图」仍在（没被覆盖）',
        config.systemWorldInfoNames.includes('自动生图'));
}

// ---------------------------------------------------------------------------
console.log('\n10) 两条系统正则的渲染顺序契约（清理必须排在渲染之后）');
// ---------------------------------------------------------------------------
{
    // 与 app.js 里 enforceVoiceRules 写入的内容逐字一致，任何一边改动都会在这里暴露。
    const renderScript = {
        regex: '/\\[\\[voice:\\s*([^\\]|"\'<>\\r\\n]{1,40}?)\\s*(?:\\|\\s*([a-zA-Z\\u4e00-\\u9fff]{0,20}?)\\s*)?\\]\\]\\s*([^"<>]*?)\\s*\\[\\[\\/voice\\]\\]/gi',
        replacement: '<span class="tts-voice-line" role="button" tabindex="0" data-tts-name="$1" data-tts-emotion="$2" data-tts-text="$3" title="点击朗读这句台词">$3</span>'
    };
    const cleanupScript = {
        regex: '/(data-tts-text="[^"]*")|\\[\\[(?:pause:\\s*\\d+(?:\\.\\d+)?|emo:\\s*[a-zA-Z\\u4e00-\\u9fff]+|\\/?voice\\b[^\\]]*)\\]\\]|<#\\s*\\d+(?:\\.\\d+)?\\s*#>/gi',
        replacement: '$1'
    };
    const toRegExp = (source) => {
        const last = source.lastIndexOf('/');
        return new RegExp(source.slice(1, last), source.slice(last + 1));
    };
    const apply = (text, scripts) => scripts.reduce(
        (out, script) => out.replace(toRegExp(script.regex), script.replacement), text);

    const msg = '[[voice:小雨|happy]]你好呀！[[pause:0.5]]再见。[[/voice]]';

    const rendered = apply(msg, [renderScript, cleanupScript]);
    // 只看**可见文字**（剥掉标签属性），属性里按设计要保留停顿供点击朗读使用。
    const visibleText = rendered.replace(/<[^>]*>/g, '');
    assertTrue('渲染后产出语音框', rendered.includes('class="tts-voice-line"'));
    assertTrue('渲染后可见文字里没有标记', !visibleText.includes('[[voice:'));
    assertTrue('渲染后可见文字里没有停顿标记', !visibleText.includes('[[pause:'));
    assertTrue('属性里保留了停顿（点击朗读要用）', rendered.includes('data-tts-text="你好呀！[[pause:0.5]]再见。"'));
    assertTrue('角色名进了属性', rendered.includes('data-tts-name="小雨"'));
    assertTrue('情绪进了属性', rendered.includes('data-tts-emotion="happy"'));

    // 顺序反过来（先清理）会破坏成对匹配——这正是必须防住的回归。
    const wrongOrder = apply(msg, [cleanupScript, renderScript]);
    assertTrue('若清理先跑，成对匹配失效、渲染不出语音框（守住顺序契约）',
        !wrongOrder.includes('class="tts-voice-line"'));

    // 关掉自动语音时只剩清理正则：标记必须被抹掉而不是原样显示。
    const cleanupOnly = apply(msg, [cleanupScript]);
    assertTrue('关闭后标记不会漏到界面上', !cleanupOnly.includes('[[voice:') && !cleanupOnly.includes('[[pause:'));

    // 美化卡：正文在 HTML 面板内部时也必须能包上语音框。
    const fancy = '<div class="panel"><p style="color:red">[[voice:小雨|happy]]老板，来一杯。[[pause:1.2]]谢谢！[[/voice]]</p></div>';
    const fancyRendered = apply(fancy, [renderScript, cleanupScript]);
    assertTrue('美化卡（HTML 面板内）也能渲染出语音框', fancyRendered.includes('class="tts-voice-line"'));
    assertTrue('美化卡内属性保留停顿', fancyRendered.includes('data-tts-text="老板，来一杯。[[pause:1.2]]谢谢！"'));
    assertTrue('美化卡原有 HTML 结构未被破坏', fancyRendered.includes('<div class="panel">'));

    // 引号是属性注入的风险点：正文里带引号时不能把属性截断。
    const quoted = apply('[[voice:小雨]]他说"你好"[[/voice]]', [renderScript, cleanupScript]);
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
}

// ---------------------------------------------------------------------------
console.log(`\n结果: ${failures === 0 ? '通过' : '失败'} — ${checks - failures}/${checks} 项断言`);
if (failures > 0) process.exit(1);
