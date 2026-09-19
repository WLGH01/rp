#!/usr/bin/env node
// 极简静态服务器，仅用于本地验证 RP-Hub（不引入任何依赖）。
// 用法: node tools/serve.mjs [port]   默认 8788
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const port = Number(process.argv[2]) || 8788;
// 同步服务端口（/api 反代目标）；用 SYNC_PORT 覆盖。
const SYNC_PORT = Number(process.env.SYNC_PORT) || 8791;

const MIME = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
    '.ico': 'image/x-icon',
    '.woff2': 'font/woff2',
    '.woff': 'font/woff',
    '.ttf': 'font/ttf'
};

http.createServer((request, response) => {
    const urlPath = decodeURIComponent(new URL(request.url || '/', 'http://localhost').pathname);

    // /api/* 反代到同步服务，模拟 unraid 上 nginx 的行为。
    if (urlPath === '/api' || urlPath.startsWith('/api/')) {
        const target = `http://127.0.0.1:${SYNC_PORT}${urlPath.replace(/^\/api/, '') || '/'}`;
        const proxy = http.request(target, {
            method: request.method,
            headers: { ...request.headers, host: `127.0.0.1:${SYNC_PORT}` }
        }, upstream => {
            response.writeHead(upstream.statusCode || 502, upstream.headers);
            upstream.pipe(response);
        });
        proxy.on('error', error => {
            response.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8' })
                .end(JSON.stringify({ ok: false, error: `同步服务不可达: ${error.message}` }));
        });
        request.pipe(proxy);
        return;
    }

    let filePath = path.join(ROOT, urlPath);
    // 防目录穿越
    if (!filePath.startsWith(ROOT)) {
        response.writeHead(403).end('Forbidden');
        return;
    }
    if (fs.existsSync(filePath) && fs.statSync(filePath).isDirectory()) filePath = path.join(filePath, 'index.html');
    fs.readFile(filePath, (error, data) => {
        if (error) {
            response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Not found: ' + urlPath);
            return;
        }
        response.writeHead(200, {
            'Content-Type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
            'Cache-Control': 'no-store'
        }).end(data);
    });
}).listen(port, '127.0.0.1', () => {
    console.log(`RP-Hub 本地验证服务: http://127.0.0.1:${port}/`);
});
