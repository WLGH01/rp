// RP-Hub message rendering and application composables.

// --- Message renderer ---
(function () {
    const MAX_CACHE_SIZE = 2000;

    const createMessageRenderer = ({ processRegex, replaceUserPlaceholder, createExecutableHtmlIframe, marked, DOMPurify }) => {
        const renderedCache = new Map();
        const frameDetectionCache = new Map();

        const cacheValue = (cache, key, value) => {
            cache.set(key, value);
            if (cache.size > MAX_CACHE_SIZE) cache.delete(cache.keys().next().value);
            return value;
        };

        const clearCaches = () => {
            renderedCache.clear();
            frameDetectionCache.clear();
        };

        const applyDisplayRegex = (text, role, skipRegex) => {
            const replaced = replaceUserPlaceholder(text);
            return skipRegex ? replaced : processRegex(replaced, { isDisplay: true, role });
        };

        const contentUsesHtmlFrame = (text, role = 'assistant', skipRegex = false) => {
            if (!text) return false;
            const cacheKey = `${role}_${skipRegex}_${text}`;
            if (frameDetectionCache.has(cacheKey)) return frameDetectionCache.get(cacheKey);

            const trimmed = applyDisplayRegex(text, role, skipRegex).trim();
            let usesFrame = false;
            const codeFencePattern = /```([^\n`]*)\n?([\s\S]*?)```/g;
            let codeMatch;
            while ((codeMatch = codeFencePattern.exec(trimmed)) !== null) {
                const language = codeMatch[1] || '';
                const content = codeMatch[2] || '';
                if (/\b(html|xml)\b/i.test(language)
                    || /^\s*<(!doctype|html|head|body|div|span|style|script|table|img)/i.test(content)) {
                    usesFrame = true;
                    break;
                }
            }
            if (!usesFrame && !trimmed.includes('```')) {
                usesFrame = /(<!doctype html>|<html\b[^>]*>|^\s*<(style|script)\b)/i.test(trimmed);
            }
            return cacheValue(frameDetectionCache, cacheKey, usesFrame);
        };

        const cleanConfig = {
            ADD_TAGS: ['details', 'summary', 'iframe', 'svg', 'path', 'g', 'circle', 'rect', 'defs', 'linearGradient', 'stop', 'style', 'div', 'span', 'script', 'button', 'input'],
            // data-tts-* 是语音框的点击数据，被 DOMPurify 剥掉的话点朗读就拿不到台词与音色。
            ADD_ATTR: ['style', 'open', 'srcdoc', 'sandbox', 'frameborder', 'allow', 'allowfullscreen', 'class', 'id', 'viewBox', 'fill', 'stroke', 'stroke-width', 'd', 'stroke-linecap', 'stroke-linejoin', 'x1', 'y1', 'x2', 'y2', 'offset', 'stop-color', 'stop-opacity', 'width', 'height', 'onclick', 'type', 'value', 'checked', 'data-slash', 'data-tts-name', 'data-tts-emotion', 'data-tts-text', 'role', 'tabindex', 'title'],
            FORBID_ATTR: ['onmouseover', 'onload'],
            FORCE_BODY: true
        };

        const sanitizeMarkdown = (text) => DOMPurify.sanitize(marked.parse(text), cleanConfig);
        const markdownOnlyRenderer = new marked.Renderer();
        markdownOnlyRenderer.html = token => String(typeof token === 'string' ? token : token.text)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        const createIframe = (html) => createExecutableHtmlIframe(html, 'border-t border-gray-200 shadow-sm');

        const replaceHtmlCodeBlocks = (documentNode) => {
            let modified = false;
            documentNode.querySelectorAll('pre code').forEach(block => {
                const rawHtml = block.textContent;
                const hasHtmlLanguage = block.classList.contains('language-html') || block.classList.contains('language-xml');
                const looksLikeHtml = /^\s*<(!doctype|html|head|body|div|span|style|script|table|img)/i.test(rawHtml);
                if (!hasHtmlLanguage && !looksLikeHtml) return;
                const pre = block.parentElement;
                if (!pre?.parentNode) return;
                pre.parentNode.replaceChild(createIframe(rawHtml), pre);
                modified = true;
            });
            return modified;
        };

        const replaceEscapedHtmlParagraphs = (documentNode) => {
            let modified = false;
            documentNode.querySelectorAll('p').forEach(paragraph => {
                if (!/^\s*</.test(paragraph.innerHTML)) return;
                const rawHtml = paragraph.textContent;
                if (!/^\s*<(!doctype|html|head|body|div|span|style|script|table|img)/i.test(rawHtml)) return;
                if (!paragraph.parentNode) return;
                paragraph.parentNode.replaceChild(createIframe(rawHtml), paragraph);
                modified = true;
            });
            return modified;
        };

        const replaceScriptedPanels = (documentNode) => {
            let modified = false;
            documentNode.querySelectorAll('div[style*="position"], div[style*="background"], div[class*="panel"]').forEach(panel => {
                if (!panel.querySelector('script') || !panel.parentNode) return;
                panel.parentNode.replaceChild(createIframe(panel.outerHTML), panel);
                modified = true;
            });
            return modified;
        };

        const renderMarkdown = (text, role = 'assistant', skipRegex = false, allowHtml = true) => {
            if (!text) return '';
            const cacheKey = `${role}_${skipRegex}_${allowHtml}_${text}`;
            if (renderedCache.has(cacheKey)) return renderedCache.get(cacheKey);

            let processed = applyDisplayRegex(text, role, skipRegex);
            if (!allowHtml) {
                const html = DOMPurify.sanitize(marked.parse(processed, { renderer: markdownOnlyRenderer }));
                return cacheValue(renderedCache, cacheKey, html);
            }
            const trimmed = processed.trim();
            const htmlMatch = trimmed.match(/(<!doctype html>|<html\b[^>]*>)/i);

            if (htmlMatch && !trimmed.includes('```')) {
                const startIndex = htmlMatch.index;
                const closeTag = '</html>';
                const closeIndex = trimmed.toLowerCase().lastIndexOf(closeTag);
                const hasCloseTag = closeIndex !== -1 && closeIndex > startIndex;
                const endIndex = hasCloseTag ? closeIndex + closeTag.length : trimmed.length;
                const htmlContent = trimmed.substring(startIndex, endIndex);
                const preText = trimmed.substring(0, startIndex);
                const postText = hasCloseTag ? trimmed.substring(endIndex) : '';
                const container = document.createElement('div');
                container.className = 'html-card-container';
                container.style.margin = '0';
                container.style.paddingBottom = '0';
                container.style.marginBottom = '-1px';
                container.appendChild(createIframe(htmlContent));
                const result = [
                    preText.trim() ? sanitizeMarkdown(preText) : '',
                    container.outerHTML,
                    postText.trim() ? sanitizeMarkdown(postText) : ''
                ].join('');
                return cacheValue(renderedCache, cacheKey, result);
            }

            if (/^\s*<(div|table|section|article|aside|header|footer|style|script)/i.test(trimmed)
                && !trimmed.includes('```')) {
                return cacheValue(renderedCache, cacheKey, DOMPurify.sanitize(processed, cleanConfig));
            }

            const lowerTrimmed = trimmed.toLowerCase();
            if (lowerTrimmed.includes('<html') || lowerTrimmed.includes('<!doctype')) {
                processed = processed
                    .replace(/<!DOCTYPE html>/gi, '')
                    .replace(/<\/?html[^>]*>/gi, '')
                    .replace(/<\/?head[^>]*>/gi, '')
                    .replace(/<\/?body[^>]*>/gi, '');
            }

            const html = sanitizeMarkdown(processed);
            try {
                const documentNode = new DOMParser().parseFromString(html, 'text/html');
                const codeBlocksChanged = replaceHtmlCodeBlocks(documentNode);
                const paragraphsChanged = replaceEscapedHtmlParagraphs(documentNode);
                const panelsChanged = replaceScriptedPanels(documentNode);
                const modified = codeBlocksChanged || paragraphsChanged || panelsChanged;
                if (modified) return cacheValue(renderedCache, cacheKey, documentNode.body.innerHTML);
            } catch (error) {
                console.error('Error rendering HTML preview:', error);
            }
            return cacheValue(renderedCache, cacheKey, html);
        };

        return { clearCaches, contentUsesHtmlFrame, renderMarkdown };
    };

    window.RPHubMessageRenderer = Object.freeze({ createMessageRenderer });
})();

