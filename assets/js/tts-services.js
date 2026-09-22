// RP-Hub TTS 语音服务：MiniMax / NovelAI / GPT-SoVITS-V2。
//
// 请求格式对齐 SillyTavern 官方 TTS 扩展与它的服务端实现：
//   - public/scripts/extensions/tts/minimax.js     + src/endpoints/minimax.js
//   - public/scripts/extensions/tts/novel.js       + src/endpoints/novelai.js 的 /generate-voice
//   - public/scripts/extensions/tts/gpt-sovits-v2.js
//
// 与酒馆的区别：酒馆走它自己的 Node 服务端转发（密钥存服务端、顺带绕开 CORS），
// 本站是纯前端，因此由浏览器直连；密钥随 settings 一起存在本机 IndexedDB / 同步快照里。
//
// 故意**不**内置 MiniMax 的完整系统音色表：MiniMax 官方不提供音色列表接口，
// 音色有几百个且常变，写死在代码里必然过期。内置只留一个示例，其余由用户自己加
// （设置 → TTS 语音设置 → 自定义音色），这与酒馆 minimax.js 的做法一致。
(function () {
    const PROVIDERS = Object.freeze([
        { value: 'minimax', label: 'MiniMax' },
        { value: 'novel', label: 'NovelAI 官方 TTS' },
        { value: 'gpt-sovits', label: 'GPT-SoVITS-V2' }
    ]);

    const MINIMAX_MODELS = Object.freeze([
        { value: 'speech-02-hd', label: 'Speech-02-HD（高音质）' },
        { value: 'speech-02-turbo', label: 'Speech-02-Turbo（低延迟）' },
        { value: 'speech-01', label: 'Speech-01（旧版）' },
        { value: 'speech-01-240228', label: 'Speech-01-240228（旧版）' }
    ]);

    const MINIMAX_HOSTS = Object.freeze([
        { value: 'https://api.minimax.io', label: '国际站 api.minimax.io' },
        { value: 'https://api.minimaxi.chat', label: 'Global api.minimaxi.chat' },
        { value: 'https://api.minimax.chat', label: '国内站 api.minimax.chat' }
    ]);

    // 内置示例音色（与酒馆 minimax.js 的 defaultVoices 同一项）。
    const MINIMAX_BUILTIN_VOICES = Object.freeze([
        { name: 'Unrestrained Young Man', voice_id: 'Chinese (Mandarin)_Unrestrained_Young_Man', lang: 'zh-CN' }
    ]);

    // MiniMax 的 lang 参数用下划线格式（zh_CN）。取值来自酒馆 minimax.js 的 languageMap。
    const MINIMAX_LANGUAGES = Object.freeze([
        { value: 'auto', label: '自动识别' },
        { value: 'zh_CN', label: '中文（普通话）' },
        { value: 'zh_TW', label: '中文（粤语/繁体）' },
        { value: 'en_US', label: 'English (US)' },
        { value: 'ja_JP', label: '日本語' },
        { value: 'ko_KR', label: '한국어' },
        { value: 'fr_FR', label: 'Français' },
        { value: 'de_DE', label: 'Deutsch' },
        { value: 'es_ES', label: 'Español' },
        { value: 'pt_BR', label: 'Português (BR)' },
        { value: 'it_IT', label: 'Italiano' },
        { value: 'ru_RU', label: 'Русский' },
        { value: 'ar_SA', label: 'العربية' },
        { value: 'tr_TR', label: 'Türkçe' },
        { value: 'nl_NL', label: 'Nederlands' },
        { value: 'uk_UA', label: 'Українська' },
        { value: 'vi_VN', label: 'Tiếng Việt' },
        { value: 'id_ID', label: 'Bahasa Indonesia' },
        { value: 'th_TH', label: 'ไทย' },
        { value: 'pl_PL', label: 'Polski' },
        { value: 'ro_RO', label: 'Română' },
        { value: 'el_GR', label: 'Ελληνικά' },
        { value: 'cs_CZ', label: 'Čeština' },
        { value: 'fi_FI', label: 'Suomi' },
        { value: 'hi_IN', label: 'हिन्दी' }
    ]);

    // NovelAI 内置音色（与酒馆 novel.js 的 fetchTtsVoiceObjects 列表一致）。
    // NovelAI 的「音色」本质是一个 seed：随便写一个名字就等于一个新的随机音色，
    // 因此这里同时允许用户自定义名字（见 ttsNovelCustomVoices）。
    const NOVEL_BUILTIN_VOICES = Object.freeze([
        'Ligeia', 'Aini', 'Orea', 'Claea', 'Lim', 'Aurae', 'Naia',
        'Aulon', 'Elei', 'Ogma', 'Raid', 'Pega', 'Lam'
    ]);

    // MiniMax 的 emotion 是**请求级**参数（voice_setting.emotion），不是文本内标记。
    // 官方文档只在部分模型上列出该字段，因此按模型白名单放行；不在名单里就整段不下发
    // （官方文档对取值也自相矛盾：HTTP 段写 calm、WebSocket 段写 neutral，这里统一用 neutral）。
    const MINIMAX_EMOTIONS = Object.freeze(['happy', 'sad', 'angry', 'fearful', 'disgusted', 'surprised', 'neutral']);
    const MINIMAX_EMOTION_MODELS = Object.freeze([
        'speech-02-hd', 'speech-02-turbo', 'speech-01-turbo', 'speech-01-hd',
        'speech-2.5-hd-preview', 'speech-2.5-turbo-preview'
    ]);
    const supportsMinimaxEmotion = (model) => MINIMAX_EMOTION_MODELS.includes(String(model || '').trim());

    const GSV_TEXT_SPLIT_METHODS = Object.freeze([
        { value: 'cut0', label: 'cut0 不切' },
        { value: 'cut1', label: 'cut1 四句一切' },
        { value: 'cut2', label: 'cut2 50 字一切' },
        { value: 'cut3', label: 'cut3 按中文句号' },
        { value: 'cut4', label: 'cut4 按英文句号' },
        { value: 'cut5', label: 'cut5 按标点（推荐）' }
    ]);

    const GSV_LANGS = Object.freeze([
        { value: 'zh', label: '中文' },
        { value: 'en', label: 'English' },
        { value: 'ja', label: '日本語' },
        { value: 'ko', label: '한국어' },
        { value: 'auto', label: '自动' }
    ]);

    // 新增到 settings 的默认字段。app.js 用 loadData 时按需补齐，老存档不会缺字段。
    const DEFAULTS = Object.freeze({
        // --- 通用 ---
        ttsEnabled: false,
        ttsProvider: 'minimax',
        ttsAutoPlay: false,
        ttsNarrateUser: false,
        ttsVolume: 1,
        ttsRate: 1,
        ttsMaxChars: 1000,
        ttsSplitByParagraph: false,
        ttsStripActions: true,
        ttsReadDialogueOnly: false,
        // 角色名 → 音色 的绑定表（[{ name, voice }]）。没绑定的角色走上面的默认音色。
        ttsVoiceBindings: [],
        // --- MiniMax ---
        ttsMinimaxHost: 'https://api.minimax.io',
        ttsMinimaxKey: '',
        ttsMinimaxModel: 'speech-02-hd',
        ttsMinimaxVoiceId: MINIMAX_BUILTIN_VOICES[0].voice_id,
        ttsMinimaxSpeed: 1,
        ttsMinimaxVol: 1,
        ttsMinimaxPitch: 0,
        ttsMinimaxFormat: 'mp3',
        ttsMinimaxSampleRate: 32000,
        ttsMinimaxBitrate: 128000,
        ttsMinimaxLang: 'auto',
        ttsMinimaxCustomVoices: [],
        // --- NovelAI ---
        ttsNovelBaseUrl: 'https://api.novelai.net',
        ttsNovelToken: '',
        ttsNovelVoice: 'Ligeia',
        ttsNovelCustomVoices: [],
        // --- GPT-SoVITS-V2 ---
        ttsGsvEndpoint: 'http://localhost:9880',
        ttsGsvRefAudio: '',
        ttsGsvPromptText: '',
        ttsGsvTextLang: 'zh',
        ttsGsvPromptLang: 'zh',
        ttsGsvTextSplitMethod: 'cut5',
        ttsGsvMediaType: 'auto',
        ttsGsvStreaming: true,
        // GPT-SoVITS /speakers 探测结果缓存（不是用户可编辑项）。
        ttsGsvSpeakers: []
    });

    const PROVIDER_LABELS = Object.freeze(
        PROVIDERS.reduce((out, item) => { out[item.value] = item.label; return out; }, {})
    );

    const clamp = (value, min, max) => Math.min(Math.max(value, min), max);
    const toArray = value => (Array.isArray(value) ? value : []);
    const normalizeBaseUrl = value => String(value || '').trim().replace(/\/+$/, '');

    // ===== 语音标记：AI 输出一套统一标记，合成前按 provider 翻译成它自己的语法 =====
    //
    // 为什么不让 AI 直接写各家原生语法：切换 TTS 服务之后，历史消息里那些
    // `<#0.5#>`（MiniMax）或标点约定就再也解释不回来了；统一标记可以随时重新解释。
    //
    // 语法（刻意用双方括号，冲突面最小）：
    //   [[voice:角色名]]台词[[/voice]]
    //   [[voice:角色名|happy]]台词[[/voice]]
    //   [[pause:0.5]]              ← 台词中间的停顿，单位秒
    //   [[emo:happy]]              ← 独立情绪标记（等价于写在 voice 标签里）
    const VOICE_BLOCK_PATTERN = /\[\[voice:\s*([^\]|]+?)\s*(?:\|\s*([^\]]+?)\s*)?\]\]([\s\S]*?)\[\[\/voice\]\]/gi;
    const PAUSE_PATTERN = /\[\[pause:\s*(\d+(?:\.\d+)?)\s*\]\]/gi;
    const EMO_INLINE_PATTERN = /\[\[emo:\s*([a-z]+)\s*\]\]/gi;
    // 任何残留标记（含未闭合的开标签）都要在显示与朗读前清掉，绝不能念出来。
    const ANY_MARKER_PATTERN = /\[\[\/?(?:voice|pause|emo|sfx)\b[^\]]*\]\]/gi;
    // 各家原生语法也要能识别：AI 可能按当前服务直接写 MiniMax 的 <#0.5#>。
    const NATIVE_PAUSE_PATTERN = /<#\s*(\d+(?:\.\d+)?)\s*#>/g;

    const freshRegex = (source, flags) => new RegExp(source, flags);

    // AI 可能直接写 provider 原生语法（提示词会按当前 TTS 服务告诉它该写哪种），
    // 因此进入解析前先把原生停顿统一成 `[[pause:x]]`，之后按 provider 再翻译回去。
    // 这样「换 TTS 服务」时历史消息里的停顿也不会失效。
    const normalizeNativePauses = (raw) => String(raw ?? '')
        .replace(NATIVE_PAUSE_PATTERN, (full, seconds) => `[[pause:${seconds}]]`);

    const normalizeEmotion = (value) => {
        const raw = String(value || '').trim().toLowerCase();
        if (!raw) return '';
        // 中文情绪名也接受，方便 AI 偶尔写成中文。
        const aliases = {
            '高兴': 'happy', '开心': 'happy', '快乐': 'happy', '喜悦': 'happy',
            '悲伤': 'sad', '难过': 'sad', '伤心': 'sad',
            '愤怒': 'angry', '生气': 'angry', '恼怒': 'angry',
            '害怕': 'fearful', '恐惧': 'fearful', '惊恐': 'fearful',
            '厌恶': 'disgusted', '嫌弃': 'disgusted',
            '惊讶': 'surprised', '吃惊': 'surprised',
            '中性': 'neutral', '平静': 'neutral', 'calm': 'neutral'
        };
        const mapped = aliases[raw] || raw;
        return MINIMAX_EMOTIONS.includes(mapped) ? mapped : '';
    };

    // 把一段正文拆成「台词段 + 旁白段」。朗读整条消息时按段分别合成，
    // 每段用自己绑定的音色，旁白走默认音色。
    const parseVoiceScript = (raw) => {
        const text = String(raw ?? '');
        const segments = [];
        const pattern = freshRegex(VOICE_BLOCK_PATTERN.source, VOICE_BLOCK_PATTERN.flags);
        let cursor = 0;
        let match;
        while ((match = pattern.exec(text)) !== null) {
            if (match.index > cursor) {
                const narration = text.slice(cursor, match.index);
                if (narration.trim()) segments.push({ type: 'narration', name: '', emotion: '', text: narration });
            }
            segments.push({
                type: 'speech',
                name: String(match[1] || '').trim(),
                emotion: normalizeEmotion(match[2]),
                text: match[3] || ''
            });
            cursor = match.index + match[0].length;
        }
        if (cursor < text.length) {
            const rest = text.slice(cursor);
            if (rest.trim()) segments.push({ type: 'narration', name: '', emotion: '', text: rest });
        }
        return segments;
    };

    // 剥掉语音标记，但**保留** `[[pause:x]]`——它是合成阶段要翻译的语义信息。
    const stripVoiceMarkers = (raw) => String(raw ?? '')
        .replace(freshRegex(VOICE_BLOCK_PATTERN.source, VOICE_BLOCK_PATTERN.flags), '$3')
        .replace(EMO_INLINE_PATTERN, '')
        .replace(/\[\[\/?(?:voice|emo|sfx)\b[^\]]*\]\]/gi, '');

    // 显示与纯文本朗读用：连停顿标记一起清掉（残留的未闭合开标签也在这里兜底）。
    const stripAllMarkers = (raw) => stripVoiceMarkers(raw)
        .replace(PAUSE_PATTERN, '')
        .replace(NATIVE_PAUSE_PATTERN, '')
        .replace(ANY_MARKER_PATTERN, '');

    // 按 provider 把统一标记翻译成它自己的语法。
    // 调研结论（官方文档 / 官方源码）：
    //   MiniMax     唯一有文本内停顿语法 `<#x#>`（秒，0.01–99.99，最多两位小数，不可连续）
    //   GPT-SoVITS  官方无任何文本内标记，停顿只能靠标点 + text_split_method
    //   NovelAI     官方无任何文本内标记，只能靠标点
    // 秒数归一：非数字按 0 处理，再夹进官方允许的 0.01–99.99。
    // 不能写成 `Number(v) || 0.5`——那会把合法的 `[[pause:0]]` 当成「没填」而悄悄改成 0.5。
    const normalizePauseSeconds = (value) => {
        const number = Number(value);
        return clamp(Number.isFinite(number) ? number : 0, 0.01, 99.99);
    };

    const translatePauses = (raw, provider) => {
        // 原生语法先归一成统一标记，再按当前 provider 翻译回它自己的形式——
        // 这样「AI 直接写了 <#0.5#>」与「AI 写了 [[pause:0.5]]」走同一条路径。
        let text = normalizeNativePauses(raw);
        if (!PAUSE_PATTERN.test(text)) return text;
        PAUSE_PATTERN.lastIndex = 0;

        if (provider === 'minimax') {
            // 先把连续停顿合并成一个：官方明确「不能设置多个连续的时间间隔」。
            text = text.replace(/(?:\[\[pause:\s*\d+(?:\.\d+)?\s*\]\]\s*)+/gi, (run) => {
                const total = [...run.matchAll(freshRegex(PAUSE_PATTERN.source, 'gi'))]
                    .reduce((sum, item) => sum + normalizePauseSeconds(item[1]), 0);
                return `[[pause:${normalizePauseSeconds(total)}]]`;
            });
            return text.replace(PAUSE_PATTERN, (full, seconds) => (
                `<#${normalizePauseSeconds(seconds).toFixed(2)}#>`
            ));
        }

        // 另两家表达不了秒级停顿：退化成标点（标点会真实触发它们的切句与停顿），
        // 再清理掉因此产生的重复/孤立标点。
        return text
            .replace(PAUSE_PATTERN, '，')
            .replace(/[，,]{2,}/g, '，')
            .replace(/[，,]+([。．.!！?？；;…])/g, '$1')
            .replace(/^[，,]+/, '');
    };

    // 当前 provider 的默认音色（没绑定的角色走它）。
    const defaultVoiceFor = (settings) => {
        const provider = String(settings?.ttsProvider || 'minimax');
        if (provider === 'novel') return String(settings?.ttsNovelVoice || '').trim();
        if (provider === 'gpt-sovits') return String(settings?.ttsGsvRefAudio || '').trim();
        return String(settings?.ttsMinimaxVoiceId || '').trim();
    };

    // 角色名 → 音色。绑定表里没有（或绑定值为空）就回落默认音色。
    const resolveVoiceForName = (settings, name) => {
        const target = String(name || '').trim();
        if (target) {
            const bindings = toArray(settings?.ttsVoiceBindings);
            const hit = bindings.find(item => String(item?.name || '').trim() === target);
            const voice = String(hit?.voice || '').trim();
            if (voice) return voice;
        }
        return defaultVoiceFor(settings);
    };

    const safeText = async (response) => {
        try {
            const text = await response.text();
            return text ? `：${text.slice(0, 300)}` : '';
        } catch {
            return '';
        }
    };

    // ===== 文本清洗：把 RP 正文转成「能念出来」的纯文本 =====
    // 目标是把 markdown 标记、生图 tag、URL、语音标记、表情与特殊符号之类不该念的东西去掉，
    // 对话内容一定保留。
    const sanitizeText = (raw, options = {}) => {
        let text = String(raw ?? '');
        if (!text.trim()) return '';

        // 语音标记：先剥包装（[[voice:..]]..[[/voice]] 只留台词），再清残留标记与原生语法。
        // 必须排在 markdown 规则之前：标记里含 `|` `:` 等字符，被别的规则先拆散就清不干净。
        text = stripAllMarkers(normalizeNativePauses(text));

        // 代码块 / 行内代码 / 图片 / HTML / 裸 URL：整段丢弃。
        text = text.replace(/```[\s\S]*?```/g, ' ');
        text = text.replace(/~~~[\s\S]*?~~~/g, ' ');
        text = text.replace(/`[^`\n]*`/g, ' ');
        text = text.replace(/!\[[^\]]*\]\([^)]*\)/g, ' ');
        text = text.replace(/<\/?[a-zA-Z][^>]*>/g, ' ');
        text = text.replace(/https?:\/\/\S+/g, ' ');
        // markdown 链接只保留可见文字。
        text = text.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1');
        // 生图提示词整段包裹在 ### 里（本站生图正则就是 ###prompt### 这种形式），
        // 绝不能念出来。必须先整条连 `image` 前缀一起删掉——只删 `###...###` 的话，
        // 前面那个 `image` 会留下来被念成英文单词。
        text = text.replace(/\bimage\s*#{2,}[^#\n]*#{2,}/gi, ' ');
        // 必须在下面的「标题井号」规则**之前**处理：否则行首的 ###
        // 会先被当标题标记吃掉，成对匹配就失效了，提示词会被念出来。
        text = text.replace(/#{2,}[^#\n]*#{2,}/g, ' ');
        text = text.replace(/^[ \t]*[#:]{2,}[ \t]*$/gm, ' ');
        text = text.replace(/#{2,}/g, ' ');
        // 标题井号、列表符号、引用符号：只去标记，留文字。
        text = text.replace(/^[ \t]*#{1,6}[ \t]*/gm, ' ');
        text = text.replace(/^[ \t]*[-*+][ \t]+/gm, ' ');
        text = text.replace(/^[ \t]*>[ \t]?/gm, ' ');
        // markdown 强调符号：只处理成对的双星/双下划线（**粗体** → 粗体），保留文字。
        // 单个 *...* 不在这里处理：它在 RP 文本里表示动作描写，交给下面的 stripActions
        // 决定「删掉」还是「保留」，否则开关就失效了。
        text = text.replace(/(\*\*|__)(.*?)\1/g, '$2');

        if (options.readDialogueOnly) {
            const quoted = text.match(/[“"「『][^”"」』\n]{1,400}[”"」』]/g);
            text = quoted ? quoted.join(' ') : '';
        }

        if (options.stripActions !== false) {
            // 斜体动作（*动作*）与括号补白，朗读时略过。
            text = text.replace(/\*[^*\n]*\*/g, ' ');
            text = text.replace(/（[^）\n]{0,200}）/g, ' ');
            text = text.replace(/\([^)\n]{0,200}\)/g, ' ');
        }

        // 语音标记剥掉后常会留下空引号/空括号（`“[[voice:x]]”` → `“”`），一并清掉。
        text = text.replace(/[“”"「」『』]{2}/g, ' ');
        text = text.replace(/[（(]\s*[）)]/g, ' ');
        // 颜文字（如 `(＾▽＾)`、`(๑•̀ㅂ•́)و✧`）：括号里没有中日韩文字时整段丢弃。
        text = text.replace(/[（(][^）)\n]{0,20}[）)]/g, (match) => (
            /[\u3040-\u30ff\u4e00-\u9fff\uac00-\ud7af]/.test(match.replace(/[（()）]/g, '')) ? match : ' '
        ));
        // 只保留常见书写系统（中日韩、假名、谚文、拉丁、西里尔、希腊）与数字/标点/空白/组合符。
        // 这一步专门收拾两类残留：表情符号，以及颜文字里混进来的装饰性外文字母
        // （泰文 ๑、阿拉伯文 و 之类——它们不是台词内容，念出来只会变成怪声）。
        text = text.replace(/[^\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Latin}\p{Script=Cyrillic}\p{Script=Greek}\p{N}\p{P}\p{Z}\p{M}]/gu, ' ');
        // 独立的语气词/拟声词（「哈哈哈」「呜呜呜」这类叠字叹词）。
        text = text.replace(/(?:哈|呵|嘿|嘻|哼|呜|嘤|嗷|咳|噗|啧|唉|啊|呀|嗯|呃|咦|哇|哦|噢|喔|诶|喂){3,}/g, ' ');
        // 装饰性符号（分隔线、星号装饰、重复标点）：重复标点只保留最后一个有意义的。
        text = text.replace(/[~～^*#=+\-_/\\|<>「」『』【】〔〕]{2,}/g, ' ');
        text = text.replace(/[。．.!！？；;，,、]{3,}/g, match => match.at(-1));
        // 清洗后残留的孤立强调符号。
        // 注意：这里**只处理真正孤立的星号/下划线**（两侧无内容或紧贴标点/空白），
        // 不能用 `[*_~^]+` 一刀切——那会把 `*动作描写*` 的星号也吃掉，
        // 于是「过滤动作」关闭时用户仍然看不到动作（开关静默失效，同文档第 56 条）。
        if (options.stripActions !== false) {
            text = text.replace(/[*_~^]+/g, ' ');
        } else {
            text = text.replace(/(^|[\s，,。．.!！?？；;：:、])[*_~^]+(?=[\s，,。．.!！?？；;：:、]|$)/g, '$1');
        }

        return text
            .replace(/[ \t\u00a0]+/g, ' ')
            .replace(/\s*\n\s*/g, ' ')
            // 去掉动作/括号后常会留下孤立的标点（如「她说道， 。」里的「， 。」），
            // 读出来会变成奇怪的停顿，这里把它们并成单个句号。
            .replace(/[，,、]+\s*([。．.!！?？；;…])/g, '$1')
            .replace(/([。．.!！?？；;…])\s*[，,、]+/g, '$1')
            // 删掉动作/括号后会留下「她说道， 然后」这样的空格，标点两侧都不该有空格。
            .replace(/\s+([。．.!！?？；;…，,、：:])/g, '$1')
            .replace(/([，,、：:])\s+/g, '$1')
            .replace(/^[\s，,、。．.!！?？；;…]+/, '')
            .trim();
    };

    // 清洗一段文本，但**保留** `[[pause:x]]` 停顿标记（点击单句台词朗读时用）。
    // 做法：按停顿标记切成若干段分别清洗，再把标记插回去——这样清洗规则看不到标记，
    // 标记也不会被 stripAllMarkers 吃掉。
    const sanitizeWithPauses = (raw, options = {}) => {
        const source = normalizeNativePauses(raw);
        const pieces = [];
        let cursor = 0;
        const pattern = freshRegex(PAUSE_PATTERN.source, PAUSE_PATTERN.flags);
        let match;
        while ((match = pattern.exec(source)) !== null) {
            pieces.push({ text: source.slice(cursor, match.index), pause: '' });
            pieces.push({ text: '', pause: `[[pause:${match[1]}]]` });
            cursor = match.index + match[0].length;
        }
        pieces.push({ text: source.slice(cursor), pause: '' });

        const out = pieces.map(piece => (piece.pause ? piece.pause : sanitizeText(piece.text, options))).join('');
        // 清洗可能让停顿落到句首/句尾或与标点重复，这里收一下尾。
        return out
            .replace(/(\[\[pause:\s*\d+(?:\.\d+)?\s*\]\])+/gi, run => run.match(freshRegex(PAUSE_PATTERN.source, 'i'))[0])
            .replace(/^(\s*\[\[pause:[^\]]*\]\])+/i, '')
            .replace(/(\[\[pause:[^\]]*\]\])+\s*$/i, '')
            .replace(/([，,、])\s*(\[\[pause:[^\]]*\]\])/gi, '$2')
            .replace(/(\[\[pause:[^\]]*\]\])\s*([，,、。．.!！?？；;])/gi, '$2')
            .trim();
    };

    // 长文本切成不超过 maxChars 的片段，优先在句末标点处断开。
    const SENTENCE_END = /[。！？!?；;…]/;
    const SOFT_BREAK = /[，,、：: ]/;
    const splitText = (raw, maxChars) => {
        const limit = Math.max(60, Number(maxChars) || 1000);
        const source = String(raw ?? '').trim();
        if (!source) return [];
        if (source.length <= limit) return [source];

        const parts = [];
        let rest = source;
        while (rest.length > limit) {
            const window = rest.slice(0, limit);
            const floor = Math.floor(limit * 0.4);
            let cut = -1;
            for (let i = window.length - 1; i >= floor; i--) {
                if (SENTENCE_END.test(window[i]) || window[i] === '\n') { cut = i + 1; break; }
            }
            if (cut <= 0) {
                for (let i = window.length - 1; i >= floor; i--) {
                    if (SOFT_BREAK.test(window[i])) { cut = i + 1; break; }
                }
            }
            if (cut <= 0) cut = limit;
            const piece = rest.slice(0, cut).trim();
            if (piece) parts.push(piece);
            rest = rest.slice(cut);
        }
        if (rest.trim()) parts.push(rest.trim());
        return parts;
    };

    // ===== MiniMax =====
    const MINIMAX_MIME = Object.freeze({
        mp3: 'audio/mpeg', wav: 'audio/wav', flac: 'audio/flac', pcm: 'audio/pcm', aac: 'audio/aac'
    });

    // MiniMax 的 t2a_v2 返回的是 hex 字符串，不是 base64（酒馆服务端也是这么解）。
    const hexToBytes = (hex) => {
        const clean = String(hex || '').replace(/^0x/i, '').replace(/\s/g, '');
        if (!clean || !/^[0-9a-fA-F]+$/.test(clean)) throw new Error('MiniMax 返回的音频不是合法 hex 数据');
        const padded = clean.length % 2 === 0 ? clean : `0${clean}`;
        const bytes = new Uint8Array(padded.length / 2);
        for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(padded.substr(i * 2, 2), 16);
        return bytes;
    };

    // 1004 = 鉴权失败，是酒馆里唯一被单独判定的错误码。
    const describeMinimaxCode = (code, message) => {
        if (Number(code) === 1004) {
            return 'MiniMax 鉴权失败：请检查 API Key 与 API Host 是否属于同一站点';
        }
        const detail = String(message || '').trim();
        return `MiniMax 返回错误（status_code=${code}）${detail ? `：${detail}` : ''}`;
    };

    const synthesizeMinimax = async (text, settings, options = {}) => {
        const apiKey = String(settings?.ttsMinimaxKey || '').trim();
        if (!apiKey) throw new Error('未填写 MiniMax API Key');
        // 音色按「本段绑定的角色」取，取不到才回落设置里的默认音色。
        const voiceId = String(options.voice || settings?.ttsMinimaxVoiceId || '').trim();
        if (!voiceId) throw new Error('未选择 MiniMax 音色（voice_id）');

        const host = normalizeBaseUrl(settings?.ttsMinimaxHost || 'https://api.minimax.io');
        const format = String(settings?.ttsMinimaxFormat || 'mp3');
        const model = settings?.ttsMinimaxModel || 'speech-02-hd';
        const body = {
            model,
            text,
            stream: false,
            voice_setting: {
                voice_id: voiceId,
                speed: clamp(Number(settings?.ttsMinimaxSpeed) || 1, 0.5, 2),
                vol: clamp(Number(settings?.ttsMinimaxVol) ?? 1, 0, 10),
                pitch: clamp(Math.round(Number(settings?.ttsMinimaxPitch) || 0), -12, 12)
            },
            audio_setting: {
                sample_rate: Number(settings?.ttsMinimaxSampleRate) || 32000,
                bitrate: Number(settings?.ttsMinimaxBitrate) || 128000,
                format,
                channel: 1
            }
        };
        // emotion 只在官方列出的模型上生效；不在名单里就整段不下发，避免服务端报错。
        const emotion = normalizeEmotion(options.emotion);
        if (emotion && supportsMinimaxEmotion(model)) body.voice_setting.emotion = emotion;
        const lang = String(settings?.ttsMinimaxLang || 'auto');
        if (lang && lang !== 'auto') body.lang = lang;

        const response = await fetch(`${host}/v1/t2a_v2`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${apiKey}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(body)
        });

        const raw = await response.text();
        let data = null;
        try { data = JSON.parse(raw); } catch { /* 非 JSON 响应，下面按状态码报错 */ }

        if (!response.ok) {
            throw new Error(`MiniMax 请求失败（HTTP ${response.status}）${data ? '' : raw.slice(0, 200)}`);
        }
        const baseResp = data?.base_resp;
        if (baseResp && Number(baseResp.status_code) !== 0) {
            throw new Error(describeMinimaxCode(baseResp.status_code, baseResp.status_msg));
        }
        const hexAudio = data?.data?.audio;
        if (!hexAudio) throw new Error('MiniMax 未返回音频数据（data.audio 为空）');
        return new Blob([hexToBytes(hexAudio)], { type: MINIMAX_MIME[format] || 'audio/mpeg' });
    };

    // ===== NovelAI =====
    const synthesizeNovel = async (text, settings, options = {}) => {
        const token = String(settings?.ttsNovelToken || '').trim();
        if (!token) throw new Error('未填写 NovelAI Access Token（官方 TTS 与官方生图共用同一类 token）');
        const base = normalizeBaseUrl(settings?.ttsNovelBaseUrl || 'https://api.novelai.net');
        const voice = String(options.voice || settings?.ttsNovelVoice || 'Ligeia').trim();
        // voice=-1 + seed=<音色名> 是官方 TTS 的调用方式；opus=false 表示要 mp3。
        const url = `${base}/ai/generate-voice?text=${encodeURIComponent(text)}&voice=-1&seed=${encodeURIComponent(voice)}&opus=false&version=v2`;
        const response = await fetch(url, {
            method: 'GET',
            headers: {
                'Authorization': `Bearer ${token}`,
                'Accept': 'audio/mpeg'
            }
        });
        if (!response.ok) {
            throw new Error(`NovelAI TTS 请求失败（HTTP ${response.status}）${await safeText(response)}`);
        }
        return await response.blob();
    };

    const fetchNovelAiTtsStatus = async (settings) => {
        const token = String(settings?.ttsNovelToken || '').trim();
        if (!token) throw new Error('未填写 NovelAI Access Token');
        const base = normalizeBaseUrl(settings?.ttsNovelBaseUrl || 'https://api.novelai.net');
        // TTS 端点在 api.novelai.net；用同一站点的订阅接口验证 token 是否可用。
        const response = await fetch(`${base}/user/subscription`, {
            headers: { 'Authorization': `Bearer ${token}` }
        });
        if (!response.ok) throw new Error(`NovelAI 鉴权失败（HTTP ${response.status}）`);
        return true;
    };

    // ===== GPT-SoVITS-V2 =====
    // 音色 = 「参考音频」目录下的 wav 文件名。用户既可以从 /speakers 里选，
    // 也可以直接写一个文件名（或相对/绝对路径，含 / 或 \ 时按原样用）。
    const resolveRefAudioPath = (value) => {
        const raw = String(value || '').trim();
        if (!raw) return '';
        if (/[\\/]/.test(raw)) return /\.wav$/i.test(raw) ? raw : `${raw}.wav`;
        return `./参考音频/${raw.replace(/\.wav$/i, '')}.wav`;
    };

    const synthesizeGptSovits = async (text, settings, options = {}) => {
        const endpoint = normalizeBaseUrl(settings?.ttsGsvEndpoint || 'http://localhost:9880');
        // 音色 = 参考音频；按角色绑定换不同的 ref 音频就是换音色。
        // GPT-SoVITS 官方没有任何情绪参数，情绪只能靠「不同情绪的参考音频」体现。
        const refAudioPath = resolveRefAudioPath(options.voice || settings?.ttsGsvRefAudio);
        if (!refAudioPath) throw new Error('未填写 GPT-SoVITS 参考音频（音色）');

        const mediaType = String(settings?.ttsGsvMediaType || 'auto');
        const body = {
            text,
            text_lang: settings?.ttsGsvTextLang || 'zh',
            ref_audio_path: refAudioPath,
            prompt_text: String(settings?.ttsGsvPromptText || '').trim(),
            prompt_lang: settings?.ttsGsvPromptLang || 'zh',
            text_split_method: settings?.ttsGsvTextSplitMethod || 'cut5',
            batch_size: 1,
            streaming_mode: settings?.ttsGsvStreaming === false ? 'false' : 'true'
        };
        if (mediaType && mediaType !== 'auto') body.media_type = mediaType;

        const response = await fetch(`${endpoint}/`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
        });
        if (!response.ok) {
            throw new Error(`GPT-SoVITS 请求失败（HTTP ${response.status}）${await safeText(response)}`);
        }
        return await response.blob();
    };

    // 拉取 GPT-SoVITS 的音色列表（参考音频文件名）。
    const fetchGptSovitsSpeakers = async (endpointValue) => {
        const endpoint = normalizeBaseUrl(endpointValue || 'http://localhost:9880');
        const response = await fetch(`${endpoint}/speakers`);
        if (!response.ok) {
            throw new Error(`GPT-SoVITS /speakers 探测失败（HTTP ${response.status}）`);
        }
        const data = await response.json();
        if (!Array.isArray(data)) return [];
        // 官方返回有时是 ["a","b"]，有时是 [{name:'a'}]，两种都兼容。
        return data
            .map(item => (typeof item === 'string' ? item : (item?.name || item?.voice || '')))
            .filter(Boolean);
    };

    // ===== 统一入口 =====
    const synthesize = (text, settings, options = {}) => {
        const provider = String(settings?.ttsProvider || 'minimax');
        // 停顿标记按 provider 翻译成它自己的语法（只有 MiniMax 有原生停顿语法）。
        const spoken = translatePauses(text, provider);
        if (provider === 'novel') return synthesizeNovel(spoken, settings, options);
        if (provider === 'gpt-sovits') return synthesizeGptSovits(spoken, settings, options);
        return synthesizeMinimax(spoken, settings, options);
    };

    // 把一条消息按「语音块」拆成待合成片段。
    // 每段带上自己的音色与情绪；旁白段用默认音色。
    // 返回 [{ text, voice, emotion, name, type }]，已经清洗并翻译过停顿标记。
    const buildSpeechParts = (raw, settings, options = {}) => {
        const segments = parseVoiceScript(normalizeNativePauses(raw));
        const source = segments.length ? segments : [{ type: 'narration', name: '', emotion: '', text: String(raw ?? '') }];
        const sanitizeOptions = {
            stripActions: options.stripActions !== false,
            readDialogueOnly: options.readDialogueOnly === true
        };
        const provider = String(settings?.ttsProvider || 'minimax');
        const parts = [];
        source.forEach(segment => {
            // 必须用「保留停顿」的清洗：普通 sanitizeText 会把 [[pause:x]] 一起清掉，
            // 后面的 translatePauses 就无从翻译了（整条消息朗读会丢掉所有停顿）。
            const clean = sanitizeWithPauses(segment.text, sanitizeOptions);
            if (!clean) return;
            // 只有台词段才带角色音色；旁白固定走默认音色。
            const voice = segment.type === 'speech' ? resolveVoiceForName(settings, segment.name) : defaultVoiceFor(settings);
            parts.push({
                type: segment.type,
                name: segment.name,
                emotion: segment.emotion,
                voice,
                text: translatePauses(clean, provider)
            });
        });
        return parts;
    };

    const testConnection = async (settings) => {
        const provider = String(settings?.ttsProvider || 'minimax');
        if (provider === 'novel') {
            await fetchNovelAiTtsStatus(settings);
            return 'NovelAI 鉴权通过';
        }
        if (provider === 'gpt-sovits') {
            const speakers = await fetchGptSovitsSpeakers(settings?.ttsGsvEndpoint);
            return `GPT-SoVITS 可用，音色 ${speakers.length} 个`;
        }
        // MiniMax 没有音色/模型列表接口，用一次极短的合成来验证 key + host。
        await synthesizeMinimax('你好', { ...settings, ttsMinimaxFormat: settings?.ttsMinimaxFormat || 'mp3' });
        return 'MiniMax 鉴权通过';
    };

    // 当前 provider 的音色下拉项。
    const listVoices = (settings) => {
        const provider = String(settings?.ttsProvider || 'minimax');
        if (provider === 'novel') {
            const custom = toArray(settings?.ttsNovelCustomVoices).map(item => String(item || '').trim()).filter(Boolean);
            return [...NOVEL_BUILTIN_VOICES, ...custom].map(name => ({ value: name, label: name }));
        }
        if (provider === 'gpt-sovits') {
            return toArray(settings?.ttsGsvSpeakers).map(name => ({ value: String(name), label: String(name) }));
        }
        const custom = toArray(settings?.ttsMinimaxCustomVoices)
            .filter(item => item && item.voice_id);
        return [...MINIMAX_BUILTIN_VOICES, ...custom].map(item => ({
            value: item.voice_id,
            label: item.lang ? `${item.name}（${item.lang}）` : item.name
        }));
    };

    // ===== 播放器 =====
    // 单例：同一时刻只播一条。新的播放会打断旧的，stop() 会让等待中的 Promise 立刻结束。
    const createPlayer = () => {
        const audio = new Audio();
        audio.preload = 'auto';
        // 会话令牌：每次播放自增。stop() 或新的播放都会让旧令牌失效，并调用当时登记的
        // 中断回调，让正在等待「播完」的那个 Promise 立刻结束，后续片段也不再播放。
        let sessionId = 0;
        let currentUrl = '';
        let pendingInterrupt = null;

        const releaseUrl = () => {
            if (!currentUrl) return;
            try { URL.revokeObjectURL(currentUrl); } catch { /* 忽略 */ }
            currentUrl = '';
        };

        const clearSource = () => {
            try { audio.pause(); } catch { /* 忽略 */ }
            audio.removeAttribute('src');
            try { audio.load(); } catch { /* 忽略 */ }
            releaseUrl();
        };

        // 让当前会话失效：令牌 +1 并唤醒正在等待的那个 Promise。
        const invalidate = () => {
            sessionId += 1;
            const interrupt = pendingInterrupt;
            pendingInterrupt = null;
            if (interrupt) interrupt();
        };

        const stop = () => {
            invalidate();
            clearSource();
        };

        // 播放单个 Blob，等到播完（或被打断/出错）才 resolve。
        const playOne = (blob, options, token) => new Promise((resolve) => {
            let settled = false;
            const finish = () => {
                if (settled) return;
                settled = true;
                audio.removeEventListener('ended', finish);
                audio.removeEventListener('error', finish);
                if (pendingInterrupt === finish) pendingInterrupt = null;
                resolve();
            };

            audio.addEventListener('ended', finish);
            audio.addEventListener('error', finish);

            releaseUrl();
            currentUrl = URL.createObjectURL(blob);
            audio.src = currentUrl;
            audio.volume = clamp(Number(options.volume) ?? 1, 0, 1);
            audio.playbackRate = clamp(Number(options.rate) || 1, 0.5, 2);
            audio.play().catch(() => finish());

            // 令牌在等待期间失效（被 stop 或新播放顶掉）→ 立即结束本次等待。
            if (token !== sessionId) { finish(); return; }
            pendingInterrupt = finish;
        });

        const play = (blob, options = {}) => {
            invalidate();
            const token = sessionId;
            clearSource();
            return playOne(blob, options, token);
        };

        // 串行播放一串音频；中途 stop() 或新的播放会立刻中断且不再继续后续片段。
        const playSequence = async (blobs, options = {}) => {
            invalidate();
            const token = sessionId;
            clearSource();
            for (const blob of blobs) {
                if (token !== sessionId) return;
                await playOne(blob, options, token);
            }
        };

        const isPlaying = () => !audio.paused && !audio.ended && !!currentUrl;

        return Object.freeze({ play, playSequence, stop, isPlaying });
    };

    window.RPHubTts = Object.freeze({
        PROVIDERS,
        PROVIDER_LABELS,
        MINIMAX_MODELS,
        MINIMAX_HOSTS,
        MINIMAX_LANGUAGES,
        MINIMAX_BUILTIN_VOICES,
        MINIMAX_EMOTIONS,
        MINIMAX_EMOTION_MODELS,
        supportsMinimaxEmotion,
        NOVEL_BUILTIN_VOICES,
        GSV_TEXT_SPLIT_METHODS,
        GSV_LANGS,
        DEFAULTS,
        sanitizeText,
        splitText,
        synthesize,
        testConnection,
        fetchGptSovitsSpeakers,
        listVoices,
        resolveRefAudioPath,
        createPlayer,
        // 语音标记：解析 / 显示渲染 / 翻译 / 按角色分音色
        normalizeEmotion,
        parseVoiceScript,
        stripVoiceMarkers,
        stripAllMarkers,
        sanitizeWithPauses,
        translatePauses,
        defaultVoiceFor,
        resolveVoiceForName,
        buildSpeechParts
    });
})();
