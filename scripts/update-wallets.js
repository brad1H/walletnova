const puppeteer = require('puppeteer');
const fs = require('fs');

async function scrapeLeaderboard() {
  console.log('Launching browser...');
  const browser = await puppeteer.launch({
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
  });

  const page = await browser.newPage();
  await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36');

  console.log('Navigating to KOL Scan leaderboard...');
  await page.goto('https://kolscan.io/leaderboard', { waitUntil: 'networkidle2', timeout: 45000 });
  await page.waitForSelector('a[href*="/account/"]', { timeout: 20000 });
  await new Promise(r => setTimeout(r, 2000));

  // Scrape wallet data
  const wallets = await page.evaluate(() => {
    function parsePnl(text) {
      const negative = text.includes('-') || (text.includes('(') && text.includes(')'));
      const cleaned = text.replace(/[^0-9.KMkm]/g, '');
      if (!cleaned) return null;
      let num;
      if (/[Kk]$/.test(cleaned)) num = parseFloat(cleaned) * 1000;
      else if (/[Mm]$/.test(cleaned)) num = parseFloat(cleaned) * 1000000;
      else num = parseFloat(cleaned);
      if (isNaN(num)) return null;
      return Math.round(negative ? -num : num);
    }

    const results = [];
    const seen = new Set();
    const links = document.querySelectorAll('a[href*="/account/"]');

    links.forEach(link => {
      const href = link.getAttribute('href') || '';
      const match = href.match(/\/account\/([A-Za-z0-9]{32,})/);
      if (!match) return;
      const address = match[1];
      if (seen.has(address)) return;
      seen.add(address);

      let name = null;
      const heading = link.querySelector('h1, h2, h3, h4, h5, h6');
      if (heading && heading.textContent.trim()) {
        name = heading.textContent.trim();
      } else {
        for (const el of Array.from(link.querySelectorAll('*'))) {
          const t = el.childNodes.length === 1 && el.firstChild.nodeType === 3 ? el.textContent.trim() : '';
          if (t && t.length > 1 && !/^[\d$+\-%.(),KMk]+$/.test(t)) { name = t; break; }
        }
      }
      if (!name) return;

      let row = link.parentElement;
      for (let i = 0; i < 8; i++) {
        if (!row) break;
        const text = row.innerText || row.textContent || '';
        if (text.includes('$') || text.includes('%')) break;
        row = row.parentElement;
      }

      const searchRoot = row || link;
      const rowText = (searchRoot.innerText || searchRoot.textContent || '').replace(/\s+/g, ' ');

      let pnl = null, wr = null;
      const wrMatch = rowText.match(/(\d+)\s*\/\s*(\d+)/);
      if (wrMatch) {
        const w = parseInt(wrMatch[1]), l = parseInt(wrMatch[2]);
        if (!isNaN(w) && !isNaN(l) && (w + l) > 0) wr = Math.round((w / (w + l)) * 100);
      }
      const solSignMatch = rowText.match(/([+-])([\d.]+)\s*Sol/i);
      const usdMatch = rowText.match(/\$[\d,]+\.?\d*/);
      if (usdMatch) {
        const val = parsePnl(usdMatch[0]);
        if (val !== null) {
          const negative = solSignMatch ? solSignMatch[1] === '-' : rowText.includes('-$');
          pnl = negative ? -Math.abs(val) : Math.abs(val);
        }
      }

      results.push({ address, name, pnl, wr });
    });

    return results.slice(0, 50);
  });

  // Intercept window.open to capture Twitter URLs when clicking each logo
  console.log('Capturing Twitter handles by clicking twitter logos...');
  await page.evaluate(() => {
    window._twitterCaptures = [];
    window.open = function(url) {
      window._twitterCaptures.push(url || '');
      return null;
    };
  });

  // Click each twitter logo in order
  const clickCount = await page.evaluate(() => {
    const imgs = Array.from(document.querySelectorAll('img[alt="twitter logo"]'));
    imgs.forEach(img => img.click());
    return imgs.length;
  });
  await new Promise(r => setTimeout(r, 500));

  const twitterUrls = await page.evaluate(() => window._twitterCaptures);
  console.log(`Clicked ${clickCount} twitter logos, captured ${twitterUrls.length} URLs`);
  if (twitterUrls.length > 0) console.log('Sample:', twitterUrls.slice(0, 3));

  // Map captured URLs to wallets by index
  twitterUrls.forEach((url, i) => {
    if (i < wallets.length && url) {
      const m = url.match(/(?:twitter\.com|x\.com)\/@?([^/?#\s]+)/i);
      if (m && m[1] && !['i','intent','home','share','hashtag','search'].includes(m[1].toLowerCase())) {
        wallets[i].twitter = m[1].replace(/^@/, '');
      }
    }
  });

  await browser.close();

  // Derive pfp from address (KOL Scan CDN pattern)
  wallets.forEach(w => {
    w.pfp = `https://cdn.kolscan.io/profiles/${w.address}.png`;
    if (!w.twitter) w.twitter = '';
  });

  console.log(`Scraped ${wallets.length} wallets`);
  wallets.forEach((w, i) => console.log(`  ${i+1}. ${w.name} | pnl:${w.pnl} wr:${w.wr} twitter:${w.twitter}`));
  return wallets;
}

async function updateHtml(scraped) {
  if (scraped.length === 0) {
    console.log('No wallets scraped — aborting.');
    process.exit(1);
  }

  const content = fs.readFileSync('index.html', 'utf8');

  const emojiMap   = {};
  const twitterMap = {};
  const existingRegex = /\{\s*rank:\d+,\s*name:"[^"]*",\s*emoji:"([^"]*)",\s*twitter:"([^"]*)",\s*pfp:"[^"]*",\s*address:"([^"]*)"/g;
  let em;
  while ((em = existingRegex.exec(content)) !== null) {
    emojiMap  [em[3]] = em[1];
    twitterMap[em[3]] = em[2];
  }

  const defaultEmojis = ['⭐','🌟','💫','✨','🎯','🔥','💎','🚀','⚡','🌊','🎪','🏅','🎲','🃏','🧠','👁️','🌀','🎨','🎭','🎬'];
  let emojiIdx = 0;

  const lines = scraped.map((w, i) => {
    const emoji   = emojiMap[w.address] || defaultEmojis[emojiIdx++ % defaultEmojis.length];
    const twitter = w.twitter || twitterMap[w.address] || '';
    const pfp     = w.pfp;
    const pnl = w.pnl !== null ? w.pnl : 'null';
    const wr  = w.wr  !== null ? w.wr  : 'null';
    return `  { rank:${String(i+1).padEnd(2)}, name:"${w.name}", emoji:"${emoji}", twitter:"${twitter}", pfp:"${pfp}", address:"${w.address}", pnl:${pnl}, wr:${wr} }`;
  });

  const newArray = `const wallets = [\n${lines.join(',\n')},\n];`;
  const start = content.indexOf('const wallets = [');
  const end   = content.indexOf('\nconst insiderWallets');
  if (start === -1 || end === -1) { console.error('Could not find wallets array'); process.exit(1); }

  fs.writeFileSync('index.html', content.slice(0, start) + newArray + content.slice(end), 'utf8');
  console.log('index.html updated successfully.');
}

(async () => {
  try {
    const scraped = await scrapeLeaderboard();
    await updateHtml(scraped);
  } catch (err) {
    console.error('Update failed:', err.message);
    process.exit(1);
  }
})();
