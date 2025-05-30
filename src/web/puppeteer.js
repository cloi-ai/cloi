// uses puppeteer to capture browser errors
import puppeteer from 'puppeteer';

(async () => {
  const browser = await puppeteer.launch();
  const page = await browser.newPage();
  
  // Listen for console messages (including CORS errors)
  page.on('console', msg => console.log('BROWSER CONSOLE:', msg.text()));
  
  // Listen for network errors
  page.on('pageerror', error => {
    console.log('PAGE ERROR:', error.message);
  });

  // Enable request logging
  await page.setRequestInterception(true);
  page.on('request', request => {
    console.log(`REQUEST: ${request.method()} ${request.url()}`);
    request.continue();
  });

  try {
    // Option 1: Replace with your frontend URL that makes requests to your API
    await page.goto('http://localhost:3000'); // ← Replace with your frontend URL
    
    // OR Option 2: Use direct fetch to your API endpoint
    // await page.evaluate(() => {
    //   fetch('http://localhost:3000/your-endpoint') // ← Replace with your actual API endpoint
    //     .then(r => r.json())
    //     .catch(e => console.error('Fetch error:', e));
    // });
    
    // Wait a bit for the request to complete
    await new Promise(r => setTimeout(r, 2000));
  } catch (e) {
    console.log('Navigation error:', e);
  }

  await browser.close();
})();
