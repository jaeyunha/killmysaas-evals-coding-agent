const http = require('http');
const fs = require('fs');

const LOG_FILE = '/tmp/sbek-magic-links.json';

// Initialize empty array if file doesn't exist
if (!fs.existsSync(LOG_FILE)) {
  fs.writeFileSync(LOG_FILE, JSON.stringify([]));
}

const server = http.createServer((req, res) => {
  if (req.method === 'POST') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        const data = JSON.parse(body);
        console.log('[Webhook Listener] Received email:', data.to);
        const match = (data.html || data.text || '').match(/https?:\/\/[^\s"'<>]+/);
        const link = match ? match[0] : null;
        
        const logs = JSON.parse(fs.readFileSync(LOG_FILE, 'utf8') || '[]');
        logs.push({
          to: data.to,
          subject: data.subject,
          link: link,
          body: data,
          timestamp: new Date().toISOString()
        });
        fs.writeFileSync(LOG_FILE, JSON.stringify(logs, null, 2));
        console.log('[Webhook Listener] Saved link for:', data.to, '->', link);
      } catch (e) {
        console.error('[Webhook Listener] Error parsing request:', e);
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });
  } else {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('Webhook listener active');
  }
});

server.listen(9999, '0.0.0.0', () => {
  console.log('[Webhook Listener] Running on http://localhost:9999');
});
