/**
 * Web error detection functionality
 */

/**
 * Detects if an error output indicates a web-related issue
 * @param {string} errorOutput - The error output to analyze
 * @returns {boolean} - True if the error appears to be web-related
 */
export function isWebError(errorOutput) {
  if (!errorOutput) return false;
  
  const outputStr = String(errorOutput);
  const outputLower = outputStr.toLowerCase();
  
  // Web-specific error patterns
  const webErrorPatterns = [
    // CORS and network errors
    /cors/i,
    /cross-origin/i,
    /fetch error/i,
    /xhr error/i,
    /network error/i,
    /failed to fetch/i,
    /access-control-allow-origin/i,
    
    // HTTP status errors
    /404 not found/i,
    /403 forbidden/i,
    /500 internal server/i,
    /502 bad gateway/i,
    /504 gateway timeout/i,
    
    // Browser console errors
    /browser console:/i,
    /uncaught reference error/i,
    /uncaught type error/i,
    /uncaught syntax error/i,
    
    // API and request errors
    /request:/i,
    /response:/i,
    /status code/i,
    /api error/i,
    /endpoint/i,
    
    // DOM and rendering errors
    /cannot read property/i,
    /undefined is not an object/i,
    /null is not an object/i,
    /cannot set property/i,
    /document is not defined/i,
    /window is not defined/i,
    
    // Framework-specific errors
    /react/i,
    /angular/i,
    /vue/i,
    /svelte/i,
    /next\.js/i,
    /nuxt\.js/i,
    
    // Web server errors
    /eaddrinuse/i,
    /address already in use/i,
    /port.*in use/i,
    /cannot bind to port/i,
    
    // Web build errors
    /webpack/i,
    /vite/i,
    /babel/i,
    /eslint/i,
    /typescript/i,
    /module not found/i,
    
    // Common web technologies
    /html/i,
    /css/i,
    /javascript/i,
    /json/i,
    /ajax/i,
    /websocket/i
  ];
  
  // Check if any web error pattern matches
  for (const pattern of webErrorPatterns) {
    if (pattern.test(outputLower)) {
      return true;
    }
  }
  
  // Check for URLs in the error output
  const urlRegex = /(https?:\/\/[^\s]+)/g;
  const urls = outputStr.match(urlRegex) || [];
  
  // Check for localhost URLs specifically
  const localhostRegex = /(https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0):\d+[^\s]*)/g;
  const localhostUrls = outputStr.match(localhostRegex) || [];
  
  return urls.length > 0 || localhostUrls.length > 0;
}
