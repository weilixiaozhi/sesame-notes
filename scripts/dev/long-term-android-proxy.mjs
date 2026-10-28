/**
 * 为独立Android验收包提供可控网络故障；不修改设备或主机网络设置。
 * node scripts/dev/long-term-android-proxy.mjs <本轮回环API地址> <仓库Temp内运行目录>
 * 运行目录的proxy-mode.txt仅接受online、offline或drop_once。
 */
import http from 'node:http';
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const tempRoot = path.resolve(import.meta.dirname, '../../Temp');
let server;

/** 记录代理阶段和结果状态，不记录请求凭据或业务正文。 */
function record(root, event) {
  try {
    const line = JSON.stringify({ utc: new Date().toISOString(), ...event });
    appendFileSync(path.join(root, 'proxy-events.jsonl'), `${line}\n`);
    console.log(line);
  } catch (error) {
    console.error('网络验收日志写入失败', error.name);
  }
}

try {
  const upstream = new URL(process.argv[2]);
  const root = path.resolve(process.argv[3] ?? '');
  if (
    upstream.protocol !== 'http:' ||
    upstream.hostname !== '127.0.0.1' ||
    !upstream.port ||
    upstream.username ||
    upstream.password ||
    upstream.pathname !== '/' ||
    upstream.search ||
    upstream.hash
  ) {
    throw new Error('验收代理只接受显式端口的本轮127.0.0.1 HTTP实例');
  }
  if (!root.startsWith(tempRoot + path.sep) || !existsSync(root)) {
    throw new Error('运行目录必须是当前仓库Temp中的已有独立目录');
  }
  const modeFile = path.join(root, 'proxy-mode.txt');
  if (!existsSync(modeFile)) writeFileSync(modeFile, 'online');
  let dropClaimed = false;
  server = http.createServer((request, response) => {
    try {
      const mode = readFileSync(modeFile, 'utf8')
        .replace(/^\uFEFF/, '')
        .trim();
      if (!['online', 'offline', 'drop_once'].includes(mode)) throw new Error('未知验收模式');
      if (request.url === '/__acceptance/status') {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ mode }));
        return;
      }
      if (mode === 'offline') {
        record(root, { type: 'offline_socket_closed', method: request.method, path: request.url });
        request.socket.destroy();
        return;
      }
      const drop =
        mode === 'drop_once' && !dropClaimed && request.method === 'POST' && request.url === '/api/v1/sync/push';
      if (drop) dropClaimed = true;
      const target = new URL(request.url, upstream);
      if (target.origin !== upstream.origin) throw new Error('请求目标超出本轮实例');
      const forwarded = http.request(
        target,
        {
          method: request.method,
          headers: { ...request.headers, host: upstream.host, connection: 'close' },
        },
        (result) => {
          const chunks = [];
          let bytes = 0;
          if (!drop) response.writeHead(result.statusCode, result.headers);
          result.on('data', (chunk) => {
            bytes += chunk.length;
            if (drop && bytes <= 4 * 1024 * 1024) chunks.push(chunk);
            if (!drop) response.write(chunk);
          });
          result.on('end', () => {
            try {
              if (drop) {
                let outcomes = [];
                try {
                  outcomes =
                    JSON.parse(Buffer.concat(chunks).toString('utf8')).outcomes?.map((value) => value.status) ?? [];
                } catch {
                  // 代理只保留可安全识别的结果状态；原始响应正文不进入日志。
                }
                writeFileSync(modeFile, 'online');
                dropClaimed = false;
                record(root, { type: 'upstream_response_dropped', status: result.statusCode, bytes, outcomes });
                response.destroy();
              } else {
                response.end();
              }
            } catch (error) {
              record(root, { type: 'response_failure', error_type: error.name });
              response.destroy();
            }
          });
          result.on('error', (error) => {
            record(root, { type: 'upstream_response_failure', error_type: error.name });
            response.destroy();
          });
        },
      );
      forwarded.on('error', (error) => {
        record(root, { type: 'upstream_connection_failure', error_type: error.name });
        response.destroy();
      });
      request.on('error', () => forwarded.destroy());
      request.pipe(forwarded);
    } catch (error) {
      record(root, { type: 'proxy_failure', error_type: error.name });
      response.destroy();
    }
  });
  server.on('error', (error) => {
    record(root, { type: 'server_failure', error_type: error.name, code: error.code });
    process.exitCode = 1;
  });
  server.listen(17892, '127.0.0.1', () =>
    record(root, { type: 'proxy_ready', port: 17892, upstream_port: Number(upstream.port) }),
  );
} catch (error) {
  console.error('无法启动独立网络验收代理：', error.message);
  process.exitCode = 1;
}
