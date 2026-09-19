// RP-Hub 跨设备同步客户端
//
// 把本浏览器 IndexedDB 里的「全部用户数据」打包成一份 JSON 快照，推送到
// unraid 上的同步服务；也可以把服务端的快照拉回来覆盖本地。
//
// 设计要点：
//   - 失败软着陆：同步服务不可用时只提示，绝不影响本地正常使用。
//   - 拉取后整页重载：应用的内存状态来自 IndexedDB，重载是最可靠的落地方式。
//   - 冲突用 LWW（最后写入者胜）：推送带 updatedAt，服务端拒绝旧写入。
//   - 只处理本应用自己的数据：按 rp_hub_ / 旧前缀过滤，不碰同源下的其他库。
//
// 配置：在 index.html 里通过 <meta name="rphub-sync-api"> 指定服务地址。
(function () {
    const META = document.querySelector('meta[name="rphub-sync-api"]');
    const API_URL = String(META?.content || '').trim().replace(/\/+$/, '');

    const STORAGE_PREFIX = 'rp_hub_';
    const LEGACY_PREFIX = 'silly_tavern_';
    const DB_NAME = 'RPHubDB';
    const CHARGEN_DB = 'AICharGen';
    const DEVICE_KEY = 'rphub_sync_device_id';
    const LAST_SYNC_KEY = 'rphub_sync_last_at';

    // 需要一并同步的 localStorage 键（应用自己的小配置）
    const LOCAL_KEYS = ['ai_chargen_api', 'ai_chargen_options', 'ai_chargen_active_index', 'roleplay_hub_update_id'];

    // 刻意「只留本机、不进同步」的键。
    // rp_hub_generated_images_cache 是生图回显缓存，条目里存的是生成图的 base64 原图，
    // 单台设备累积几十张就有上百 MB —— 实测会把整份快照从 58MB 顶到 160MB，
    // 同时超过 nginx 的 client_max_body_size 与同步服务的 MAX_BODY_BYTES（都是 128MB），
    // 表现就是同步上传直接 413。它只是本机显示用的派生数据，需要时可由生图服务重建，
    // 因此收集与写入两端都跳过。
    const LOCAL_ONLY_KEYS = new Set([`${STORAGE_PREFIX}generated_images_cache`]);

    const isOurKey = key => {
        const name = String(key);
        if (LOCAL_ONLY_KEYS.has(name)) return false;
        return name.startsWith(STORAGE_PREFIX) || name.startsWith(LEGACY_PREFIX);
    };

    // 服务端两道 128MB 限制之下留一点余量：超了就别白跑一趟 413。
    const MAX_PUSH_BYTES = 127 * 1024 * 1024;

    const getDeviceId = () => {
        try {
            let id = localStorage.getItem(DEVICE_KEY);
            if (!id) {
                id = (crypto?.randomUUID?.() || `dev-${Date.now()}-${Math.random().toString(16).slice(2)}`).replace(/-/g, '').slice(0, 32);
                localStorage.setItem(DEVICE_KEY, id);
            }
            return id;
        } catch {
            return 'unknown-device';
        }
    };

    const openDb = (name) => new Promise((resolve, reject) => {
        const request = indexedDB.open(name);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });

    const listDatabases = async () => {
        try {
            return typeof indexedDB.databases === 'function' ? await indexedDB.databases() : [];
        } catch {
            return [];
        }
    };

    // --- 收集：把本机全部用户数据读出来 ---
    const collectMainDb = async () => {
        const db = await openDb(DB_NAME);
        try {
            if (!db.objectStoreNames.contains('store')) return {};
            return await new Promise((resolve, reject) => {
                const out = {};
                const request = db.transaction(['store'], 'readonly').objectStore('store').openCursor();
                request.onsuccess = () => {
                    const cursor = request.result;
                    if (!cursor) return resolve(out);
                    if (isOurKey(cursor.key)) out[String(cursor.key)] = cursor.value;
                    cursor.continue();
                };
                request.onerror = () => reject(request.error);
            });
        } finally {
            db.close();
        }
    };

    // 角色卡工坊用的是独立数据库（localforage），一并带上。
    const collectChargen = async () => {
        const dbs = await listDatabases();
        if (!dbs.some(item => item?.name === CHARGEN_DB)) return null;
        const db = await openDb(CHARGEN_DB);
        try {
            const storeName = db.objectStoreNames.contains('characters')
                ? 'characters'
                : db.objectStoreNames[0];
            if (!storeName) return null;
            return await new Promise((resolve, reject) => {
                const out = {};
                const request = db.transaction([storeName], 'readonly').objectStore(storeName).openCursor();
                request.onsuccess = () => {
                    const cursor = request.result;
                    if (!cursor) return resolve({ storeName, entries: out });
                    out[String(cursor.key)] = cursor.value;
                    cursor.continue();
                };
                request.onerror = () => reject(request.error);
            });
        } finally {
            db.close();
        }
    };

    const collectLocal = () => {
        const out = {};
        for (const key of LOCAL_KEYS) {
            try {
                const value = localStorage.getItem(key);
                if (value !== null) out[key] = value;
            } catch { /* 忽略 */ }
        }
        return out;
    };

    const collectState = async () => {
        const [main, chargen] = await Promise.all([collectMainDb(), collectChargen()]);
        return {
            version: 1,
            deviceId: getDeviceId(),
            updatedAt: Date.now(),
            userAgent: navigator.userAgent.slice(0, 200),
            // 服务端以 payload 字段承载数据体。
            payload: { main, chargen, local: collectLocal() }
        };
    };

    // 应用：把服务端快照写回本机
    // 老快照里可能残留项目作者的网关地址；这些字段一律跳过，
    // 否则会把「已清理的旧地址」重新带回来。
    const REMOVED_HOSTS = ['cdn.sta1n.cn', 'nai.sta1n.cn'];
    const isRemovedGatewayUrl = (value) => {
        try {
            const host = new URL(String(value || '').trim()).hostname.toLowerCase();
            return REMOVED_HOSTS.some(domain => host === domain || host.endsWith(`.${domain}`));
        } catch {
            return false;
        }
    };

    // 对 main 里的 settings 做保护：剔除指向已移除网关的字段。
    const sanitizeMainEntries = (entries) => {
        if (!entries || typeof entries !== 'object') return entries;
        // 老快照可能夹带着本机专用的派生缓存（含 base64 原图），写入前先摘掉，
        // 否则一次拉取又会把 100MB 级的图片灌回本机。
        const dropped = Object.keys(entries).filter(key => LOCAL_ONLY_KEYS.has(key));
        const kept = dropped.length
            ? Object.fromEntries(Object.entries(entries).filter(([key]) => !LOCAL_ONLY_KEYS.has(key)))
            : entries;
        if (dropped.length) console.warn(`同步快照里的本机专用键已跳过：${dropped.join(', ')}`);
        const settings = kept[`${STORAGE_PREFIX}settings`];
        if (!settings || typeof settings !== 'object') return kept;
        const cleaned = { ...settings };
        let changed = false;
        if (isRemovedGatewayUrl(cleaned.imageGenBaseUrl)) {
            delete cleaned.imageGenBaseUrl;
            changed = true;
        }
        if (isRemovedGatewayUrl(cleaned.apiUrl)) {
            delete cleaned.apiUrl;
            delete cleaned.apiKey;
            changed = true;
        }
        if (!changed) return kept;
        return { ...kept, [`${STORAGE_PREFIX}settings`]: cleaned };
    };

    const applyMainDb = async (entries) => {
        if (!entries || typeof entries !== 'object') return 0;
        entries = sanitizeMainEntries(entries);
        const db = await openDb(DB_NAME);
        try {
            const storeName = db.objectStoreNames.contains('store') ? 'store' : null;
            if (!storeName) return 0;
            const keys = Object.keys(entries);
            return await new Promise((resolve, reject) => {
                const tx = db.transaction([storeName], 'readwrite');
                const store = tx.objectStore(storeName);
                // 先清掉本应用的旧键，再写入快照，避免残留已删除的数据。
                const cursorRequest = store.openCursor();
                cursorRequest.onsuccess = () => {
                    const cursor = cursorRequest.result;
                    if (cursor) {
                        if (isOurKey(cursor.key)) cursor.delete();
                        cursor.continue();
                        return;
                    }
                    keys.forEach(key => store.put(entries[key], key));
                };
                tx.oncomplete = () => resolve(keys.length);
                tx.onerror = () => reject(tx.error);
            });
        } finally {
            db.close();
        }
    };

    const applyChargen = async (chargen) => {
        if (!chargen?.storeName || !chargen?.entries) return 0;
        const dbs = await listDatabases();
        if (!dbs.some(item => item?.name === CHARGEN_DB)) {
            // 目标库还不存在：让角色卡工坊自己创建，这里跳过。
            return 0;
        }
        const db = await openDb(CHARGEN_DB);
        try {
            if (!db.objectStoreNames.contains(chargen.storeName)) return 0;
            const entries = chargen.entries;
            const keys = Object.keys(entries);
            return await new Promise((resolve, reject) => {
                const tx = db.transaction([chargen.storeName], 'readwrite');
                const store = tx.objectStore(chargen.storeName);
                store.clear();
                keys.forEach(key => store.put(entries[key], key));
                tx.oncomplete = () => resolve(keys.length);
                tx.onerror = () => reject(tx.error);
            });
        } finally {
            db.close();
        }
    };

    const applyLocal = (local) => {
        if (!local || typeof local !== 'object') return;
        for (const key of LOCAL_KEYS) {
            try {
                if (local[key] === undefined) localStorage.removeItem(key);
                else localStorage.setItem(key, local[key]);
            } catch { /* 忽略 */ }
        }
    };

    // 入参是数据体本身（{ main, chargen, local }），不是外层包裹对象。
    const applyState = async (stateData) => {
        const data = stateData && typeof stateData === 'object' ? stateData : {};
        const result = {
            main: await applyMainDb(data.main),
            chargen: await applyChargen(data.chargen)
        };
        applyLocal(data.local);
        return result;
    };

    // --- 网络 ---
    const request = async (pathname, options = {}) => {
        if (!API_URL) throw new Error('未配置同步服务地址');
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), options.timeoutMs || 60_000);
        try {
            const response = await fetch(`${API_URL}${pathname}`, {
                ...options,
                signal: controller.signal,
                headers: { 'Content-Type': 'application/json', ...(options.headers || {}) }
            });
            const text = await response.text();
            let body = null;
            try { body = text ? JSON.parse(text) : null; } catch { body = { raw: text }; }
            return { ok: response.ok, status: response.status, body };
        } finally {
            clearTimeout(timer);
        }
    };

    const ping = async () => {
        try {
            const { ok, body } = await request('/v1/health', { method: 'GET', timeoutMs: 8000 });
            return ok ? { online: true, ...body } : { online: false };
        } catch {
            return { online: false };
        }
    };

    const push = async ({ force = false } = {}) => {
        const state = await collectState();
        const body = JSON.stringify({ ...state, force });
        // 超限时 nginx 会在请求进入业务逻辑前就返回 413，前端只能看到裸状态码。
        // 这里先量一次体积，给出能看懂的原因，省掉一趟几十 MB 的无用上传。
        const bytes = new TextEncoder().encode(body).length;
        if (bytes > MAX_PUSH_BYTES) {
            return {
                ok: false,
                oversized: true,
                bytes,
                state,
                error: `同步快照约 ${(bytes / 1048576).toFixed(1)}MB，超过服务端 128MB 上限，本次未上传。`
                    + '通常是角色卡头像（base64 内联）累积过大，可清理不用的角色卡后重试。'
            };
        }
        const { ok, status, body: responseBody } = await request('/v1/state', { method: 'POST', body });
        try { localStorage.setItem(LAST_SYNC_KEY, String(Date.now())); } catch { /* 忽略 */ }
        if (ok) return { ok: true, pushed: true, revision: responseBody?.revision, bytes, state };
        if (status === 409) return { ok: false, stale: true, current: responseBody?.current, state };
        if (status === 413) {
            return { ok: false, oversized: true, bytes, state, error: `同步快照约 ${(bytes / 1048576).toFixed(1)}MB，被服务端以 413 拒绝（上限 128MB）。` };
        }
        return { ok: false, error: responseBody?.error || `HTTP ${status}`, state };
    };

    const pull = async ({ apply = true } = {}) => {
        const { ok, body } = await request('/v1/state', { method: 'GET' });
        if (!ok) return { ok: false, error: `HTTP ${body?.error || 'unknown'}` };
        if (!body?.payload) return { ok: false, error: '服务端还没有数据' };
        if (!apply) return { ok: true, remote: body };
        const applied = await applyState(body.payload);
        try { localStorage.setItem(LAST_SYNC_KEY, String(Date.now())); } catch { /* 忽略 */ }
        return { ok: true, applied, remote: body };
    };

    // --- 生图归档 ---
    // 把生成的图片同步送到 unraid 落盘。失败重试一次后放弃（不打断聊天）。
    const SUCCESS_ARCHIVE_KEY = 'rphub_archived_image_hashes';

    const readArchivedHashes = () => {
        try {
            const raw = localStorage.getItem(SUCCESS_ARCHIVE_KEY);
            return new Set(Array.isArray(JSON.parse(raw)) ? JSON.parse(raw) : []);
        } catch {
            return new Set();
        }
    };

    const rememberArchivedHash = (hash) => {
        try {
            const set = readArchivedHashes();
            set.add(hash);
            // 只保留最近 2000 条，避免 localStorage 无限增长。
            localStorage.setItem(SUCCESS_ARCHIVE_KEY, JSON.stringify([...set].slice(-2000)));
        } catch { /* 忽略 */ }
    };

    // 把图片 URL 取回来转成 data URL（图片可能来自跨域地址，因此用 fetch + FileReader）。
    const fetchAsDataUrl = async (url) => {
        const response = await fetch(url, { credentials: 'omit' });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const blob = await response.blob();
        return await new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result);
            reader.onerror = () => reject(reader.error);
            reader.readAsDataURL(blob);
        });
    };

    const postArchive = async (payload) => {
        const { ok, status, body } = await request('/v1/images', {
            method: 'POST',
            body: JSON.stringify(payload),
            timeoutMs: 60_000
        });
        if (!ok) throw new Error(body?.error || `HTTP ${status}`);
        return body;
    };

    /**
     * 归档一张图片。
     * @param {object} options
     * @param {string} [options.url]  图片地址（与 data 二选一）
     * @param {string} [options.data] 直接的 data URL / base64
     * @returns {Promise<{ok:boolean, deduplicated?:boolean, file?:string, error?:string, skipped?:boolean}>}
     */
    const archiveImage = async ({ url, data, character, prompt, model, size, source, jobId } = {}) => {
        if (!API_URL) return { ok: false, skipped: true, error: '未配置同步服务' };
        try {
            let payloadData = data;
            if (!payloadData && url) {
                // 已经成功归档过的同地址直接跳过，避免重复下载。
                payloadData = await fetchAsDataUrl(url);
            }
            if (!payloadData) return { ok: false, skipped: true, error: '没有图片数据' };

            const body = { data: payloadData, character, prompt, model, size, source, jobId };
            try {
                const result = await postArchive(body);
                if (result?.hash) rememberArchivedHash(result.hash);
                return { ok: true, deduplicated: !!result?.deduplicated, file: result?.file, hash: result?.hash };
            } catch (firstError) {
                // 静默重试一次
                await new Promise(resolve => setTimeout(resolve, 1200));
                const result = await postArchive(body);
                if (result?.hash) rememberArchivedHash(result.hash);
                return { ok: true, deduplicated: !!result?.deduplicated, file: result?.file, hash: result?.hash, retried: true };
            }
        } catch (error) {
            // 归档失败不影响聊天与看图
            console.warn('生图归档失败（已忽略）:', error.message);
            return { ok: false, error: error.message };
        }
    };

    const imageStats = async () => {
        try {
            const { ok, body } = await request('/v1/images', { method: 'GET', timeoutMs: 10_000 });
            return ok ? { ok: true, ...body } : { ok: false, error: body?.error };
        } catch (error) {
            return { ok: false, error: error.message };
        }
    };

    window.RPHubSync = Object.freeze({
        apiUrl: API_URL,
        getDeviceId,
        collectState,
        applyState,
        ping,
        push,
        pull,
        archiveImage,
        imageStats,
        readArchivedHashes
    });
})();
