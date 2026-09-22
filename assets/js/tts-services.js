// RP-Hub TTS 语音服务：MiniMax / NovelAI / GPT-SoVITS-V2 / 小米 MiMo-V2.5-TTS。
//
// 请求格式对齐 SillyTavern 官方 TTS 扩展与它的服务端实现：
//   - public/scripts/extensions/tts/minimax.js     + src/endpoints/minimax.js
//   - public/scripts/extensions/tts/novel.js       + src/endpoints/novelai.js 的 /generate-voice
//   - public/scripts/extensions/tts/gpt-sovits-v2.js
//
// MiMo-V2.5-TTS 不是「一堆参数 + 一个 endpoint」，而是**OpenAI 兼容的对话接口**：
//   POST {base}/chat/completions
//   body = { model, messages, audio }
//     - role: assistant 的 content 是「要念的文本」，文本内可插音频标签（（叹气）（停顿1秒））
//     - role: user 的 content 是「自然语言风格指令」（音色描述 / 导演演绎），voicesdesign 时必填
//     - audio = { format, voice }：voice 是预置音色 ID，或音色克隆的 DataURL 音频样本；
//       音色设计（voicedesign）**不传 voice**，音色完全由 user 的描述决定
//   响应：choices[0].message.audio.data（base64）
// 三个模型分工：mimo-v2.5-tts（预置音色/唱歌）、-voicedesign（文字设计音色）、-voiceclone（音频复刻音色）。
// 因此本站把「音色」做成带类型前缀的标识（preset: / design: / clone:），由音色决定用哪个模型。
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
        { value: 'gpt-sovits', label: 'GPT-SoVITS-V2' },
        { value: 'mimo', label: '小米 MiMo-V2.5-TTS' }
    ]);

    const MINIMAX_MODELS = Object.freeze([
        // 2.8 是当前主推的一代：官方 Audio 表里写明「40 languages / 7 emotions」，
        // 而 2.8-hd 的特色是 sound tags（语气词标签）——那是**只有 2.8 才有的能力**（见下）。
        { value: 'speech-2.8-hd', label: 'Speech-2.8-HD（最新・支持语气词）' },
        { value: 'speech-2.8-turbo', label: 'Speech-2.8-Turbo（最新・低延迟・支持语气词）' },
        // 2.6 已被官方归入 Legacy，但仍在售：同样 40 语言 + 7 情绪，**没有**语气词标签。
        { value: 'speech-2.6-hd', label: 'Speech-2.6-HD（旧版・高音质）' },
        { value: 'speech-2.6-turbo', label: 'Speech-2.6-Turbo（旧版・低延迟）' },
        { value: 'speech-02-hd', label: 'Speech-02-HD（旧版・高音质）' },
        { value: 'speech-02-turbo', label: 'Speech-02-Turbo（旧版・低延迟）' },
        { value: 'speech-01', label: 'Speech-01（更旧）' },
        { value: 'speech-01-240228', label: 'Speech-01-240228（更旧）' }
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
    // 官方 Audio 模型表：2.8 与 2.6 两代都写明「7 emotions supported」；
    // 更早的 02/01 只有部分模型支持该字段（官方文档只在部分模型上列出），按白名单放行。
    const MINIMAX_EMOTION_MODELS = Object.freeze([
        'speech-2.8-hd', 'speech-2.8-turbo',
        'speech-2.6-hd', 'speech-2.6-turbo',
        'speech-02-hd', 'speech-02-turbo', 'speech-01-turbo', 'speech-01-hd',
        'speech-2.5-hd-preview', 'speech-2.5-turbo-preview'
    ]);
    const supportsMinimaxEmotion = (model) => MINIMAX_EMOTION_MODELS.includes(String(model || '').trim());

    // MiniMax「语气词 / 非语言标签」（sound tags / interjection tags）：
    // 写在待合成文本里的英文圆括号标签，如 `(laughs)`、`(sighs)`、`(clear-throat)`。
    //
    // **官方 T2A HTTP 文档明确：仅在 speech-2.8-hd / speech-2.8-turbo 上生效。**
    // 2.6 与 02 系列都不支持——在那些模型上写标签会被当普通文本逐字念出来
    // （「(sighs)」→「括号 sighs 括号」），所以必须按模型白名单分流下发。
    const MINIMAX_INTERJECTIONS = Object.freeze([
        'laughs', 'chuckle', 'coughs', 'clear-throat', 'groans', 'breath', 'pant',
        'inhale', 'exhale', 'gasps', 'sniffs', 'sighs', 'snorts', 'burps',
        'lip-smacking', 'humming', 'hissing', 'emm', 'sneezes'
    ]);
    const MINIMAX_INTERJECTION_MODELS = Object.freeze(['speech-2.8-hd', 'speech-2.8-turbo']);
    const supportsMinimaxInterjection = (model) => MINIMAX_INTERJECTION_MODELS.includes(String(model || '').trim());

    // 中文语气词 → 官方英文标签。AI 写的是与 MiMo 共用的统一标记 `[[sfx:叹气]]`（中文），
    // 由这里翻成 MiniMax 认的英文标签；AI 直接写 `[[sfx:sighs]]` 也认（见 normalizeMinimaxInterjection）。
    // 只映射官方 HTTP 文档列出的标签——不认识的绝不臆造（发了不存在的标签同样会被念出来）。
    const MINIMAX_SFX_ALIASES = Object.freeze({
        '笑': 'laughs', '大笑': 'laughs', '笑出声': 'laughs', '哈哈': 'laughs', '噗嗤': 'laughs', '放声大笑': 'laughs',
        '轻笑': 'chuckle', '偷笑': 'chuckle', '嗤笑': 'chuckle', '苦笑': 'chuckle', '低声笑': 'chuckle', '干笑': 'chuckle',
        '咳嗽': 'coughs', '咳': 'coughs', '清嗓子': 'clear-throat', '清清嗓子': 'clear-throat', '咳了一声': 'clear-throat',
        '呻吟': 'groans', '闷哼': 'groans', '痛苦出声': 'groans',
        '呼吸': 'breath', '呼吸声': 'breath', '换气': 'breath',
        '喘气': 'pant', '喘息': 'pant', '气喘': 'pant', '急促呼吸': 'pant',
        '吸气': 'inhale', '深呼吸': 'inhale', '深吸一口气': 'inhale', '倒吸一口气': 'gasps', '抽气': 'gasps', '惊呼': 'gasps',
        '呼气': 'exhale', '吐气': 'exhale', '长出一口气': 'exhale', '舒一口气': 'exhale',
        '抽鼻子': 'sniffs', '吸鼻子': 'sniffs', '嗅了嗅': 'sniffs', '啜泣': 'sniffs',
        '叹气': 'sighs', '长叹一口气': 'sighs', '叹息': 'sighs', '叹口气': 'sighs', '唉声叹气': 'sighs',
        '哼': 'snorts', '冷哼': 'snorts', '鼻音': 'snorts', '嗤鼻': 'snorts', '哼一声': 'snorts',
        '打嗝': 'burps', '嗝': 'burps',
        '咂嘴': 'lip-smacking', '咂舌': 'lip-smacking', '舔嘴唇': 'lip-smacking', '咂了咂嘴': 'lip-smacking',
        '哼唱': 'humming', '哼歌': 'humming', '哼着歌': 'humming',
        '嘶': 'hissing', '嘶声': 'hissing', '嘶嘶声': 'hissing', '倒吸冷气': 'hissing',
        '嗯': 'emm', '呃': 'emm', '呃嗯': 'emm', '唔': 'emm', '嗯嗯': 'emm',
        '打喷嚏': 'sneezes', '喷嚏': 'sneezes', '阿嚏': 'sneezes'
    });

    // → 官方标签；认不出就返回空串（宁可不发，也不要发一个会被念出来的野生标签）。
    const normalizeMinimaxInterjection = (value) => {
        const raw = String(value || '').trim();
        if (!raw) return '';
        const lower = raw.toLowerCase();
        if (MINIMAX_INTERJECTIONS.includes(lower)) return lower;
        const mapped = MINIMAX_SFX_ALIASES[raw];
        return mapped && MINIMAX_INTERJECTIONS.includes(mapped) ? mapped : '';
    };

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

    // ===== 小米 MiMo-V2.5-TTS =====
    //
    // 音色标识带类型前缀，由音色本身决定用哪个模型（官方三个模型能力互斥，不能混用）：
    //   preset:冰糖        → mimo-v2.5-tts            预置音色（支持唱歌标签）
    //   design:播音员      → mimo-v2.5-tts-voicedesign 文本描述生成音色（描述写在 user content）
    //   clone:旁白样本     → mimo-v2.5-tts-voiceclone  音频样本复刻（DataURL 放 audio.voice）
    // 这样「预置 / 设计 / 克隆」三种音色可以同时存在于音色库与多角色绑定表里。
    const MIMO_DEFAULT_BASE = 'https://api.xiaomimimo.com/v1';
    const MIMO_VOICE_PREFIX = Object.freeze({ preset: 'preset:', design: 'design:', clone: 'clone:' });
    const MIMO_MODEL_BY_KIND = Object.freeze({
        preset: 'mimo-v2.5-tts',
        design: 'mimo-v2.5-tts-voicedesign',
        clone: 'mimo-v2.5-tts-voiceclone'
    });
    const MIMO_BUILTIN_VOICES = Object.freeze([
        { name: '冰糖', lang: '中文', gender: '女', style: '活泼少女' },
        { name: '茉莉', lang: '中文', gender: '女', style: '知性女声' },
        { name: '苏打', lang: '中文', gender: '男', style: '阳光少年' },
        { name: '白桦', lang: '中文', gender: '男', style: '成熟男声' },
        { name: 'Mia', lang: 'English', gender: 'Female', style: 'Lively girl' },
        { name: 'Chloe', lang: 'English', gender: 'Female', style: 'Sweet Dreamy' },
        { name: 'Milo', lang: 'English', gender: 'Male', style: 'Sunny boy' },
        { name: 'Dean', lang: 'English', gender: 'Male', style: 'Steady Gentle' }
    ]);
    const MIMO_VOICE_CLONE_MAX_BYTES = 10 * 1024 * 1024;
    const MIMO_FORMATS = Object.freeze([
        { value: 'wav', label: 'WAV', mime: 'audio/wav' },
        { value: 'mp3', label: 'MP3', mime: 'audio/mpeg' },
        { value: 'pcm16', label: 'PCM16（仅流式）', mime: 'audio/pcm' }
    ]);
    // 官方音频标签白名单（只收「能发出声音」的内容）。
    // 用途有两个：① 世界书/AI 侧给出可用词表；② 清洗时把括号写法的音频标签从「动作补白」里救出来
    // （否则 `（叹气）` 会被 stripActions 的括号规则当动作删掉，MiMo 就失去这条表演提示）。
    // 判定用的是「整个括号必须全部由词表词组成」，所以词表加得宽也不会把动作描写放进来。
    const MIMO_AUDIO_TAG_WORDS = Object.freeze([
        // 语速与节奏
        '吸气', '深呼吸', '深吸一口气', '吐气', '呼气', '叹气', '长叹一口气', '叹息',
        '喘息', '喘气', '屏息', '屏住呼吸', '沉默', '沉默片刻', '语速加快', '语速放缓', '语速放慢',
        '拖音', '急促', '结巴', '停顿',
        // 情绪状态
        '紧张', '害怕', '激动', '疲惫', '委屈', '撒娇', '心虚', '震惊', '不耐烦', '无语', '尴尬',
        // 语音特征
        '颤抖', '声音颤抖', '变调', '破音', '鼻音', '气声', '沙哑', '轻声', '低声', '低语', '耳语',
        '小声', '轻语', '强调', '重音', '哭腔', '压低声音', '提高音量', '喊话', '喊', '吼', '尖叫', '咆哮',
        // 哭笑表达
        '笑', '轻笑', '大笑', '冷笑', '苦笑', '嗤笑', '哼笑', '笑出声', '抽泣', '呜咽', '哽咽',
        '嚎啕大哭', '嚎哭', '哭', '碎碎念', '吞口水', '吞咽', '咂嘴', '咳嗽', '清嗓子', '打哈欠',
        '叹气声', '喷气', '哼'
    ]);
    // 官方整体风格标签（写在文本开头，控制整段发音风格）。
    const MIMO_STYLE_TAGS = Object.freeze([
        { group: '基础情绪', items: ['开心', '悲伤', '愤怒', '恐惧', '惊讶', '兴奋', '委屈', '平静', '冷漠'] },
        { group: '复合情绪', items: ['怅然', '欣慰', '无奈', '愧疚', '释然', '嫉妒', '厌倦', '忐忑', '动情'] },
        { group: '整体语调', items: ['温柔', '高冷', '活泼', '严肃', '慵懒', '俏皮', '深沉', '干练', '凌厉'] },
        { group: '音色定位', items: ['磁性', '醇厚', '清亮', '空灵', '稚嫩', '苍老', '甜美', '沙哑', '醇雅'] },
        { group: '人设腔调', items: ['夹子音', '御姐音', '正太音', '大叔音', '台湾腔'] },
        { group: '方言', items: ['东北话', '四川话', '河南话', '粤语'] },
        { group: '唱歌', items: ['唱歌'] }
    ]);
    const MIMO_STYLE_CHOICES = Object.freeze(MIMO_STYLE_TAGS.flatMap(group => group.items));

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
        // 默认仍是 02-hd：2.8 虽然更新，但并非所有站点/账号都已开放，
        // 默认落到不支持的模型会让新用户第一次合成就报错。想用语气词的人自己切到 2.8。
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
        ttsGsvSpeakers: [],
        // --- 小米 MiMo-V2.5-TTS ---
        ttsMimoBaseUrl: MIMO_DEFAULT_BASE,
        ttsMimoKey: '',
        // 默认音色。带类型前缀（preset: / design: / clone:），见 MIMO_VOICE_PREFIX。
        ttsMimoVoice: `${MIMO_VOICE_PREFIX.preset}${MIMO_BUILTIN_VOICES[0].name}`,
        ttsMimoFormat: 'wav',
        // 音色设计库：[{ name, description }]，description 就是官方要求的「音色描述」（AI 可代写）
        ttsMimoVoiceDesigns: [],
        // 音色克隆库：[{ name, mime, data }]，data 是 base64（不含 dataURL 前缀，省体积）
        ttsMimoVoiceClones: [],
        // 导演演绎（角色 / 场景 / 指导 三维风格指令）：[{ name, direction }]，按角色名查
        ttsMimoDirections: [],
        // 没有任何角色匹配时使用的兜底导演演绎（旁白、临时角色）。
        ttsMimoDefaultDirection: '',
        // 是否把括号写法的音频标签（（叹气）（停顿1秒））当表演提示保留下来。
        // MiMo 的音频标签就是正文里的括号，关掉它会被「过滤动作与括号」当动作删掉。
        ttsMimoKeepAudioTags: true
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
    //   [[sfx:叹气]]               ← 发声动作/语气词（MiMo 翻成音频标签「（叹气）」，其他家丢弃）
    const VOICE_BLOCK_PATTERN = /\[\[voice:\s*([^\]|]+?)\s*(?:\|\s*([^\]]+?)\s*)?\]\]([\s\S]*?)\[\[\/voice\]\]/gi;
    const PAUSE_PATTERN = /\[\[pause:\s*(\d+(?:\.\d+)?)\s*\]\]/gi;
    const EMO_INLINE_PATTERN = /\[\[emo:\s*([a-z]+)\s*\]\]/gi;
    // 语气词 / 发声动作：只允许「能发出声音」的短词，不允许引号与尖括号
    // （replacement 只能拼字符串，挡住会破坏 HTML 属性的字符）。
    const SFX_PATTERN = /\[\[sfx:\s*([^\]"<>|\r\n]{1,24}?)\s*\]\]/gi;
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

    // MiMo 的情绪不是白名单枚举，而是**自然语言风格标签**：官方明确支持
    // 「压抑的愤怒」「带着哽咽的笑意」「温柔但疲惫」这类复合情绪。
    // 因此这里不查表，只做安全清洗（挡住会破坏文本/属性的字符）与长度限制。
    const normalizeMimoStyle = (value) => {
        const raw = String(value || '').replace(/[\r\n]/g, ' ').trim();
        if (!raw) return '';
        const clean = raw
            .replace(/[\[\]<>|]/g, '')
            .replace(/["'\u2018\u2019\u201c\u201d`]/g, '')
            .replace(/\s+/g, ' ')
            .trim();
        return clean.slice(0, 24);
    };

    // 括号写法的音频标签是否为「发声内容」（而不是动作补白）。
    // 只认官方词表 + 「停顿 x 秒」这类时长描述，宁可漏保护也不误留动作描写。
    const isMimoAudioTagInner = (inner) => {
        const text = String(inner || '').trim();
        if (!text) return false;
        // 先看整体是不是「停顿 x 秒」这类时长描述：它本身带空格，不能被下面的分词拆开。
        if (/^(?:长?停顿|沉默)\s*\d*(?:\.\d+)?\s*秒?$/.test(text)) return true;
        const parts = text.split(/[，,、;；\s]+/).filter(Boolean);
        if (!parts.length) return false;
        return parts.every(part => MIMO_AUDIO_TAG_WORDS.includes(part));
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
                // 情绪**原样保留**，不在解析阶段归一：MiniMax 只认 7 个英文枚举，
                // 而 MiMo 认「压抑的愤怒」这类自然语言复合情绪，归一是按 provider 各做各的
                // （见 resolveSegmentEmotion）。在这里先砍掉会让 MiMo 的复合情绪永远消失。
                emotion: String(match[2] || '').trim(),
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
    //   MiMo-V2.5   停顿/语气词都是「音频标签」——正文里的括号，如 `（停顿0.5秒）`、`（叹气）`；
    //               官方给的推荐标签是「[停顿]/[长停顿]」，但括号内自然语言它同样遵循
    //               （官方示例里就有「（沉默片刻）（长叹一口气）」），所以这里带上秒数，信息更完整。
    // 秒数归一：非数字按 0 处理，再夹进官方允许的 0.01–99.99。
    // 不能写成 `Number(v) || 0.5`——那会把合法的 `[[pause:0]]` 当成「没填」而悄悄改成 0.5。
    const normalizePauseSeconds = (value) => {
        const number = Number(value);
        return clamp(Number.isFinite(number) ? number : 0, 0.01, 99.99);
    };

    // MiMo 的停顿音频标签。>1 秒用「长停顿」，口播上更接近官方推荐措辞。
    const mimoPauseTag = (value) => {
        const number = Number(value);
        const seconds = clamp(Number.isFinite(number) ? number : 0.3, 0.1, 10);
        const label = seconds >= 1 ? '长停顿' : '停顿';
        // 1 → "1"，0.5 → "0.5"：去掉小数点上多余的 0，读起来更像自然语言。
        return `（${label}${String(Number(seconds.toFixed(1)))}秒）`;
    };

    // 连续停顿合并（`[[pause:0.3]][[pause:0.2]]` → 一个 0.5 秒）。
    const mergeConsecutivePauses = (text) => text.replace(/(?:\[\[pause:\s*\d+(?:\.\d+)?\s*\]\]\s*)+/gi, (run) => {
        const total = [...run.matchAll(freshRegex(PAUSE_PATTERN.source, 'gi'))]
            .reduce((sum, item) => sum + normalizePauseSeconds(item[1]), 0);
        return `[[pause:${normalizePauseSeconds(total)}]]`;
    });

    const translatePauses = (raw, provider) => {
        // 原生语法先归一成统一标记，再按当前 provider 翻译回它自己的形式——
        // 这样「AI 直接写了 <#0.5#>」与「AI 写了 [[pause:0.5]]」走同一条路径。
        let text = normalizeNativePauses(raw);
        if (!PAUSE_PATTERN.test(text)) return text;
        PAUSE_PATTERN.lastIndex = 0;

        if (provider === 'mimo') {
            text = mergeConsecutivePauses(text);
            return text.replace(PAUSE_PATTERN, (full, seconds) => mimoPauseTag(seconds));
        }

        if (provider === 'minimax') {
            // 先把连续停顿合并成一个：官方明确「不能设置多个连续的时间间隔」。
            text = mergeConsecutivePauses(text);
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

    // 语气词 / 发声动作标记（`[[sfx:叹气]]`）按 provider 落地：
    //   MiniMax 2.8 → 翻成官方英文语气词标签 `(sighs)`（**只有 2.8 支持**，见 MINIMAX_INTERJECTION_MODELS）
    //   MiMo       → 翻成官方音频标签 `（叹气）`，原样进入合成文本（模型会把它演出来，不念字面）
    //   其他家（含 MiniMax 2.6/02）→ 直接丢弃：没有这个能力，留着只会被逐字念出来
    // options.minimaxModel 决定 MiniMax 走哪条分支——这就是「按模型白名单分流」的落点。
    const translateSfx = (raw, provider, options = {}) => {
        const text = String(raw ?? '');
        if (provider === 'mimo') {
            return text.replace(SFX_PATTERN, (full, word) => `（${String(word).trim()}）`);
        }
        if (provider === 'minimax') {
            if (!supportsMinimaxInterjection(options.minimaxModel)) return text.replace(SFX_PATTERN, '');
            return text.replace(SFX_PATTERN, (full, word) => {
                const tag = normalizeMinimaxInterjection(word);
                return tag ? `(${tag})` : '';
            });
        }
        return text.replace(SFX_PATTERN, '');
    };

    // 标记翻译的统一入口：停顿 + 语气词。所有合成路径都必须走这里，
    // 否则会出现「停顿翻译了、语气词却原样念出来」这类半边生效。
    const translateVoiceMarkers = (raw, provider, options = {}) => (
        translateSfx(translatePauses(raw, provider), provider, options)
    );

    // ===== MiMo 音色标识：由音色决定模型 =====
    // 值为 `preset:冰糖` / `design:播音员` / `clone:旁白样本`。裸名（老存档、手写绑定）
    // 按 设计库 → 克隆库 → 预置音色 的顺序兜底识别，避免升级后绑定集体失效。
    const mimoVoiceValue = (kind, key) => `${MIMO_VOICE_PREFIX[kind]}${String(key || '').trim()}`;

    const resolveMimoVoice = (settings, value) => {
        const raw = String(value || '').trim();
        const designs = toArray(settings?.ttsMimoVoiceDesigns);
        const clones = toArray(settings?.ttsMimoVoiceClones);
        const findByName = (list, name) => list.find(item => String(item?.name || '').trim() === name) || null;
        if (!raw) return { kind: 'preset', key: '', id: '', entry: null, value: '' };

        if (raw.startsWith(MIMO_VOICE_PREFIX.design)) {
            const key = raw.slice(MIMO_VOICE_PREFIX.design.length).trim();
            return { kind: 'design', key, id: '', entry: findByName(designs, key), value: raw };
        }
        if (raw.startsWith(MIMO_VOICE_PREFIX.clone)) {
            const key = raw.slice(MIMO_VOICE_PREFIX.clone.length).trim();
            return { kind: 'clone', key, id: '', entry: findByName(clones, key), value: raw };
        }
        if (raw.startsWith(MIMO_VOICE_PREFIX.preset)) {
            const key = raw.slice(MIMO_VOICE_PREFIX.preset.length).trim();
            return { kind: 'preset', key, id: key, entry: null, value: raw };
        }

        const design = findByName(designs, raw);
        if (design) return { kind: 'design', key: raw, id: '', entry: design, value: mimoVoiceValue('design', raw) };
        const clone = findByName(clones, raw);
        if (clone) return { kind: 'clone', key: raw, id: '', entry: clone, value: mimoVoiceValue('clone', raw) };
        return { kind: 'preset', key: raw, id: raw, entry: null, value: mimoVoiceValue('preset', raw) };
    };

    // 克隆音色的音频样本 → DataURL（官方要求 audio.voice 传 DataURL 编码的音频）。
    const buildMimoVoiceSampleUrl = (entry) => {
        const data = String(entry?.data || '').trim();
        if (!data) return '';
        if (/^data:/i.test(data)) return data;
        const mime = String(entry?.mime || 'audio/wav').trim() || 'audio/wav';
        return `data:${mime};base64,${data}`;
    };

    const mimoFormatOf = (value) => MIMO_FORMATS.find(item => item.value === String(value || '')) || MIMO_FORMATS[0];

    // 用户填的 base 可能带或不带 /v1（官方默认 https://api.xiaomimimo.com/v1，
    // 自建网关常常只写到域名），这里统一补成 OpenAI 兼容的 /v1 形态。
    const normalizeMimoBaseUrl = (value) => {
        const base = normalizeBaseUrl(value || MIMO_DEFAULT_BASE);
        return /\/v\d+$/.test(base) ? base : `${base}/v1`;
    };

    // 角色 → 导演演绎。官方推荐的「导演模式」是三段式：角色 / 场景 / 指导（见世界书提示词）。
    const resolveMimoDirection = (settings, name) => {
        const target = String(name || '').trim();
        if (target) {
            const hit = toArray(settings?.ttsMimoDirections)
                .find(item => String(item?.name || '').trim() === target);
            const text = String(hit?.direction || '').trim();
            if (text) return text;
        }
        return String(settings?.ttsMimoDefaultDirection || '').trim();
    };

    // 组装 user content（风格指令）。三块内容的分工：
    //   【音色】    仅音色设计用：官方要求 voicedesign 必须由文字描述决定音色
    //   【导演演绎】角色 / 场景 / 指导 三段式，按角色名查表（AI 代写，见设置页）
    //   【本轮情绪】来自 [[voice:角色|情绪]]，MiMo 认复合情绪（「压抑的愤怒」）
    const buildMimoStyleInstruction = (settings, options, voice) => {
        const sections = [];
        if (voice?.kind === 'design') {
            const description = String(voice.entry?.description || '').trim();
            if (description) sections.push(`【音色】${description}`);
        }
        const direction = resolveMimoDirection(settings, options?.name);
        if (direction) sections.push(`【导演演绎】\n${direction}`);
        const emotion = normalizeMimoStyle(options?.emotion);
        if (emotion) sections.push(`【本轮情绪】${emotion}`);
        return sections.join('\n\n');
    };

    // 情绪落地为「整体风格标签」——官方规定它必须写在待合成文本的开头。
    // 因为本站按 [[voice:...]] 逐句分段合成，每段文本开头正好就是这句台词的开头。
    const applyMimoStyleTag = (text, emotion) => {
        const style = normalizeMimoStyle(emotion);
        return style ? `（${style}）${text}` : text;
    };

    // 纯函数：算出一次 MiMo 合成请求的全部内容（便于单测与「查看实际请求」类调试）。
    const buildMimoRequest = (text, settings, options = {}) => {
        const apiKey = String(settings?.ttsMimoKey || '').trim();
        if (!apiKey) throw new Error('未填写 MiMo API Key');
        const spoken = String(text ?? '').trim();
        if (!spoken) throw new Error('要合成的文本是空的');

        const voice = resolveMimoVoice(settings, options.voice || settings?.ttsMimoVoice);
        if (voice.kind === 'preset' && !voice.id) throw new Error('未选择 MiMo 音色');
        if (voice.kind === 'design' && !String(voice.entry?.description || '').trim()) {
            throw new Error(`音色「${voice.key}」还没有音色描述：MiMo 音色设计必须靠一段文字描述生成音色`);
        }
        if (voice.kind === 'clone' && !buildMimoVoiceSampleUrl(voice.entry)) {
            throw new Error(`音色「${voice.key}」还没有音频样本：MiMo 音色克隆需要一段 mp3/wav 样本`);
        }

        const model = MIMO_MODEL_BY_KIND[voice.kind];
        const format = mimoFormatOf(settings?.ttsMimoFormat).value;
        const messages = [];
        const style = buildMimoStyleInstruction(settings, options, voice);
        // user 是「风格指令」，assistant 才是「要念的文本」——官方明确要求目标文本放 assistant，
        // 放反了会被当成对话历史（不合成或合成出指令本身）。
        if (style) messages.push({ role: 'user', content: style });
        messages.push({ role: 'assistant', content: applyMimoStyleTag(spoken, options.emotion) });

        const audio = { format };
        // 音色设计不传 voice（音色完全由描述决定）；预置传音色 ID；克隆传音频样本 DataURL。
        if (voice.kind === 'preset') audio.voice = voice.id;
        if (voice.kind === 'clone') audio.voice = buildMimoVoiceSampleUrl(voice.entry);

        return {
            url: `${normalizeMimoBaseUrl(settings?.ttsMimoBaseUrl)}/chat/completions`,
            model,
            voiceKind: voice.kind,
            voiceKey: voice.key,
            messages,
            audio,
            headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
            body: { model, messages, audio }
        };
    };

    // 当前 provider 的默认音色（没绑定的角色走它）。
    const defaultVoiceFor = (settings) => {
        const provider = String(settings?.ttsProvider || 'minimax');
        if (provider === 'novel') return String(settings?.ttsNovelVoice || '').trim();
        if (provider === 'gpt-sovits') return String(settings?.ttsGsvRefAudio || '').trim();
        if (provider === 'mimo') return String(settings?.ttsMimoVoice || '').trim();
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
    //
    // 注意 keepAudioTags（MiMo 专用）：MiMo 的表演提示就是**正文里的括号**
    // （（叹气）（停顿1秒）（语速加快）），而 stripActions 的括号规则正是要删括号。
    // 所以开启该选项时，先把「确实是发声内容」的括号挖成「洞」跳过清洗，其余规则照常跑。
    // 判断只认官方标签词表与「停顿 x 秒」（见 isMimoAudioTagInner），
    // 这样 `（她走上舞台）` 这种动作补白仍会被删掉——宁可漏保护，不能把动作念出来。
    const AUDIO_TAG_HOLE_PATTERN = /\[\[pause:\s*\d+(?:\.\d+)?\s*\]\]|\[\[sfx:\s*[^\]"<>|\r\n]{1,24}?\]\]|[（(]\s*([^）)\n]{1,30}?)\s*[）)]/gi;

    const splitAudioTagHoles = (source, { markers = false, audioTags = false } = {}) => {
        const pieces = [];
        const pattern = freshRegex(AUDIO_TAG_HOLE_PATTERN.source, AUDIO_TAG_HOLE_PATTERN.flags);
        let cursor = 0;
        let match;
        while ((match = pattern.exec(source)) !== null) {
            // 分支 1/2 是双方括号标记（[[pause:x]] / [[sfx:x]]）；分支 3 是括号写法的音频标签。
            const isMarker = match[1] === undefined;
            const keep = isMarker ? markers : (audioTags && isMimoAudioTagInner(match[1]));
            if (!keep) continue;
            if (match.index > cursor) pieces.push({ text: source.slice(cursor, match.index), protect: false });
            pieces.push({ text: match[0], protect: true });
            cursor = match.index + match[0].length;
        }
        if (cursor < source.length) pieces.push({ text: source.slice(cursor), protect: false });
        return pieces;
    };

    const sanitizePlain = (raw, options = {}) => {
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

    // 清洗入口：默认走纯清洗。两个保护开关互相独立，因为它们的适用面不同：
    //   keepInlineMarkers → 保护 [[pause:x]] / [[sfx:x]] 标记（sanitizeWithPauses 永远打开，
    //                       因为合成前还要靠这些标记做 provider 翻译）
    //   keepAudioTags     → 保护括号写法的音频标签「（叹气）」（只有 MiMo 认这种写法）
    const sanitizeText = (raw, options = {}) => {
        const source = String(raw ?? '');
        if (!source.trim()) return '';
        const keepMarkers = options.keepInlineMarkers === true;
        const keepTags = options.keepAudioTags === true;
        if (!keepMarkers && !keepTags) return sanitizePlain(source, options);
        const pieces = splitAudioTagHoles(source, { markers: keepMarkers, audioTags: keepTags });
        if (!pieces.some(piece => piece.protect)) return sanitizePlain(source, options);
        return pieces
            .map(piece => (piece.protect ? piece.text : sanitizePlain(piece.text, options)))
            .join('')
            .replace(/[ \t\u00a0]+/g, ' ')
            .replace(/\s*\n\s*/g, ' ')
            .trim();
    };

    // 清洗一段文本，但**保留** `[[pause:x]]` / `[[sfx:x]]` 标记
    // （合成路径用；点击单句台词朗读也走这里）。
    // 做法：让清洗把标记当「洞」跳过——这样清洗规则看不到标记，标记也不会被 stripAllMarkers 吃掉，
    // 之后交给 translateVoiceMarkers 翻成当前 provider 的原生语法。
    //
    // keepAudioTags（括号写法的音频标签）**必须由调用方按 provider 传**：
    // 属性里已经渲染成 `（叹气）`、正文里也可能直接写 `（叹气）`，只有 MiMo 认得它；
    // 对 MiniMax/NovelAI/GPT-SoVITS 保留括号就等于把「（叹气）」当台词念出来。
    const sanitizeWithPauses = (raw, options = {}) => {
        const source = normalizeNativePauses(raw);
        const out = sanitizeText(source, {
            ...options,
            // 标记一定要保住（合成前还要按 provider 翻译）；括号音频标签按调用方（provider）决定。
            keepInlineMarkers: true,
            keepAudioTags: options.keepAudioTags === true
        });
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

    // ===== 小米 MiMo-V2.5-TTS =====
    // 音频是 base64（响应里 choices[0].message.audio.data），不是 hex——与 MiniMax 正好相反。
    const base64ToBytes = (value) => {
        const clean = String(value || '').replace(/\s/g, '');
        if (!clean) throw new Error('MiMo 返回的音频数据为空');
        let binary = '';
        try {
            binary = atob(clean);
        } catch {
            throw new Error('MiMo 返回的音频不是合法 base64 数据');
        }
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        return bytes;
    };

    const describeMimoError = (data, raw, status) => {
        const detail = data?.error?.message
            || data?.message
            || (typeof data?.error === 'string' ? data.error : '')
            || (data ? '' : String(raw || '').slice(0, 200));
        return `MiMo TTS 请求失败（HTTP ${status}）${detail ? `：${detail}` : ''}`;
    };

    const synthesizeMimo = async (text, settings, options = {}) => {
        const request = buildMimoRequest(text, settings, options);
        const response = await fetch(request.url, {
            method: 'POST',
            headers: request.headers,
            body: JSON.stringify(request.body)
        });
        const raw = await response.text();
        let data = null;
        try { data = JSON.parse(raw); } catch { /* 非 JSON 响应，下面按状态码报错 */ }
        if (!response.ok) throw new Error(describeMimoError(data, raw, response.status));
        if (data?.error) {
            const message = data.error?.message || JSON.stringify(data.error).slice(0, 200);
            throw new Error(`MiMo TTS 返回错误：${message}`);
        }
        const audio = data?.choices?.[0]?.message?.audio?.data;
        if (!audio) throw new Error('MiMo 未返回音频数据（choices[0].message.audio.data 为空）');
        return new Blob([base64ToBytes(audio)], { type: mimoFormatOf(settings?.ttsMimoFormat).mime });
    };

    // ===== 统一入口 =====
    const synthesize = (text, settings, options = {}) => {
        const provider = String(settings?.ttsProvider || 'minimax');
        // 停顿与语气词都按 provider 翻译成它自己的语法
        // （MiMo 是括号音频标签；MiniMax 是 <#x#> 停顿，语气词标签只有 2.8 能收）。
        const spoken = translateVoiceMarkers(text, provider, { minimaxModel: settings?.ttsMinimaxModel });
        if (provider === 'novel') return synthesizeNovel(spoken, settings, options);
        if (provider === 'gpt-sovits') return synthesizeGptSovits(spoken, settings, options);
        if (provider === 'mimo') return synthesizeMimo(spoken, settings, options);
        return synthesizeMinimax(spoken, settings, options);
    };

    // 情绪按 provider 归一：MiniMax 只认 7 个英文枚举，MiMo 认自然语言复合情绪。
    const resolveSegmentEmotion = (emotion, provider) => (
        provider === 'mimo' ? normalizeMimoStyle(emotion) : normalizeEmotion(emotion)
    );

    // 把一条消息按「语音块」拆成待合成片段。
    // 每段带上自己的音色与情绪；旁白段用默认音色。
    // 返回 [{ text, voice, emotion, name, type }]，已经清洗并翻译过停顿/语气词标记。
    const buildSpeechParts = (raw, settings, options = {}) => {
        const segments = parseVoiceScript(normalizeNativePauses(raw));
        const source = segments.length ? segments : [{ type: 'narration', name: '', emotion: '', text: String(raw ?? '') }];
        const provider = String(settings?.ttsProvider || 'minimax');
        const sanitizeOptions = {
            stripActions: options.stripActions !== false,
            readDialogueOnly: options.readDialogueOnly === true
        };
        const parts = [];
        source.forEach(segment => {
            // 必须用「保留标记」的清洗：普通 sanitizeText 会把 [[pause:x]] 一起清掉，
            // 后面的 translateVoiceMarkers 就无从翻译了（整条消息朗读会丢掉所有停顿）。
            // keepAudioTags 只对 MiMo 打开：只有它认得括号写法的音频标签。
            const clean = sanitizeWithPauses(segment.text, {
                ...sanitizeOptions,
                keepAudioTags: provider === 'mimo'
            });
            if (!clean) return;
            // 只有台词段才带角色音色；旁白固定走默认音色。
            const voice = segment.type === 'speech' ? resolveVoiceForName(settings, segment.name) : defaultVoiceFor(settings);
            parts.push({
                type: segment.type,
                name: segment.name,
                emotion: resolveSegmentEmotion(segment.emotion, provider),
                voice,
                // MiMo 的整体风格标签要在翻译前贴到文本开头（它规定标签必须在开头）。
                text: applyMimoStyleTag(
                    translateVoiceMarkers(clean, provider, { minimaxModel: settings?.ttsMinimaxModel }),
                    provider === 'mimo' ? segment.emotion : ''
                )
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
        if (provider === 'mimo') {
            // MiMo 没有音色/模型列表接口，用一次极短的合成验证 key（并顺带验证音色配置是否可用）。
            const request = buildMimoRequest('你好', settings, {});
            const response = await fetch(request.url, {
                method: 'POST',
                headers: request.headers,
                body: JSON.stringify(request.body)
            });
            if (!response.ok) {
                const raw = await response.text();
                let data = null;
                try { data = JSON.parse(raw); } catch { /* 忽略 */ }
                throw new Error(describeMimoError(data, raw, response.status));
            }
            return `MiMo 鉴权通过（${request.model}）`;
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
        if (provider === 'mimo') {
            // 三类音色同列：预置（官方 8 个）+ 音色设计 + 音色克隆。
            const presets = MIMO_BUILTIN_VOICES.map(item => ({
                value: mimoVoiceValue('preset', item.name),
                label: `${item.name}（${[item.lang, item.gender, item.style].filter(Boolean).join('·')}）`
            }));
            const designs = toArray(settings?.ttsMimoVoiceDesigns)
                .filter(item => String(item?.name || '').trim())
                .map(item => ({ value: mimoVoiceValue('design', item.name), label: `设计音色：${String(item.name).trim()}` }));
            const clones = toArray(settings?.ttsMimoVoiceClones)
                .filter(item => String(item?.name || '').trim())
                .map(item => ({ value: mimoVoiceValue('clone', item.name), label: `克隆音色：${String(item.name).trim()}` }));
            return [...presets, ...designs, ...clones];
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
        MINIMAX_INTERJECTIONS,
        MINIMAX_INTERJECTION_MODELS,
        MINIMAX_SFX_ALIASES,
        supportsMinimaxInterjection,
        normalizeMinimaxInterjection,
        NOVEL_BUILTIN_VOICES,
        GSV_TEXT_SPLIT_METHODS,
        GSV_LANGS,
        // 小米 MiMo-V2.5-TTS
        MIMO_DEFAULT_BASE,
        MIMO_VOICE_PREFIX,
        MIMO_MODEL_BY_KIND,
        MIMO_BUILTIN_VOICES,
        MIMO_FORMATS,
        MIMO_AUDIO_TAG_WORDS,
        MIMO_STYLE_TAGS,
        MIMO_STYLE_CHOICES,
        MIMO_VOICE_CLONE_MAX_BYTES,
        mimoVoiceValue,
        resolveMimoVoice,
        buildMimoVoiceSampleUrl,
        normalizeMimoBaseUrl,
        normalizeMimoStyle,
        isMimoAudioTagInner,
        resolveMimoDirection,
        buildMimoStyleInstruction,
        applyMimoStyleTag,
        buildMimoRequest,
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
        translateSfx,
        translateVoiceMarkers,
        defaultVoiceFor,
        resolveVoiceForName,
        buildSpeechParts
    });
})();
