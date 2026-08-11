const { chromium } = require('playwright');
const fs = require('fs');
const http = require('http');

const PERSONAS = [
  { name: 'organizer', email: 'sbek-organizer@example.com' },
  { name: 'speaker', email: 'sbek-speaker@example.com' },
  { name: 'speaker2', email: 'sbek-speaker2@example.com' },
  { name: 'reviewer', email: 'sbek-reviewer@example.com' },
];

async function requestMagicLink(email) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: 'localhost',
      port: 3000,
      path: '/api/auth/sign-in/magic-link',
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(data));
    });
    req.on('error', reject);
    req.write(JSON.stringify({ email }));
    req.end();
  });
}

function getLatestLinkFor(email) {
  try {
    const logs = JSON.parse(fs.readFileSync('/tmp/sbek-magic-links.json', 'utf8') || '[]');
    const matching = logs.filter(l => l.to === email && l.link);
    if (matching.length === 0) return null;
    let rawLink = matching[matching.length - 1].link;
    return rawLink ? rawLink.replace(/&amp;/g, '&') : null;
  } catch (e) {
    return null;
  }
}

async function capture() {
  if (!fs.existsSync('.auth')) {
    fs.mkdirSync('.auth', { recursive: true });
  }

  const browser = await chromium.launch({ headless: true });

  for (const persona of PERSONAS) {
    console.log(`\n--- Capturing session for ${persona.name} (${persona.email}) ---`);
    await requestMagicLink(persona.email);
    await new Promise(r => setTimeout(r, 1500));

    const link = getLatestLinkFor(persona.email);
    if (!link) {
      console.error(`Could not capture magic link for ${persona.name}`);
      continue;
    }

    console.log(`Opening magic link for ${persona.name}: ${link}`);
    const context = await browser.newContext();
    const page = await context.newPage();
    
    await page.goto(link, { waitUntil: 'networkidle' });
    await page.waitForTimeout(2000);
    
    console.log(`Final URL for ${persona.name}: ${page.url()}`);
    const outPath = `.auth/localhost_3000.${persona.name}.json`;
    await context.storageState({ path: outPath });
    console.log(`Saved auth state to ${outPath}`);
    await context.close();
  }

  await browser.close();
  console.log('\nAll persona sessions captured successfully!');
}

capture().catch(err => {
  console.error('Error during auth capture:', err);
  process.exit(1);
});
