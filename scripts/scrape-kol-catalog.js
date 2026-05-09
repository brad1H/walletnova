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

  // Scrape all wallet addresses + names
  const wallets = await page.evaluate(() => {
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
      const heading = link.querySelector('h1,h2,h3,h4,h5,h6');
      if (heading && heading.textContent.trim()) {
        name = heading.textContent.trim();
      } else {
        for (const el of Array.from(link.querySelectorAll('*'))) {
          const t = el.childNodes.length === 1 && el.firstChild.nodeType === 3 ? el.textContent.trim() : '';
          if (t && t.length > 1 && !/^[\d$+\-%.,()KMk\s]+$/.test(t)) { name = t; break; }
        }
      }
      if (!name) return;
      results.push({ address, name });
    });

    return results;
  });

  console.log(`Scraped ${wallets.length} wallets`);

  // Intercept window.open to capture Twitter URLs
  console.log('Setting up Twitter capture...');
  await page.evaluate(() => {
    window._twitterCaptures = [];
    window.open = function(url) {
      window._twitterCaptures.push(url || '');
      return null;
    };
  });

  // Click all twitter logos
  const clickCount = await page.evaluate(() => {
    const imgs = Array.from(document.querySelectorAll('img[alt="twitter logo"]'));
    imgs.forEach(img => img.click());
    return imgs.length;
  });
  console.log(`Clicked ${clickCount} twitter logos`);
  await new Promise(r => setTimeout(r, 1500));

  const twitterUrls = await page.evaluate(() => window._twitterCaptures);
  console.log(`Captured ${twitterUrls.length} Twitter URLs`);

  // Map Twitter handles to wallets by index
  twitterUrls.forEach((url, i) => {
    if (i < wallets.length && url) {
      const m = url.match(/(?:twitter\.com|x\.com)\/@?([^/?#\s]+)/i);
      if (m && m[1] && !['i','intent','home','share','hashtag','search'].includes(m[1].toLowerCase())) {
        wallets[i].twitter = m[1].replace(/^@/, '');
      }
    }
  });

  await browser.close();

  // Derive pfp and fill defaults
  wallets.forEach((w, i) => {
    w.rank = i + 1;
    w.pfp = `https://cdn.kolscan.io/profiles/${w.address}.png`;
    if (!w.twitter) w.twitter = '';
  });

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