// --- Application composables ---
(function () {
    const { computed, reactive, ref, watch } = Vue;

    const useTokenUsage = ({
        pageSize = 10,
        cloneForStorage,
        confirm,
        ensureStorage,
        generateUUID,
        getApiKey,
        getApiUrl,
        normalizeApiUsage,
        saveStoredValue,
        toast
    }) => {
        const tokenUsageHistory = ref([]);
        const tokenUsagePage = ref(1);
        const tokenUsageFilter = ref('all');
        const tokenUsageTimeFilter = ref('all');
        const showTokenUsageTimeFilter = ref(false);
        const tokenUsageTimeFilterOptions = Object.freeze([
            { value: 'all', label: '全部' },
            { value: '24h', label: '24小时' },
            { value: '7d', label: '7天' },
            { value: '30d', label: '30天' }
        ]);
        const tokenUsageTimeRanges = Object.freeze({
            '24h': 24 * 60 * 60 * 1000,
            '7d': 7 * 24 * 60 * 60 * 1000,
            '30d': 30 * 24 * 60 * 60 * 1000
        });
        const tokenUsageTimeFilterLabel = computed(() => (
            tokenUsageTimeFilterOptions.find(option => option.value === tokenUsageTimeFilter.value)?.label || '全部'
        ));
        const getTokenUsageCategory = (type) => {
            if (['summary', 'embedding'].includes(type)) return 'memory';
            if (type === 'ui_template') return 'variables';
            return 'chat';
        };
        const filteredTokenUsageHistory = computed(() => {
            const timeRange = tokenUsageTimeRanges[tokenUsageTimeFilter.value];
            const cutoff = timeRange ? Date.now() - timeRange : 0;
            return tokenUsageHistory.value.filter(record => {
                const matchesType = tokenUsageFilter.value === 'all'
                    || getTokenUsageCategory(record.type) === tokenUsageFilter.value;
                if (!matchesType || !timeRange) return matchesType;
                const timestamp = Number(record.timestamp);
                return Number.isFinite(timestamp) && timestamp >= cutoff;
            });
        });
        const getUncachedInputTokens = (record) => {
            if (!Number.isFinite(record?.inputTokens)) return null;
            const cached = Number.isFinite(record.cacheReadTokens) ? record.cacheReadTokens : 0;
            return Math.max(0, record.inputTokens - cached);
        };
        const tokenUsageStats = computed(() => filteredTokenUsageHistory.value.reduce((stats, record) => {
            const inputTokens = getUncachedInputTokens(record);
            if (inputTokens !== null) {
                stats.inputTokens += inputTokens;
                stats.inputTokensReports++;
            }
            ['outputTokens', 'cacheReadTokens'].forEach(key => {
                if (!Number.isFinite(record[key])) return;
                stats[key] += record[key];
                stats[`${key}Reports`]++;
            });
            return stats;
        }, {
            inputTokens: 0,
            inputTokensReports: 0,
            outputTokens: 0,
            outputTokensReports: 0,
            cacheReadTokens: 0,
            cacheReadTokensReports: 0
        }));
        const tokenUsagePageCount = computed(() => Math.max(
            1,
            Math.ceil(filteredTokenUsageHistory.value.length / pageSize)
        ));
        const displayedTokenUsageHistory = computed(() => {
            const start = (tokenUsagePage.value - 1) * pageSize;
            return filteredTokenUsageHistory.value.slice(start, start + pageSize);
        });
        const latestMainTokenUsage = computed(() => tokenUsageHistory.value.find(
            record => record.type === 'chat' || record.type === 'tool_continuation'
        ) || null);
        const formatLatestTokenCount = value => {
            const count = Number(value || 0);
            if (count <= 0) return '0.00w';
            return `${Math.max(0.01, count / 10000).toFixed(2)}w`;
        };
        const formatLatestUsageCost = quota => Number.isFinite(quota)
            ? `¥${(Math.trunc(quota / 500000 * 10000) / 10000).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 4 })}`
            : '--';

        let saveQueue = Promise.resolve();
        const saveTokenUsageHistoryNow = () => {
            const snapshot = cloneForStorage(tokenUsageHistory.value);
            const saveTask = async () => {
                await ensureStorage();
                await saveStoredValue('token_usage_history', snapshot, { clone: false });
            };
            saveQueue = saveQueue.then(saveTask, saveTask);
            return saveQueue;
        };
        const fetchLatestQuota = async (record, apiKey) => {
            try {
                const getLogKey = log => String(log?.request_id || [log?.created_at, log?.model_name, log?.prompt_tokens, log?.completion_tokens].join('|'));
                for (const delay of [500, 5000]) {
                    await new Promise(resolve => setTimeout(resolve, delay));
                    const apiRoot = record.apiUrl.replace(/\/+$/, '').replace(/\/v1$/i, '');
                    const response = await fetch(`${apiRoot}/api/log/token`, {
                        headers: { Authorization: `Bearer ${apiKey}` }
                    });
                    if (!response.ok) throw new Error(`HTTP ${response.status}`);
                    const payload = await response.json();
                    const logs = Array.isArray(payload?.data) ? payload.data : (payload?.data?.items || []);
                    const claimedLogs = new Set(tokenUsageHistory.value.map(item => item.usageLogKey).filter(Boolean));
                    const log = logs.filter(item => !claimedLogs.has(getLogKey(item))
                        && Number(item?.type) === 2
                        && String(item?.model_name || '') === record.model
                        && Math.abs(Number(item?.created_at) * 1000 - record.timestamp) < 120000
                        && (!Number.isFinite(record.inputTokens) || Number(item?.prompt_tokens) === record.inputTokens)
                        && (!Number.isFinite(record.outputTokens) || Number(item?.completion_tokens) === record.outputTokens))
                        .sort((a, b) => Math.abs(Number(a.created_at) * 1000 - record.timestamp) - Math.abs(Number(b.created_at) * 1000 - record.timestamp))[0];
                    if (!log || !Number.isFinite(Number(log.quota))) continue;
                    record.actualQuota = Number(log.quota);
                    record.usageGroup = String(log.group || '');
                    record.usageLogKey = getLogKey(log);
                    saveTokenUsageHistoryNow().catch(error => console.error('Token usage history save failed:', error));
                    return;
                }
            } catch (error) {
                console.warn('New API usage log fetch failed:', error);
            }
        };
        const recordApiUsage = (usage, meta = {}) => {
            const record = reactive({
                id: generateUUID(),
                timestamp: Date.now(),
                type: meta.type || 'chat',
                model: String(meta.model || ''),
                apiUrl: String(meta.apiUrl ?? getApiUrl?.() ?? ''),
                isStream: meta.isStream === true,
                durationMs: Number.isFinite(meta.durationMs) ? Math.max(0, meta.durationMs) : null,
                outputCharacters: Number.isFinite(meta.outputCharacters) ? Math.max(0, meta.outputCharacters) : null,
                ...normalizeApiUsage(usage)
            });
            tokenUsageHistory.value.unshift(record);
            const apiKey = String(meta.apiKey ?? getApiKey?.() ?? '').trim();
            if (record.apiUrl && apiKey) fetchLatestQuota(record, apiKey);
            saveTokenUsageHistoryNow().catch(error => console.error('Token usage history save failed:', error));
        };
        const clearTokenUsageHistory = () => {
            confirm('确定要清空全部 Token 用量记录吗？此操作无法撤销。', async () => {
                tokenUsageHistory.value = [];
                tokenUsagePage.value = 1;
                await saveTokenUsageHistoryNow();
                toast('Token 用量记录已清空', 'success');
            });
        };

        watch([tokenUsageFilter, tokenUsageTimeFilter], () => { tokenUsagePage.value = 1; });
        watch(tokenUsagePageCount, count => { tokenUsagePage.value = Math.min(tokenUsagePage.value, count); });

        return {
            clearTokenUsageHistory,
            displayedTokenUsageHistory,
            filteredTokenUsageHistory,
            formatLatestTokenCount,
            formatLatestUsageCost,
            formatTokenAggregate: (value, reports) => {
                if (reports <= 0 || value <= 0) return '0';
                if (value >= 100000000) return `${Number((value / 100000000).toFixed(2))}亿`;
                if (value >= 10000) return `${Number((value / 10000).toFixed(2))}万`;
                return value.toLocaleString();
            },
            formatTokenCount: (value) => Number.isFinite(value) ? value.toLocaleString() : '0',
            formatTokenUsageTime: (timestamp) => new Date(timestamp).toLocaleString('zh-CN', { hour12: false }),
            getTokenUsageTypeLabel: (type) => ({ chat: '主对话', memory: '记忆系统', variables: '变量分析' })[getTokenUsageCategory(type)],
            getUncachedInputTokens,
            latestMainTokenUsage,
            recordApiUsage,
            saveTokenUsageHistoryNow,
            showTokenUsageTimeFilter,
            tokenUsageFilter,
            tokenUsageHistory,
            tokenUsagePage,
            tokenUsagePageCount,
            tokenUsageStats,
            tokenUsageTimeFilter,
            tokenUsageTimeFilterLabel,
            tokenUsageTimeFilterOptions
        };
    };

    const useStorageManagement = ({
        characters,
        confirm,
        deleteStorageKeys,
        ensureStorage,
        getBranchOwnerId,
        getLegacyDb,
        getMainDb,
        getStorageLogicalKey,
        globalUiTemplates,
        readStorageKeys,
        saveCharacters,
        saveStoredValue,
        scanStorageEntries,
        scopedStorageNames,
        toast
    }) => {
        const { estimateDataUrlBytes, isAvatarWorthShrinking } = window.RPHubUtils;
        const categories = Object.freeze([
            { key: 'characters', label: '角色卡', color: '#2563eb' },
            { key: 'chat', label: '聊天记录', color: '#3b82f6' },
            { key: 'classic', label: '记忆系统', color: '#38bdf8' },
            { key: 'other', label: '其他', color: '#94a3b8' }
        ]);
        const storageStats = reactive({
            loading: false,
            cleaning: false,
            hasMeasured: false,
            error: '',
            usage: 0,
            quota: 0,
            orphanedBytes: 0,
            orphanedItems: 0,
            categories: []
        });
        let unusedSnapshot = { mainKeys: [], legacyKeys: [], templateRuntimeKeys: [] };

        const formatStorageSize = (bytes) => {
            const size = Math.max(0, Number(bytes) || 0);
            if (size < 1024) return `${Math.round(size)} B`;
            const units = ['KB', 'MB', 'GB'];
            let value = size / 1024;
            let unit = units[0];
            for (let index = 1; index < units.length && value >= 1024; index++) {
                value /= 1024;
                unit = units[index];
            }
            return `${value >= 10 ? value.toFixed(1) : value.toFixed(2)} ${unit}`;
        };
        const getScopedStorageInfo = (logicalKey) => {
            for (const name of scopedStorageNames) {
                const prefix = `${name}_`;
                if (logicalKey.startsWith(prefix)) return { name, id: logicalKey.slice(prefix.length) };
            }
            return null;
        };
        const getStorageCategory = (logicalKey) => {
            if (logicalKey === 'characters') return 'characters';
            if (logicalKey.startsWith('chat_')) return 'chat';
            if (logicalKey.startsWith('classic_memories_')) return 'classic';
            return 'other';
        };
        const estimateStorageValueSize = (value, seen = new WeakSet()) => {
            if (value == null) return 0;
            if (typeof value === 'string') return value.length * 2;
            if (typeof value === 'number' || typeof value === 'bigint') return 8;
            if (typeof value === 'boolean') return 4;
            if (typeof value !== 'object') return 0;
            if (value instanceof Blob) return value.size;
            if (value instanceof ArrayBuffer) return value.byteLength;
            if (ArrayBuffer.isView(value)) return value.byteLength;
            if (seen.has(value)) return 0;
            seen.add(value);

            let bytes = 0;
            if (Array.isArray(value)) {
                if (value.length && typeof value[0] === 'number') return value.length * 8;
                value.forEach(item => { bytes += estimateStorageValueSize(item, seen); });
            } else {
                Object.keys(value).forEach(key => {
                    bytes += key.length * 2 + estimateStorageValueSize(value[key], seen);
                });
            }
            return bytes;
        };
        const estimateStorageEntrySize = (key, value) => String(key).length * 2 + estimateStorageValueSize(value);

        // --- 头像瘦身 ---
        // 存量数据的最大头：角色卡头像过去是原样内联的原始 PNG
        // （实测单张 9.4MB，20 张 71.5MB，base64 后 105MB，占整个快照的 89%）。
        // 这里做一次性迁移：把每张头像压到适合头像展示的尺寸，
        // 并在压缩前后如实汇报省下的空间，让用户自己决定是否保存。
        const avatarShrink = reactive({
            running: false,
            done: false,
            scanned: 0,
            changed: 0,
            beforeBytes: 0,
            afterBytes: 0
        });

        const measureAvatarBytes = (list) => list.reduce(
            (total, character) => total + estimateDataUrlBytes(character?.avatar || ''),
            0
        );

        const shrinkAvatars = async () => {
            if (avatarShrink.running) return { ok: false };
            const shrink = window.RPHubUtils?.shrinkAvatarDataUrl;
            if (typeof shrink !== 'function') {
                toast('头像压缩功能未加载，请刷新页面后重试', 'error');
                return { ok: false };
            }

            // 只挑「值得压」的：已经是 JPEG 或体积很小的直接跳过，
            // 避免把本来就不大的头像反复重编码（每次重编码都会再损失一点画质）。
            const targets = characters.value.filter(character => isAvatarWorthShrinking(character?.avatar));
            if (!targets.length) {
                avatarShrink.scanned = characters.value.length;
                avatarShrink.changed = 0;
                avatarShrink.beforeBytes = measureAvatarBytes(characters.value);
                avatarShrink.afterBytes = avatarShrink.beforeBytes;
                avatarShrink.done = true;
                toast('所有头像都已经是小图，无需压缩', 'info');
                return { ok: true, changed: 0 };
            }

            avatarShrink.running = true;
            avatarShrink.done = false;
            avatarShrink.scanned = characters.value.length;
            // 记录原值，压缩过程中任何异常都能整体回滚。
            const originals = targets.map(character => character.avatar);
            const beforeBytes = measureAvatarBytes(characters.value);
            let changed = 0;
            try {
                for (const character of targets) {
                    character.avatar = await shrink(character.avatar);
                }
                changed = targets.filter((character, index) => character.avatar !== originals[index]).length;
                const afterBytes = measureAvatarBytes(characters.value);
                avatarShrink.changed = changed;
                avatarShrink.beforeBytes = beforeBytes;
                avatarShrink.afterBytes = afterBytes;
                avatarShrink.done = true;

                if (!changed) {
                    toast('头像已经足够小，本次没有改动', 'info');
                    return { ok: true, changed: 0 };
                }
                await saveCharacters?.();
                const saved = Math.max(0, beforeBytes - afterBytes);
                toast(`已压缩 ${changed} 张头像，节省约 ${formatStorageSize(saved)}`, 'success');
                await refreshStorageStats();
                return { ok: true, changed, savedBytes: saved };
            } catch (error) {
                // 回滚，避免留下压缩到一半的状态。
                targets.forEach((character, index) => { character.avatar = originals[index]; });
                avatarShrink.done = false;
                console.error('头像压缩失败:', error);
                toast('头像压缩失败：' + error.message, 'error');
                return { ok: false, error: error.message };
            } finally {
                avatarShrink.running = false;
            }
        };

        const refreshStorageStats = async () => {
            if (storageStats.loading) return;
            storageStats.loading = true;
            storageStats.error = '';
            try {
                await ensureStorage();
                const [mainKeys, legacyKeys, estimate] = await Promise.all([
                    readStorageKeys(getMainDb()),
                    readStorageKeys(getLegacyDb()),
                    navigator.storage?.estimate?.().catch(() => ({})) || Promise.resolve({})
                ]);
                const mainLogicalKeys = new Set(mainKeys.map(getStorageLogicalKey));
                const scopedLogicalKeys = new Set([...mainKeys, ...legacyKeys]
                    .map(getStorageLogicalKey)
                    .filter(logicalKey => getScopedStorageInfo(logicalKey)));
                const liveCharacterIds = new Set(characters.value.map(character => character?.uuid).filter(Boolean));
                const isOrphanedEntry = (source, logicalKey) => {
                    // 旧正文分片已停用，仅在用户确认清理时删除。
                    if (logicalKey.startsWith('memories_')) return true;
                    if (source === 'legacy' && mainLogicalKeys.has(logicalKey)) return true;
                    const scoped = getScopedStorageInfo(logicalKey);
                    if (!scoped || liveCharacterIds.has(getBranchOwnerId(scoped.id))) return false;
                    if (scoped.name !== 'chat' || !/^\d+$/.test(scoped.id)) return true;
                    const character = characters.value[Number(scoped.id)];
                    return !character || (character.uuid && scopedLogicalKeys.has(`chat_${character.uuid}`));
                };

                const categoryBytes = new Map(categories.map(category => [category.key, 0]));
                const orphanedKeys = { main: [], legacy: [] };
                let orphanedEntryBytes = 0;
                const inspectEntry = (source, key, value) => {
                    const logicalKey = getStorageLogicalKey(key);
                    const bytes = estimateStorageEntrySize(key, value);
                    const category = getStorageCategory(logicalKey);
                    categoryBytes.set(category, categoryBytes.get(category) + bytes);
                    if (isOrphanedEntry(source, logicalKey)) {
                        orphanedKeys[source].push(key);
                        orphanedEntryBytes += bytes;
                    }
                };
                await scanStorageEntries(getMainDb(), 'main', inspectEntry);
                await scanStorageEntries(getLegacyDb(), 'legacy', inspectEntry);

                const templateRuntimeKeys = [];
                globalUiTemplates.value.forEach((template, templateIndex) => {
                    Object.keys(template.runtimeByCharacter || {}).forEach(characterId => {
                        if (!liveCharacterIds.has(getBranchOwnerId(characterId))) {
                            templateRuntimeKeys.push({ templateIndex, characterId });
                        }
                    });
                });
                const embeddedOrphanBytes = templateRuntimeKeys.reduce((total, item) => (
                    total + estimateStorageEntrySize(
                        item.characterId,
                        globalUiTemplates.value[item.templateIndex]?.runtimeByCharacter?.[item.characterId]
                    )
                ), 0);

                try {
                    for (let index = 0; index < localStorage.length; index++) {
                        const key = localStorage.key(index);
                        const bytes = estimateStorageEntrySize(key || '', localStorage.getItem(key) || '');
                        const category = getStorageCategory(key || '');
                        categoryBytes.set(category, categoryBytes.get(category) + bytes);
                    }
                } catch (_) { }

                const accountedBytes = [...categoryBytes.values()].reduce((total, bytes) => total + bytes, 0);
                const measuredUsage = Number(estimate.usage) || accountedBytes;
                const sizeScale = accountedBytes > 0 ? measuredUsage / accountedBytes : 1;
                storageStats.usage = measuredUsage;
                storageStats.quota = Number(estimate.quota) || 0;
                storageStats.orphanedBytes = (orphanedEntryBytes + embeddedOrphanBytes) * sizeScale;
                storageStats.orphanedItems = orphanedKeys.main.length + orphanedKeys.legacy.length
                    + templateRuntimeKeys.length;
                storageStats.categories = categories
                    .map(category => ({ ...category, bytes: (categoryBytes.get(category.key) || 0) * sizeScale }))
                    .filter(category => category.bytes > 0);
                unusedSnapshot = {
                    mainKeys: orphanedKeys.main,
                    legacyKeys: orphanedKeys.legacy,
                    templateRuntimeKeys
                };
                storageStats.hasMeasured = true;
            } catch (error) {
                console.error('Failed to inspect storage:', error);
                storageStats.error = '读取存储信息失败，请稍后重试';
                storageStats.orphanedBytes = 0;
                storageStats.orphanedItems = 0;
                storageStats.categories = [];
                unusedSnapshot = { mainKeys: [], legacyKeys: [], templateRuntimeKeys: [] };
            } finally {
                storageStats.loading = false;
            }
        };

        const cleanupUnusedStorage = async () => {
            await refreshStorageStats();
            if (storageStats.error) return;
            if (storageStats.orphanedItems === 0) {
                toast('没有发现无用残留', 'info');
                return;
            }
            const snapshot = {
                mainKeys: [...unusedSnapshot.mainKeys],
                legacyKeys: [...unusedSnapshot.legacyKeys],
                templateRuntimeKeys: unusedSnapshot.templateRuntimeKeys.map(item => ({ ...item }))
            };
            const orphanedBytes = storageStats.orphanedBytes;
            const orphanedItems = storageStats.orphanedItems;
            confirm(
                `将清理 ${orphanedItems} 项无用残留（约 ${formatStorageSize(orphanedBytes)}）。现有角色的数据不会受到影响。`,
                async () => {
                    storageStats.cleaning = true;
                    try {
                        await Promise.all([
                            deleteStorageKeys(getMainDb(), snapshot.mainKeys),
                            deleteStorageKeys(getLegacyDb(), snapshot.legacyKeys)
                        ]);
                        snapshot.templateRuntimeKeys.forEach(({ templateIndex, characterId }) => {
                            const runtime = globalUiTemplates.value[templateIndex]?.runtimeByCharacter;
                            if (runtime) delete runtime[characterId];
                        });
                        await Promise.all([
                            saveStoredValue('global_ui_templates', globalUiTemplates.value)
                        ]);
                        await refreshStorageStats();
                        toast(`已清理 ${orphanedItems} 项无用残留，约 ${formatStorageSize(orphanedBytes)}`, 'success');
                    } catch (error) {
                        console.error('Failed to clean unused storage:', error);
                        toast('清理失败，请稍后重试', 'error');
                    } finally {
                        storageStats.cleaning = false;
                    }
                }
            );
        };

        // --- 跨设备同步 ---
        // 依赖 sync-client.js 暴露的 window.RPHubSync；未加载或未配置时整体降级为不可用。
        const syncState = reactive({
            configured: false,
            online: false,
            busy: false,
            statusText: '未配置',
            deviceId: '',
            remoteUpdatedAt: 0,
            lastSyncedAt: 0,
            message: '',
            messageType: 'info'
        });

        const setSyncMessage = (message, messageType = 'info') => {
            syncState.message = message;
            syncState.messageType = messageType;
        };

        const syncApi = () => (typeof window.RPHubSync !== 'undefined' ? window.RPHubSync : null);

        const initSync = async () => {
            const api = syncApi();
            syncState.deviceId = api ? api.getDeviceId() : '';
            if (!api || !api.apiUrl) {
                syncState.configured = false;
                syncState.statusText = '未配置';
                return;
            }
            syncState.configured = true;
            syncState.statusText = '检查中...';
            const health = await api.ping();
            syncState.online = !!health.online;
            syncState.remoteUpdatedAt = Number(health.updatedAt) || 0;
            syncState.statusText = syncState.online
                ? (health.hasPayload ? '已连接（服务器已有数据）' : '已连接（服务器暂无数据）')
                : '无法连接';
        };

        const refreshSyncStatus = async () => {
            const api = syncApi();
            if (!api || !api.apiUrl) return;
            const health = await api.ping();
            syncState.online = !!health.online;
            syncState.remoteUpdatedAt = Number(health.updatedAt) || 0;
            syncState.statusText = syncState.online
                ? (health.hasPayload ? '已连接（服务器已有数据）' : '已连接（服务器暂无数据）')
                : '无法连接';
        };

        // 把本机全部数据推到服务器。
        const syncPush = async ({ force = false, silent = false } = {}) => {
            const api = syncApi();
            if (!api || !api.apiUrl) {
                if (!silent) setSyncMessage('未配置同步服务地址，已跳过同步。', 'warning');
                return { ok: false };
            }
            syncState.busy = true;
            try {
                const result = await api.push({ force });
                if (result.ok) {
                    syncState.online = true;
                    syncState.statusText = '已连接';
                    syncState.remoteUpdatedAt = Date.now();
                    syncState.lastSyncedAt = Date.now();
                    if (!silent) setSyncMessage(`已上传本机数据（版本 ${result.revision}）。`, 'success');
                    return { ok: true };
                }
                if (result.stale) {
                    // 服务端更新：不覆盖，提示用户选择。
                    syncState.online = true;
                    syncState.remoteUpdatedAt = Number(result.current?.updatedAt) || 0;
                    if (!silent) {
                        setSyncMessage('服务器上的数据更新，已阻止本次上传以免覆盖。可点「从服务器拉取」，或用「以本机为准覆盖」。', 'warning');
                    }
                    return { ok: false, stale: true, current: result.current };
                }
                if (result.oversized) {
                    // 服务端是通的，只是快照超过 128MB 上限被拒，别误报成「无法连接」。
                    syncState.online = true;
                    syncState.statusText = '已连接';
                    if (!silent) setSyncMessage(result.error || '同步快照过大，已取消上传。', 'warning');
                    return { ok: false, oversized: true, bytes: result.bytes };
                }
                syncState.online = false;
                syncState.statusText = '无法连接';
                if (!silent) setSyncMessage(`上传失败：${result.error || '未知错误'}`, 'error');
                return { ok: false };
            } catch (error) {
                syncState.online = false;
                syncState.statusText = '无法连接';
                if (!silent) setSyncMessage(`上传失败：${error.message}`, 'error');
                return { ok: false };
            } finally {
                syncState.busy = false;
            }
        };

        // 拉取服务器数据覆盖本机，然后整页重载以重建内存状态。
        const syncPull = async () => {
            const api = syncApi();
            if (!api || !api.apiUrl) {
                setSyncMessage('未配置同步服务地址。', 'warning');
                return { ok: false };
            }
            syncState.busy = true;
            try {
                const result = await api.pull({ apply: true });
                if (!result.ok) {
                    setSyncMessage(`拉取失败：${result.error || '未知错误'}`, 'error');
                    return { ok: false };
                }
                setSyncMessage('已拉取服务器数据，正在刷新页面...', 'success');
                // 应用内存状态来自 IndexedDB，重载是最可靠的落地方式。
                setTimeout(() => window.location.reload(), 800);
                return { ok: true };
            } catch (error) {
                setSyncMessage(`拉取失败：${error.message}`, 'error');
                return { ok: false };
            } finally {
                syncState.busy = false;
            }
        };

        // 手动「立即同步」：先看服务器是否有更新，有则提示，无则上传。
        const syncNow = async () => {
            const api = syncApi();
            if (!api || !api.apiUrl) {
                setSyncMessage('未配置同步服务地址。', 'warning');
                return;
            }
            syncState.busy = true;
            try {
                const remote = await api.pull({ apply: false });
                if (remote.ok && remote.remote?.payload) {
                    const remoteAt = Number(remote.remote.updatedAt) || 0;
                    const local = await syncApi().collectState();
                    if (remoteAt > local.updatedAt) {
                        syncState.remoteUpdatedAt = remoteAt;
                        setSyncMessage('服务器数据比本机更新。请选择「从服务器拉取」，或用「以本机为准覆盖」。', 'warning');
                        return;
                    }
                }
            } catch {
                // 查询失败不阻断，继续尝试上传。
            } finally {
                syncState.busy = false;
            }
            await syncPush({ force: false });
        };

        const syncPushForce = async () => {
            await syncPush({ force: true });
        };

        return {
            avatarShrink,
            cleanupUnusedStorage,
            formatStorageSize,
            refreshStorageStats,
            shrinkAvatars,
            storageStats,
            initSync,
            refreshSyncStatus,
            syncNow,
            syncPull,
            syncPush,
            syncPushForce,
            syncState
        };
    };

    window.RPHubComposables = Object.freeze({ useStorageManagement, useTokenUsage });
})();
