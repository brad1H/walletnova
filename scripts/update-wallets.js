const puppeteer = require('puppeteer');
const fs = require('fs');

async function scrapeLeaderboard() {
  console.log('Launching browser...');
  const browser = await puppeteer.launch({
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
  });

  const page = await browser.newPage();
  await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36');

  // Intercept API responses to find twitter handles
  const twitterFromApi = {};
  page.on('response', async res => {
    try {
      const ct = res.headers()['content-type'] || '';
      if (!ct.includes('json')) return;
      const url = res.url();
      if (url.includes('_next/static') || url.includes('analytics')) return;
      const text = await res.text();
      if (!text.includes('twitter') && !text.includes('Twitter')) return;
      console.log('API with twitter data:', url.slice(0, 120));
      console.log('Snippet:', text.slice(0, 600));
      // Try to extract address->twitter mappings
      const re = /"address"\s*:\s*"([A-Za-z0-9]{32,})"[^}]*"twitter"\s*:\s*"([^"]+)"/g;
      const re2 = /"twitter"\s*:\s*"([^"]+)"[^}]*"address"\s*:\s*"([A-Za-z0-9]{32,})"/g;
      let m;
      while ((m = re.exec(text)) !== null)  twitterFromApi[m[1]] = m[2].replace(/^@/,'');
      while ((m = re2.exec(text)) !== null) twitterFromApi[m[2]] = m[1].replace(/^@/,'');
    } catch(e) {}
  });

  console.log('Navigating to KOL Scan leaderboard...');
  await page.goto('https://kolscan.io/leaderboard', { waitUntil: 'networkidle2', timeout: 45000 });

  await page.waitForSelector('a[href*="/account/"]', { timeout: 20000 });
  await new Promise(r => setTimeout(r, 2000));

  // Debug: show the full row container of the first wallet link
  const debug = await page.evaluate(() => {
    const links = document.querySelectorAll('a[href*="/account/"]');
    const first = links[0];
    if (!first) return { error: 'no links found' };

    let row = first.parentElement;
    for (let i = 0; i < 8; i++) {
      if (!row) break;
      const text = row.innerText || '';
      if (text.includes('$') || text.includes('%')) break;
      row = row.parentElement;
    }

    return {
      totalLinks: links.length,
      firstHref: first.getAttribute('href'),
      rowHTML: row ? row.innerHTML.slice(0, 1200) : 'no row found',
      rowText: row ? (row.innerText || '').slice(0, 400) : 'no row found'
    };
  });
  console.log('DEBUG:', JSON.stringify(debug, null, 2));

  const wallets = await page.evaluate(() => {
    function parsePnl(text) {
      const negative = text.includes('-') || (text.includes('(') && text.includes(')'));
      const cleaned = text.replace(/[^0-9.KMkm]/g, '');
      if (!cleaned) return null;
      let num;
      if (/[Kk]$/.test(cleaned)) {
        num = parseFloat(cleaned) * 1000;
      } else if (/[Mm]$/.test(cleaned)) {
        num = parseFloat(cleaned) * 1000000;
      } else {
        num = parseFloat(cleaned);
      }
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

      // Get name from heading inside link
      let name = null;
      const heading = link.querySelector('h1, h2, h3, h4, h5, h6');
      if (heading && heading.textContent.trim()) {
        name = heading.textContent.trim();
      } else {
        const els = Array.from(link.querySelectorAll('*'));
        for (const el of els) {
          const t = el.childNodes.length === 1 && el.firstChild.nodeType === 3
            ? el.textContent.trim() : '';
          if (t && t.length > 1 && !/^[\d$+\-%.(),KMk]+$/.test(t)) {
            name = t;
            break;
          }
        }
      }
      if (!name) return;

      // Walk up from the link to find the row container that has PnL/WR data
      let row = link.parentElement;
      for (let i = 0; i < 8; i++) {
        if (!row) break;
        const text = row.innerText || row.textContent || '';
        if (text.includes('$') || text.includes('%')) break;
        row = row.parentElement;
      }

      const searchRoot = row || link;
      const rowText = (searchRoot.innerText || searchRoot.textContent || '').replace(/\s+/g, ' ');

      // Grab Twitter handle — check parent links of the twitter logo img first
      let twitter = null;
      const twitterLogoImg = searchRoot.querySelector('img[alt*="twitter"], img[alt*="Twitter"]');
      if (twitterLogoImg) {
        let el = twitterLogoImg.parentElement;
        for (let j = 0; j < 5; j++) {
          if (!el) break;
          const h = el.getAttribute('href') || '';
          const m = h.match(/(?:twitter\.com|x\.com)\/@?([^/?#\s]+)/i);
          if (m && m[1] && !['i','intent','home','share','hashtag','search'].includes(m[1].toLowerCase())) {
            twitter = m[1].replace(/^@/,'');
            break;
          }
          el = el.parentElement;
        }
      }
      // Also scan all anchors in the row
      if (!twitter) {
        const allAs = searchRoot.querySelectorAll('a[href]');
        for (const a of allAs) {
          const h = a.getAttribute('href') || '';
          const m = h.match(/(?:twitter\.com|x\.com)\/@?([^/?#\s]+)/i);
          if (m && m[1] && !['i','intent','home','share','hashtag','search'].includes(m[1].toLowerCase())) {
            twitter = m[1].replace(/^@/,'');
            break;
          }
        }
      }

      // Grab profile picture — first img in the row that looks like an avatar
      let pfp = null;
      const imgs = searchRoot.querySelectorAll('img');
      for (const img of imgs) {
        const src = img.getAttribute('src') || '';
        if (src && src.startsWith('http') && !src.includes('logo') && !src.includes('icon') && !src.includes('coin')) {
          pfp = src;
          break;
        }
      }

      let pnl = null;
      let wr = null;

      const wrMatch = rowText.match(/(\d+)\s*\/\s*(\d+)/);
      if (wrMatch) {
        const w = parseInt(wrMatch[1]);
        const l = parseInt(wrMatch[2]);
        if (!isNaN(w) && !isNaN(l) && (w + l) > 0) {
          wr = Math.round((w / (w + l)) * 100);
        }
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

      results.push({ address, name, pnl, wr, twitter, pfp });
    });

    return results.slice(0, 50);
  });

  // Apply any twitter handles found via API interception
  console.log(`API interception found ${Object.keys(twitterFromApi).length} twitter handles`);
  wallets.forEach(w => {
    if (!w.twitter && twitterFromApi[w.address]) {
      w.twitter = twitterFromApi[w.address];
      console.log(`  ${w.name} → @${w.twitter} (from API)`);
    }
  });

  // For wallets still missing a Twitter handle, visit their account page as fallback
  const needsTwitter = wallets.filter(w => !w.twitter);
  if (needsTwitter.length > 0) {
    console.log(`Leaderboard missing Twitter for ${needsTwitter.length} wallets — checking account pages...`);
    let firstPage = true;
    for (const w of needsTwitter) {
      try {
        await page.goto(`https://kolscan.io/account/${w.address}`, { waitUntil: 'networkidle2', timeout: 30000 });
        await new Promise(r => setTimeout(r, 1500));
        const result = await page.evaluate((isFirst) => {
          let twitter = null;
          let pfp = null;

          // Check __NEXT_DATA__ JSON blob for twitter handle
          const nextDataEl = document.getElementById('__NEXT_DATA__');
          if (nextDataEl) {
            try {
              const raw = nextDataEl.textContent;
              const patterns = [
                /(?:twitter\.com|x\.com)\\?\/@?([A-Za-z0-9_]{1,50})/g,
                /"twitter"\s*:\s*"([^"]+)"/g,
                /"twitterHandle"\s*:\s*"([^"]+)"/g,
                /"twitter_handle"\s*:\s*"([^"]+)"/g,
                /"twitterUsername"\s*:\s*"([^"]+)"/g,
              ];
              const skip = ['i','intent','home','share','hashtag','search','kolscan'];
              for (const re of patterns) {
                let m;
                while ((m = re.exec(raw)) !== null) {
                  const handle = m[1].replace(/^@/,'');
                  if (handle && !skip.includes(handle.toLowerCase())) {
                    twitter = handle;
                    break;
                  }
                }
                if (twitter) break;
              }
            } catch(e) {}
          }

          // Also check all anchors
          if (!twitter) {
            const allLinks = Array.from(document.querySelectorAll('a[href]'));
            for (const a of allLinks) {
              const h = a.getAttribute('href') || '';
              const m = h.match(/(?:twitter\.com|x\.com)\/@?([^/?#\s]+)/i);
              if (m && m[1] && !['i','intent','home','share','hashtag','search'].includes(m[1].toLowerCase())) {
                twitter = m[1].replace(/^@/,'');
                break;
              }
            }
          }

          const imgs = document.querySelectorAll('img');
          for (const img of imgs) {
            const src = img.getAttribute('src') || '';
            if (src && src.startsWith('http') && !src.includes('logo') && !src.includes('icon') && !src.includes('coin')) {
              pfp = src;
              break;
            }
          }

          const debugInfo = isFirst ? {
            hasNextData: !!document.getElementById('__NEXT_DATA__'),
            nextDataSnippet: document.getElementById('__NEXT_DATA__') ? document.getElementById('__NEXT_DATA__').textContent.slice(0, 500) : ''
          } : null;

          return { twitter, pfp, debugInfo };
        }, firstPage);

        if (firstPage && result.debugInfo) {
          console.log('DEBUG account page __NEXT_DATA__ exists:', result.debugInfo.hasNextData);
          console.log('DEBUG __NEXT_DATA__ snippet:', result.debugInfo.nextDataSnippet);
          firstPage = false;
        }

        if (result.twitter) {
          w.twitter = result.twitter;
          console.log(`  ${w.name} → @${result.twitter}`);
        } else {
          console.log(`  ${w.name} → no Twitter found`);
        }
        if (result.pfp && !w.pfp) w.pfp = result.pfp;
      } catch (e) {
        console.log(`  ${w.name} → failed (${e.message})`);
      }
    }
  }

  await browser.close();
  console.log(`Scraped ${wallets.length} wallets`);
  wallets.forEach((w, i) => console.log(`  ${i+1}. ${w.name} | pnl:${w.pnl} wr:${w.wr} twitter:${w.twitter || ''}`));
  return wallets;
}

