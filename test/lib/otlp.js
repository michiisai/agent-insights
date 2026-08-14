'use strict';

const http = require('http');

const PORT = 44318; // deliberately not the default 4318 to avoid clashing with a running extension
const HOST = '127.0.0.1';

const START = 1_753_120_000_000_000_000n; // ns since epoch
const ns = (ms) => (START + BigInt(ms) * 1_000_000n).toString();
const sid = (i) => String(i).padStart(16, '0');

function post(urlPath, body) {
  return new Promise((resolve, reject) => {
    const data = Buffer.from(JSON.stringify(body), 'utf8');
    const req = http.request(
      { host: HOST, port: PORT, path: urlPath, method: 'POST',
        headers: { 'content-type': 'application/json', 'content-length': data.length } },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
      },
    );
    req.on('error', reject);
    req.end(data);
  });
}

module.exports = { PORT, HOST, START, ns, sid, post };
