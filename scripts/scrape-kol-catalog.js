const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');

(async () => {
  console.log('Launching browser...');
  const browser = await puppeteer.launch({
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    defaultViewport: { width: 1400, height: 900 }
  });

  const page = await browser.newPage();
  await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36');

  console.log('Navigating to KOL Scan leaderboard...');
  await page.goto('https://kolscan.io/leaderboard', { waitUntil: 'networkidle2', timeout: 60000 });
  await page.waitForSelector('a[href*="/account/"]', { timeout: 20000 });

  // Scroll the mainContent container to trigger infinite scroll
  console.log('Scrolling mainContent to load all wallets...');
  let prevCount = 0;
  let stableRounds = 0;
  while (stableRounds < 5) {
    await page.evaluate(() => {
      const el = document.querySelector('.mainContent');
      if (el) el.scrollTop = el.scrollHeight;
    });
    await new Promise(r => setTimeout(r, 2000));
    const count = await page.evaluate(() =>
      new Set(Array.from(document.querySelectorAll('a[href*="/account/"]')).map(a => a.getAttribute('href'))).size
    );
    console.log(`  wallets in DOM: ${count}`);
    if (count === prevCount) stableRounds++;
    else { stableRounds = 0; prevCount = count; }
  }

  console.log(`Done scrolling. Total: ${prevCount}`);

  // Scrape wallets + Twitter by finding each wallet's own Twitter icon in its row
  console.log('Scraping wallets and pairing Twitter handles by row...');
  const wallets = await page.evaluate(() => {
    const results = [];
    const seen = new Set();
    const clickedImgs = new WeakSet();

    // Override window.open — capture the URL synchronously per click
    window._lastTwitterUrl = null;
    window.open = function(url) {
      window._lastTwitterUrl = url || '';
      return null;
    };

    const SKIP = new Set(['i', 'intent', 'home', 'share', 'hashtag', 'search']);

    function extractHandle(url) {
      if (!url) return '';
      const m = url.match(/(?:twitter\.com|x\.com)\/@?([^/?#\s]+)/i);
      if (m && m[1] && !SKIP.has(m[1].toLowerCase())) return m[1].replace(/^@/, '');
      return '';
    }

    const links = Array.from(document.querySelectorAll('a[href*="/account/"]'));

    for (const link of links) {
      const href = link.getAttribute('href') || '';
      const match = href.match(/\/account\/([A-Za-z0-9]{32,})/);
      if (!match) continue;
      const address = match[1];
      if (seen.has(address)) continue;
      seen.add(address);

      // Extract name
      let name = null;
      const heading = link.querySelector('h1,h2,h3,h4,h5,h6');
      if (heading && heading.textContent.trim()) {
        name = heading.textContent.trim();
      } else {
        for (const el of Array.from(link.querySelectorAll('*'))) {
          const t = el.childNodes.length === 1 && el.firstChild.nodeType === 3 ? el.textContent.trim() : '';
          if (t && t.length > 1 && !/^[\d$+\-%.,()KMk\s]+$/.test(t)) { name = t; break; }
        }
      }
      if (!name) continue;

      // Walk up the DOM from this link to find a container that holds a Twitter icon
      // Stop before we get too broad (body/html) or before we'd grab a sibling wallet's icon
      let twitterHandle = '';
      let container = link.parentElement;
      let depth = 0;
      while (container && container !== document.body && depth < 8) {
        const twitterImg = container.querySelector('img[alt="twitter logo"]');
        if (twitterImg && !clickedImgs.has(twitterImg)) {
          window._lastTwitterUrl = null;
          twitterImg.click();
          clickedImgs.add(twitterImg);
          twitterHandle = extractHandle(window._lastTwitterUrl);
          break;
        }
        container = container.parentElement;
        depth++;
      }

      results.push({ address, name, twitter: twitterHandle });
    }

    return results;
  });

  await browser.close();

  // Derive pfp, rank, and fill defaults
  wallets.forEach((w, i) => {
    w.rank = i + 1;
    w.pfp = `https://cdn.kolscan.io/profiles/${w.address}.png`;
    if (!w.twitter) w.twitter = '';
  });

  const withTwitter = wallets.filter(w => w.twitter).length;
  console.log(`Scraped ${wallets.length} wallets — ${withTwitter} with Twitter handles`);
  console.log('\nSample:');
  wallets.slice(0, 5).forEach(w => console.log(`  ${w.rank}. ${w.name} | ${w.twitter || '—'} | ${w.address.slice(0,8)}...`));

  // Write JSON
  const outJson = path.join(__dirname, '..', 'kol_catalog.json');
  fs.writeFileSync(outJson, JSON.stringify(wallets, null, 2));
  console.log(`\nSaved ${wallets.length} wallets to kol_catalog.json`);

  // Write JS snippet for index.html injection
  const lines = wallets.map(w =>
    `  { rank:${String(w.rank).padEnd(3)}, name:"${w.name.replace(/\\/g,'\\\\').replace(/"/g,'\\"')}", twitter:"${w.twitter}", pfp:"${w.pfp}", address:"${w.address}" }`
  );
  const jsOut = path.join(__dirname, '..', 'kol_catalog_array.txt');
  fs.writeFileSync(jsOut, `const kolCatalogWallets = [\n${lines.join(',\n')}\n];`);
  console.log(`Saved JS array to kol_catalog_array.txt`);
})();