async function updateHtml(scraped) {
  if (scraped.length === 0) {
    console.log('No wallets scraped — aborting to avoid wiping data.');
    process.exit(1);
  }

  const content = fs.readFileSync('index.html', 'utf8');

  // Preserve existing emoji, twitter, pfp across runs
  const emojiMap   = {};
  const twitterMap = {};
  const pfpMap     = {};
  const existingRegex = /\{\s*rank:\d+,\s*name:"[^"]*",\s*emoji:"([^"]*)",\s*twitter:"([^"]*)",\s*pfp:"([^"]*)",\s*address:"([^"]*)"/g;
  let em;
  while ((em = existingRegex.exec(content)) !== null) {
    emojiMap  [em[4]] = em[1];
    twitterMap[em[4]] = em[2];
    pfpMap    [em[4]] = em[3];
  }

  const defaultEmojis = ['⭐','🌟','💫','✨','🎯','🔥','💎','🚀','⚡','🌊','🎪','🏅','🎲','🃏','🧠','👁️','🌀','🎨','🎭','🎬'];
  let emojiIdx = 0;

  const lines = scraped.map((w, i) => {
    const emoji   = emojiMap[w.address]   || defaultEmojis[emojiIdx++ % defaultEmojis.length];
    const twitter = w.twitter             || twitterMap[w.address] || '';
    const pfp     = w.pfp                 || pfpMap[w.address]     || '';
    const pnl = w.pnl !== null ? w.pnl : 'null';
    const wr  = w.wr  !== null ? w.wr  : 'null';
    return `  { rank:${String(i+1).padEnd(2)}, name:"${w.name}", emoji:"${emoji}", twitter:"${twitter}", pfp:"${pfp}", address:"${w.address}", pnl:${pnl}, wr:${wr} }`;
  });

  const newArray = `const wallets = [\n${lines.join(',\n')},\n];`;

  const start = content.indexOf('const wallets = [');
  const end   = content.indexOf('\nconst insiderWallets');
  if (start === -1 || end === -1) {
    console.error('Could not find wallets array in index.html');
    process.exit(1);
  }

  const updated = content.slice(0, start) + newArray + content.slice(end);
  fs.writeFileSync('index.html', updated, 'utf8');
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
