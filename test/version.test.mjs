// 版本号自洽性。
//
// `VERSION` 是「正在运行的那份代码」的版本，`package.json.version` 是「磁盘上那个包」的
// 版本。两者必须相等，否则报出来的版本号会误导人 —— 而这恰恰是加这个字段的全部意义。
//
// 为什么不在运行时读 package.json：那读的是磁盘，不是内存。宿主的安装流程是
// 「换磁盘文件 → 重新 import」，中间存在两边不一致的窗口；`VERSION` 写死在代码里，
// 拿到的才是真正在跑的那份。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { VERSION, createGate, createRoutes, normalizeConfig } from '../lib/index.js';
import { zonedInstant } from '../lib/peak-window.js';

const here = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8'));

test('VERSION 与 package.json 的 version 一致', () => {
  assert.match(VERSION, /^\d+\.\d+\.\d+$/, 'VERSION 应是 x.y.z 形式');
  assert.equal(VERSION, pkg.version, '改版本号时 package.json 与 lib/index.js 的 VERSION 要一起改');
});

test('status() 带 version 字段', () => {
  const gate = createGate(() => normalizeConfig({ peakWindows: [] }), {
    now: () => zonedInstant(2026, 11, 11, 10, 0, 'Asia/Shanghai'),
  });
  assert.equal(gate.status('s-root').version, VERSION);
});

function makeRes() {
  return {
    statusCode: null,
    headers: null,
    body: '',
    headersSent: false,
    writableEnded: false,
    destroyed: false,
    writeHead(status, headers) {
      this.statusCode = status;
      this.headers = headers ?? {};
      this.headersSent = true;
    },
    setHeader(name, value) {
      this.headers = { ...(this.headers ?? {}), [name]: value };
    },
    end(chunk) {
      if (chunk !== undefined) this.body += String(chunk);
      this.writableEnded = true;
    },
  };
}

test('GET /dsh-offpeak/status 把 version 送回客户端', () => {
  const gate = createGate(() => normalizeConfig({ peakWindows: [] }), {
    now: () => zonedInstant(2026, 11, 11, 10, 0, 'Asia/Shanghai'),
  });
  const routes = createRoutes(gate);
  const res = makeRes();
  routes.status(
    {
      method: 'GET',
      url: '/dsh-offpeak/status?sessionId=s-root',
      headers: { 'x-dsh-offpeak': '1', host: '127.0.0.1:61591' },
    },
    res,
  );
  assert.equal(res.statusCode, 200);
  assert.equal(JSON.parse(res.body).version, VERSION);
});
