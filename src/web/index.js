/**
 * Web agent module for detecting and handling web-related issues
 */

import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { promises as fs } from 'fs';
import { execSync } from 'child_process';
import { exec } from 'child_process';
import chalk from 'chalk';

/**
 * Detects if the command output indicates a web-related issue
 * @param {string} output - The output from running a command
 * @returns {Object} - Object with isWebIssue flag and extracted URLs
 */
export function isWebIssue(output) {
  if (!output) return { isWebIssue: false, urls: [] };
  
  // Convert output to string for pattern matching
  const outputStr = String(output);
  const outputLower = outputStr.toLowerCase();
  
  // Extract all URLs from the output
  const allUrls = extractUrls(outputStr);
  
  // Extract localhost URLs specifically
  const localhostUrls = extractLocalhostUrls(outputStr);
  
  // Web server patterns
  const webServerPatterns = [
    // Server startup messages
    /serving!/i,
    /listening on/i,
    /running at/i,
    /started server/i,
    /server running/i,
    /server started/i,
    
    // Common web frameworks and servers
    /express server/i,
    /webpack/i,
    /vite/i,
    /next\.js/i,
    /nuxt\.js/i,
    /react-scripts/i,
    /angular/i,
    /vue/i,
    /svelte/i,
    /nginx/i,
    /apache/i,
    
    // Web-specific errors
    /cors/i,
    /cross-origin/i,
    /fetch error/i,
    /xhr error/i,
    /network error/i,
    /browser console:/i,
    /request:/i,
    /response:/i,
    /status code/i,
    /404 not found/i,
    /500 internal server/i,
    
    // NPM/Yarn web commands
    /^npm /i,                    // Any command starting with npm
    /npm run (start|dev|serve)/i,
    /yarn (start|dev|serve)/i,
    /npx serve/i
  ];
  
  // Check if any web server pattern matches
  let patternMatch = false;
  for (const pattern of webServerPatterns) {
    if (pattern.test(outputLower)) {
      patternMatch = true;
      break;
    }
  }
  
  // Check for common port numbers in the output
  let portMatch = false;
  const portNumbers = [3000, 8000, 8080, 4200, 5000, 5173, 5174, 8800, 9000];
  for (const port of portNumbers) {
    if (outputLower.includes(`:${port}`)) {
      portMatch = true;
      break;
    }
  }
  
  // Determine if this is a web issue
  const isWebIssueFlag = patternMatch || portMatch || localhostUrls.length > 0;
  
  return { 
    isWebIssue: isWebIssueFlag, 
    urls: localhostUrls.length > 0 ? localhostUrls : allUrls,
    localhostUrls
  };
}

/**
 * Extracts URLs from command output
 * @param {string} output - The output from running a command
 * @returns {string[]} - Array of URLs found in the output
 */
export function extractUrls(output) {
  if (!output) return [];
  
  const outputStr = String(output);
  const urlRegex = /(https?:\/\/[^\s]+)/g;
  return outputStr.match(urlRegex) || [];
}

/**
 * Extracts localhost URLs from command output
 * @param {string} output - The output from running a command
 * @returns {Promise<string[]>} - Array of localhost URLs found in the output
 */
export async function extractLocalhostUrls(output) {
  if (!output) return [];
  
  const outputStr = String(output);
  const matches = [];
  
  // Regex patterns for different localhost URL formats
  const patterns = [
    /(https?:\/\/localhost:\d+[^\s]*)/g,  // http://localhost:3000
    /(https?:\/\/127\.0\.0\.1:\d+[^\s]*)/g,  // http://127.0.0.1:3000
    /(https?:\/\/0\.0\.0\.0:\d+[^\s]*)/g,  // http://0.0.0.0:3000
    /Local:\s+(https?:\/\/localhost:\d+[^\s]*)/g,  // React startup: Local: http://localhost:3000
    /Local:\s+http:\/\/localhost:(\d+)/g,  // Extract from React format: Local: http://localhost:3000
  ];
  
  // Step 1: Check the immediate output
  for (const pattern of patterns) {
    const patternMatches = outputStr.match(pattern) || [];
    // For patterns that capture the full URL
    if (pattern.toString().includes('(https')) {
      matches.push(...patternMatches);
    } 
    // For patterns that only capture the port number
    else if (patternMatches.length > 0) {
      // Extract the port number and construct the URL
      for (const match of patternMatches) {
        const portMatch = match.match(/(\d+)/);
        if (portMatch && portMatch[1]) {
          matches.push(`http://localhost:${portMatch[1]}`);
        }
      }
    }
  }
  
  // Step 2: Check for common React/Next.js/Vue patterns in text
  if (outputStr.includes('You can now view') && outputStr.includes('in the browser')) {
    // This is a typical React startup message
    const portMatch = outputStr.match(/localhost:(\d+)/);
    if (portMatch && portMatch[1]) {
      matches.push(`http://localhost:${portMatch[1]}`);
    }
  }
  
  // Step 3: Check terminal logs for URLs if we haven't found any yet
  if (matches.length === 0) {
    try {
      // Import terminal logs reader dynamically to avoid circular dependencies
      const { readTerminalLogs } = await import('../utils/terminalLogs.js');
      const recentLogs = await readTerminalLogs(1000); // Get last 1000 lines of terminal logs
      
      // Look for React startup message in recent logs
      if (recentLogs.includes('You can now view') && recentLogs.includes('in the browser')) {
        // console.log(chalk.gray('  Found React startup message in terminal logs'));
        // Extract URL from React startup message
        const localMatch = recentLogs.match(/Local:\s+(https?:\/\/localhost:\d+[^\s]*)/);
        if (localMatch && localMatch[1]) {
          // console.log(chalk.gray(`  Extracted URL from logs: ${localMatch[1]}`));
          matches.push(localMatch[1]);
        } else {
          // Try to extract just the port
          const portMatch = recentLogs.match(/localhost:(\d+)/);
          if (portMatch && portMatch[1]) {
            const url = `http://localhost:${portMatch[1]}`;
            // console.log(chalk.gray(`  Extracted port from logs: ${url}`));
            matches.push(url);
          }
        }
      }
      
      // Check for any localhost URLs in the logs
      for (const pattern of patterns) {
        const patternMatches = recentLogs.match(pattern) || [];
        if (patternMatches.length > 0) {
          // console.log(chalk.gray(`  Found ${patternMatches.length} URLs in terminal logs`));
          // For patterns that capture the full URL
          if (pattern.toString().includes('(https')) {
            matches.push(...patternMatches);
          } 
          // For patterns that only capture the port number
          else {
            // Extract the port number and construct the URL
            for (const match of patternMatches) {
              const portMatch = match.match(/(\d+)/);
              if (portMatch && portMatch[1]) {
                matches.push(`http://localhost:${portMatch[1]}`);
              }
            }
          }
        }
      }
    } catch (error) {
      // console.log(chalk.gray(`  Error reading terminal logs: ${error.message}`));
    }
  }
  
  // Step 4: If still no URLs found, use common development ports as fallback
  if (matches.length === 0) {
    // Default to common development ports
    const commonPorts = [3000, 8080, 5173, 4200, 8000];
    // Check if the command includes a hint about which port to use
    if (outputStr.includes('port')) {
      const portMatch = outputStr.match(/port\s*(\d+)/i);
      if (portMatch && portMatch[1]) {
        const port = parseInt(portMatch[1], 10);
        if (port > 0 && port < 65536) { // Valid port range
          // console.log(chalk.gray(`  Using port mentioned in output: ${port}`));
          matches.push(`http://localhost:${port}`);
        }
      }
    } else {
      // Add the most common development port as a fallback
      // console.log(chalk.gray('  No URLs found, using common development port 3000 as fallback'));
      matches.push('http://localhost:3000');
    }
  }
  
  // Remove duplicates and return
  return [...new Set(matches)];
}

/**
 * Extracts port number from a URL
 * @param {string} url - URL to extract port from
 * @returns {number|null} - Port number or null if not found
 */
export function extractPortFromUrl(url) {
  if (!url) return null;
  
  const match = url.match(/:([0-9]+)/);
  if (match && match[1]) {
    return parseInt(match[1], 10);
  }
  return null;
}

/**
 * Extracts port number from an error message
 * @param {string} errorMessage - Error message to extract port from
 * @returns {number|null} - Port number or null if not found
 */
export function extractPortFromErrorMessage(errorMessage) {
  if (!errorMessage) return null;
  
  // Common error patterns for port-in-use errors
  const patterns = [
    /EADDRINUSE: address already in use :[0-9]*:([0-9]+)/i,  // Node.js style
    /EADDRINUSE.*?:([0-9]+)/i,  // Simplified Node.js
    /address already in use.*?:([0-9]+)/i,  // Generic
    /port ([0-9]+) is already in use/i,  // Python style
    /Unable to bind to port ([0-9]+)/i,  // Generic
    /port=([0-9]+)[^\d]/i,  // Port in error object
  ];
  
  for (const pattern of patterns) {
    const match = errorMessage.match(pattern);
    if (match && match[1]) {
      return parseInt(match[1], 10);
    }
  }
  
  return null;
}

/**
 * Checks if a port is in use
 * @param {number} port - Port number to check
 * @returns {Promise<boolean>} - True if the port is in use, false otherwise
 */
export async function isPortInUse(port) {
  if (!port || isNaN(port)) return false;
  
  try {
    // Find process ID using the port
    const lsofOutput = execSync(`lsof -i :${port} -t`, { encoding: 'utf8' }).trim();
    return lsofOutput.length > 0;
  } catch (error) {
    return false;
  }
}

/**
 * Extracts ports from a command string
 * @param {string} cmd - Command string to extract ports from
 * @returns {number[]} - Array of port numbers
 */
export function extractPortsFromCommand(cmd) {
  if (!cmd) return [];
  
  const ports = [];
  
  // Common port patterns in commands
  const patterns = [
    /--port[=\s]+(\d+)/i,  // --port=3000 or --port 3000
    /-p[=\s]+(\d+)/i,      // -p=3000 or -p 3000
    /PORT=(\d+)/i,         // PORT=3000
    /:(\d+)/              // :3000 in URLs or other contexts
  ];
  
  for (const pattern of patterns) {
    const matches = cmd.matchAll(pattern);
    for (const match of matches) {
      if (match && match[1]) {
        const port = parseInt(match[1], 10);
        if (!isNaN(port) && port > 0 && port < 65536) {
          ports.push(port);
        }
      }
    }
  }
  
  return [...new Set(ports)]; // Remove duplicates
}

/**
 * Kills processes running on specific ports
 * @param {number[]} ports - Array of port numbers to check and kill processes on
 * @returns {Promise<{[port: number]: boolean}>} - Object with ports as keys and success status as values
 */
export async function killProcessesOnPorts(ports) {
  if (!ports || !Array.isArray(ports) || ports.length === 0) {
    return {};
  }
  
  const results = {};
  
  for (const port of ports) {
    if (!port || isNaN(port)) {
      results[port] = false;
      continue;
    }
    
    try {
      // Find process IDs using the port
      const lsofOutput = execSync(`lsof -i :${port} -t`, { encoding: 'utf8' }).trim();
      
      if (!lsofOutput) {
        console.log(chalk.gray(`  No process found on port ${port}`));
        results[port] = true;
        continue;
      }
      
      // Split by newlines in case multiple processes use the port
      const pids = lsofOutput.split('\n').filter(Boolean);
      
      if (pids.length === 0) {
        console.log(chalk.gray(`  No process found on port ${port}`));
        results[port] = true;
        continue;
      }
      
      console.log(chalk.yellow(`  Found ${pids.length} process(es) on port ${port}: ${pids.join(', ')}`));
      
      // Kill each process
      for (const pid of pids) {
        console.log(chalk.gray(`  Killing process ${pid}...`));
        execSync(`kill -9 ${pid}`, { encoding: 'utf8' });
      }
      
      // Verify the port is now free
      try {
        const checkAgain = execSync(`lsof -i :${port} -t`, { encoding: 'utf8' }).trim();
        if (checkAgain) {
          console.log(chalk.red(`  Failed to kill all processes on port ${port}`));
          results[port] = false;
        } else {
          console.log(chalk.green(`  Successfully freed port ${port}`));
          results[port] = true;
        }
      } catch (error) {
        // If lsof fails, it likely means no process is using the port
        console.log(chalk.green(`  Successfully freed port ${port}`));
        results[port] = true;
      }
    } catch (error) {
      // If lsof fails, it likely means no process is using the port
      console.log(chalk.gray(`  No process found on port ${port}`));
      results[port] = true;
    }
  }
  
  return results;
}

/**
 * Runs a command in a new terminal window (macOS specific)
 * @param {string} cmd - The command to run
 * @param {string} cwd - The working directory for the command
 * @param {string} [title='Web Server'] - The title for the terminal window
 * @returns {Promise<boolean>} - True if the command was started successfully
 */
export async function runCommandInNewTerminal(cmd, cwd, title = 'Web Server') {
  if (!cmd) return false;
  
  // Detect platform
  const platform = process.platform;
  
  if (platform === 'darwin') {
    // macOS implementation
    try {
      // Create an AppleScript command to open a new Terminal window
      const escapedCmd = cmd.replace(/"/g, '\\"');
      const escapedCwd = cwd.replace(/"/g, '\\"');
      const escapedTitle = title.replace(/"/g, '\\"');
      
      const appleScript = `
      tell application "Terminal"
        do script "cd \\"${escapedCwd}\\" && echo -e '\\033]0;${escapedTitle}\\007' && ${escapedCmd}"
        activate
      end tell
      `;
      
      // Execute the AppleScript
      execSync(`osascript -e '${appleScript}'`, { encoding: 'utf8' });
      return true;
    } catch (error) {
      console.error(chalk.red(`Error starting terminal: ${error.message}`));
      return false;
    }
  } else if (platform === 'win32') {
    // Windows implementation
    try {
      // Create a command for Windows Command Prompt
      const escapedCmd = cmd.replace(/"/g, '\\"');
      const startCommand = `start cmd.exe /K "cd /d "${cwd}" && title ${title} && ${escapedCmd}"`;
      
      // Execute the command
      execSync(startCommand, { encoding: 'utf8', shell: 'cmd.exe' });
      return true;
    } catch (error) {
      console.error(chalk.red(`Error starting terminal: ${error.message}`));
      return false;
    }
  } else {
    // Linux and other platforms
    try {
      // Try with gnome-terminal first
      try {
        execSync(`gnome-terminal -- bash -c "cd '${cwd}' && echo -e '\\033]0;${title}\\007' && ${cmd}; exec bash"`, { encoding: 'utf8' });
        return true;
      } catch (gnomeError) {
        // If gnome-terminal fails, try xterm
        try {
          execSync(`xterm -T "${title}" -e "cd '${cwd}' && ${cmd}; bash"`, { encoding: 'utf8' });
          return true;
        } catch (xtermError) {
          // If xterm fails, try konsole
          execSync(`konsole --workdir '${cwd}' -e bash -c "${cmd}; bash"`, { encoding: 'utf8' });
          return true;
        }
      }
    } catch (error) {
      console.error(chalk.red(`Error starting terminal: ${error.message}`));
      return false;
    }
  }
}

/**
 * Uses LLM to analyze project files and determine hosting commands
 * @param {string} projectPath - Path to the project directory
 * @param {string} [model='phi4:latest'] - The Ollama model to use
 * @returns {Promise<{commands: string[], frontendUrl: string|null, ports: number[]}>} - Hosting commands, frontend URL, and ports
 */
export async function fetchHostCommand(projectPath, model = 'phi4:latest') {
  if (!projectPath) {
    return { commands: [], frontendUrl: null, ports: [] };
  }
  
  console.log(chalk.gray(`  Analyzing project at ${projectPath}...`));
  
  try {
    // Import startThinking dynamically to avoid circular dependencies
    const { startThinking } = await import('../core/ui/thinking.js');
    
    // Start thinking animation
    const stopThinking = startThinking('Analyzing project structure');
    
    try {
      // Check for package.json
      const packageJsonPath = join(projectPath, 'package.json');
      let packageJson = null;
      
      try {
        const packageJsonContent = await fs.readFile(packageJsonPath, 'utf8');
        packageJson = JSON.parse(packageJsonContent);
      } catch (error) {
        console.log(chalk.gray(`  No package.json found or invalid JSON: ${error.message}`));
      }
      
      // Check for common web project files
      const fileChecks = [
        { file: 'package.json', exists: !!packageJson },
        { file: 'angular.json', exists: false },
        { file: 'next.config.js', exists: false },
        { file: 'nuxt.config.js', exists: false },
        { file: 'vite.config.js', exists: false },
        { file: 'webpack.config.js', exists: false },
        { file: 'vue.config.js', exists: false },
        { file: 'svelte.config.js', exists: false },
        { file: 'index.html', exists: false },
        { file: 'public/index.html', exists: false },
        { file: 'src/index.html', exists: false },
        { file: 'src/main.js', exists: false },
        { file: 'src/App.js', exists: false },
        { file: 'src/App.jsx', exists: false },
        { file: 'src/App.vue', exists: false },
        { file: 'src/App.svelte', exists: false }
      ];
      
      // Check if each file exists
      for (let i = 1; i < fileChecks.length; i++) {
        const check = fileChecks[i];
        try {
          const filePath = join(projectPath, check.file);
          const stats = await fs.stat(filePath);
          check.exists = stats.isFile();
        } catch (error) {
          // File doesn't exist, keep exists as false
        }
      }
      
      // Determine project type and hosting commands
      let commands = [];
      let frontendUrl = null;
      let ports = [];
      
      // Extract scripts from package.json if available
      if (packageJson && packageJson.scripts) {
        const scripts = packageJson.scripts;
        
        // Common script names for starting web servers
        const startScripts = ['start', 'dev', 'serve', 'develop', 'development', 'server', 'preview'];
        
        // Check for these scripts in package.json
        for (const scriptName of startScripts) {
          if (scripts[scriptName]) {
            commands.push(`npm run ${scriptName}`);
            
            // Extract potential ports from the script command
            const scriptPorts = extractPortsFromCommand(scripts[scriptName]);
            if (scriptPorts.length > 0) {
              ports.push(...scriptPorts);
            }
          }
        }
      }
      
      // If no commands found from package.json, try to determine from project structure
      if (commands.length === 0) {
        // Check for specific frameworks
        if (fileChecks.find(c => c.file === 'angular.json').exists) {
          commands.push('ng serve');
          frontendUrl = 'http://localhost:4200';
          ports.push(4200);
        } else if (fileChecks.find(c => c.file === 'next.config.js').exists) {
          commands.push('npm run dev');
          frontendUrl = 'http://localhost:3000';
          ports.push(3000);
        } else if (fileChecks.find(c => c.file === 'nuxt.config.js').exists) {
          commands.push('npm run dev');
          frontendUrl = 'http://localhost:3000';
          ports.push(3000);
        } else if (fileChecks.find(c => c.file === 'vite.config.js').exists) {
          commands.push('npm run dev');
          frontendUrl = 'http://localhost:5173';
          ports.push(5173);
        } else if (fileChecks.find(c => c.file === 'webpack.config.js').exists) {
          commands.push('npm run start');
          frontendUrl = 'http://localhost:8080';
          ports.push(8080);
        } else if (fileChecks.find(c => c.file === 'vue.config.js').exists) {
          commands.push('npm run serve');
          frontendUrl = 'http://localhost:8080';
          ports.push(8080);
        } else if (fileChecks.find(c => c.file === 'svelte.config.js').exists) {
          commands.push('npm run dev');
          frontendUrl = 'http://localhost:5173';
          ports.push(5173);
        } else if (fileChecks.find(c => c.file === 'index.html').exists || 
                  fileChecks.find(c => c.file === 'public/index.html').exists || 
                  fileChecks.find(c => c.file === 'src/index.html').exists) {
          // Simple static site, use a static server
          commands.push('npx serve');
          frontendUrl = 'http://localhost:3000';
          ports.push(3000);
        }
      }
      
      // If we still don't have a frontendUrl but we have commands, make an educated guess
      if (!frontendUrl && commands.length > 0) {
        // Check if we have ports
        if (ports.length > 0) {
          // Use the first port for the frontend URL
          frontendUrl = `http://localhost:${ports[0]}`;
        } else {
          // Default to common port
          frontendUrl = 'http://localhost:3000';
          ports.push(3000);
        }
      }
      
      // Stop thinking animation
      stopThinking();
      
      return { commands, frontendUrl, ports };
    } catch (error) {
      // Stop thinking animation in case of error
      stopThinking();
      console.error(chalk.red(`Error analyzing project: ${error.message}`));
      return { commands: [], frontendUrl: null, ports: [] };
    }
  } catch (error) {
    console.error(chalk.red(`Error importing dependencies: ${error.message}`));
    return { commands: [], frontendUrl: null, ports: [] };
  }
}

/**
 * Checks if puppeteer is installed either globally or in the current project
 * @returns {Promise<boolean>} - True if puppeteer is installed, false otherwise
 */
/**
 * Finds the path to the puppeteer installation
 * @returns {Promise<string|null>} - Path to puppeteer or null if not found
 */
async function findPuppeteerPath() {
  try {
    // Try to find puppeteer in cloi's node_modules
    // This path is relative to this file's location in the cloi package
    const cloiNodeModules = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'node_modules');
    const cloiPuppeteerPath = join(cloiNodeModules, 'puppeteer');
    try {
      await fs.access(cloiPuppeteerPath);
      // console.log(chalk.gray('  Found puppeteer in cloi node_modules'));
      return cloiPuppeteerPath;
    } catch (e) {
      // Puppeteer not found in cloi node_modules
      // console.log(chalk.gray('  Puppeteer not found in cloi node_modules'));
    }
    
    // Try to find puppeteer in global node_modules
    try {
      const { stdout } = await new Promise((resolve, reject) => {
        exec('npm root -g', (error, stdout, stderr) => {
          if (error) reject(error);
          else resolve({ stdout, stderr });
        });
      });
      
      const globalNodeModules = stdout.trim();
      const globalPuppeteerPath = join(globalNodeModules, 'puppeteer');
      try {
        await fs.access(globalPuppeteerPath);
        // console.log(chalk.gray('  Found puppeteer in global node_modules'));
        return globalPuppeteerPath;
      } catch (e) {
        // Puppeteer not found in global node_modules
        // console.log(chalk.gray('  Puppeteer not found in global node_modules'));
      }
    } catch (e) {
      // console.log(chalk.gray(`  Error checking global node_modules: ${e.message}`));
    }
    
    return null;
  } catch (error) {
    // console.log(chalk.gray(`  Error finding puppeteer path: ${error.message}`));
    return null;
  }
}

/**
 * Checks if puppeteer is installed either globally or in the current project
 * @returns {Promise<boolean>} - True if puppeteer is installed, false otherwise
 */
async function checkPuppeteerInstalled() {
  try {
    // First, try to dynamically import puppeteer from cloi's installation
    try {
      // This will work if cloi is installed globally or locally and we're using it from its installation directory
      await import('puppeteer');
      // console.log(chalk.gray('  Successfully imported puppeteer module'));
      return true;
    } catch (importError) {
      // console.log(chalk.gray('  Could not import puppeteer directly, checking other locations...'));
    }
    
    // Check if we can find puppeteer path
    const puppeteerPath = await findPuppeteerPath();
    if (puppeteerPath) {
      return true;
    }
    
    // Check if puppeteer is in the current project
    try {
      const { stdout: localStdout } = await new Promise((resolve, reject) => {
        exec('npm list puppeteer', (error, stdout, stderr) => {
          resolve({ stdout, stderr });
        });
      });
      
      if (localStdout.includes('puppeteer@')) {
        // console.log(chalk.gray('  Found local puppeteer installation'));
        return true;
      }
    } catch (e) {
      // Ignore errors from npm list
      // console.log(chalk.gray('  Puppeteer not found in current project'));
    }
    
    // If we get here, puppeteer is not installed anywhere we can access
    // console.log(chalk.yellow('  Puppeteer not found in any location. Consider installing it with: npm install -g puppeteer'));
    return false;
  } catch (error) {
    // console.log(chalk.gray(`  Error checking for puppeteer: ${error.message}`));
    return false;
  }
}

/**
 * Runs a puppeteer script to detect browser errors for a given frontend URL
 * @param {string} frontendUrl - The URL of the frontend to test
 * @param {string} cwd - The current working directory where the command was run
 * @returns {Promise<string>} - The output from running the puppeteer script
 */
export async function runPuppeteer(frontendUrl, cwd) {
  if (!frontendUrl) {
    console.log(chalk.yellow('No frontend URL provided for browser testing'));
    return '';
  }
  
  // console.log(chalk.gray(`Running browser test for ${frontendUrl}...`));
  
  // Create a temporary puppeteer script in the user's current directory
  const tempScriptPath = join(cwd, 'temp_puppeteer.js');
  
  try {
    // First, check if puppeteer is installed globally or in cloi
    const isPuppeteerInstalled = await checkPuppeteerInstalled();
    if (!isPuppeteerInstalled) {
      console.log(chalk.yellow('Puppeteer is not installed. Using fallback browser log retrieval.'));
      return 'Browser logs could not be retrieved because puppeteer is not installed.\n' +
        'Consider installing puppeteer globally with: npm install -g puppeteer';
    }
    
    // Get the template puppeteer script
    // Use the path relative to the current file
    const templatePath = join(dirname(fileURLToPath(import.meta.url)), 'puppeteer.js');
    let puppeteerTemplate = await fs.readFile(templatePath, 'utf8');
    
    // Replace the placeholder URL with the actual frontend URL
    puppeteerTemplate = puppeteerTemplate.replace(
      "await page.goto('http://localhost:3000'); // ← Replace with your frontend URL",
      `await page.goto('${frontendUrl}'); // Dynamically set by CLOI`
    );
    
    // Check if the project uses ES modules or CommonJS
    let isESModule = false;
    try {
      const packageJsonPath = join(cwd, 'package.json');
      const packageJsonContent = await fs.readFile(packageJsonPath, 'utf8');
      const packageJson = JSON.parse(packageJsonContent);
      isESModule = packageJson.type === 'module';
    } catch (error) {
      // If we can't read package.json, assume CommonJS
      // console.log(chalk.gray(`  Could not determine module type from package.json: ${error.message}`));
      // console.log(chalk.gray(`  Assuming CommonJS format`));
    }
    
    // Adjust the import style based on the module type
    if (!isESModule) {
      // console.log(chalk.gray('  Converting to CommonJS format for compatibility'));
      puppeteerTemplate = puppeteerTemplate.replace(
        "import puppeteer from 'puppeteer';",
        "const puppeteer = require('puppeteer');"
      );
    }
    
    // Modify the script to use the correct puppeteer path if needed
    const puppeteerPath = await findPuppeteerPath();
    if (puppeteerPath) {
      // console.log(chalk.gray(`  Using puppeteer from: ${puppeteerPath}`));
      // Replace the import/require with the absolute path
      if (isESModule) {
        puppeteerTemplate = puppeteerTemplate.replace(
          "import puppeteer from 'puppeteer';",
          `import puppeteer from '${puppeteerPath}';`
        );
      } else {
        puppeteerTemplate = puppeteerTemplate.replace(
          "const puppeteer = require('puppeteer');",
          `const puppeteer = require('${puppeteerPath}');`
        );
      }
    }
    
    // Write the modified script to the temporary location
    await fs.writeFile(tempScriptPath, puppeteerTemplate, 'utf8');
    
    // console.log(chalk.gray(`Created temporary puppeteer script at ${tempScriptPath}`));
    
    // Run the puppeteer script and capture its output
    try {
      const output = execSync(`node "${tempScriptPath}"`, { 
        encoding: 'utf8',
        cwd: cwd,
        stdio: 'pipe'
      });
      
      return output;
    } catch (execError) {
      // For execSync errors, we still want to capture the stdout as it contains valuable error information
      console.log(chalk.yellow(`Puppeteer exited with code ${execError.status || 'unknown'}`));
      
      // Return stdout if available, as it contains the actual browser errors
      if (execError.stdout) {
        console.log(chalk.gray('Puppeteer output captured:'));
        return execError.stdout;
      }
      
      // If no stdout, return the error message
      return `Error running puppeteer: ${execError.message}`;
    }
  } catch (error) {
    console.error(chalk.red(`Error setting up puppeteer: ${error.message}`));
    return `Error setting up puppeteer: ${error.message}`;
  } finally {
    // Clean up the temporary script
    try {
      await fs.unlink(tempScriptPath);
      // console.log(chalk.gray(`Removed temporary puppeteer script`));
    } catch (cleanupError) {
      console.error(chalk.red(`Error removing temporary script: ${cleanupError.message}`));
    }
  }
}

/**
 * Analyzes browser errors from puppeteer output using LLM and suggests fixes
 * @param {string} puppeteerOutput - The output from running puppeteer
 * @param {string} frontendUrl - The URL of the frontend that was tested
 * @param {string} projectPath - Path to the project directory
 * @param {string} [model='phi4:latest'] - The Ollama model to use
 * @returns {Promise<{issue: string, explanation: string, fix: string, files: string[]}>} - Analysis results
 */
export async function analyzeWithLLMWebAgent(puppeteerOutput, frontendUrl, projectPath, model = 'phi4:latest') {
  if (!puppeteerOutput) {
    return {
      issue: 'No browser output to analyze',
      explanation: 'The puppeteer script did not produce any output to analyze.',
      fix: 'No fix suggested',
      files: []
    };
  }
  
  try {
    // Import LLM functionality dynamically to avoid circular dependencies
    const { analyzeWithLLM } = await import('../core/index.js');
    const { startThinking } = await import('../core/ui/thinking.js');
    
    // Start thinking animation
    const stopThinking = startThinking('Analyzing browser behavior');
    
    try {
      // Prepare the analysis prompt
      const analysisPrompt = `
You are analyzing browser console output from a web application to identify and fix issues.

BROWSER OUTPUT:
${puppeteerOutput}

FRONTEND URL: ${frontendUrl}
PROJECT PATH: ${projectPath}

Please analyze the browser console output above and identify any issues such as:
1. CORS errors
2. Network errors
3. JavaScript errors
4. Missing resources
5. API connection problems
6. Other browser-specific issues

Then provide:
1. A brief summary of the main issue
2. A detailed explanation of what's causing the problem
3. Specific steps to fix the issue
4. List of files that likely need to be modified

Format your response as JSON with these keys:
{
  "issue": "Brief summary of the main issue",
  "explanation": "Detailed explanation of what's causing the problem",
  "fix": "Specific steps to fix the issue",
  "files": ["file1.js", "file2.js"]
}
`;
      
      // Run LLM analysis
      const analysis = await analyzeWithLLM(analysisPrompt, model);
      
      // Parse the JSON response
      let parsedAnalysis;
      try {
        // Extract JSON from the response (it might be wrapped in markdown code blocks)
        const jsonMatch = analysis.match(/```json\n([\s\S]*?)\n```/) || 
                         analysis.match(/```\n([\s\S]*?)\n```/) || 
                         analysis.match(/{[\s\S]*?}/);
        
        const jsonString = jsonMatch ? jsonMatch[1] || jsonMatch[0] : analysis;
        parsedAnalysis = JSON.parse(jsonString);
      } catch (parseError) {
        console.log(chalk.yellow(`Could not parse LLM response as JSON: ${parseError.message}`));
        
        // Fallback to a simple extraction of key information
        const issueMatch = analysis.match(/issue[:\s]+(.*?)(?:\n|$)/i);
        const explanationMatch = analysis.match(/explanation[:\s]+([\s\S]*?)(?:\n\n|$)/i);
        const fixMatch = analysis.match(/fix[:\s]+([\s\S]*?)(?:\n\n|$)/i);
        const filesMatch = analysis.match(/files[:\s]+([\s\S]*?)(?:\n\n|$)/i);
        
        parsedAnalysis = {
          issue: issueMatch ? issueMatch[1].trim() : 'Could not determine issue',
          explanation: explanationMatch ? explanationMatch[1].trim() : 'Could not determine explanation',
          fix: fixMatch ? fixMatch[1].trim() : 'No fix suggested',
          files: filesMatch ? 
            filesMatch[1].trim().split(/[\s,]+/).filter(f => f && f !== '[' && f !== ']') : 
            []
        };
      }
      
      // Stop thinking animation
      stopThinking();
      
      return parsedAnalysis;
    } catch (error) {
      // Stop thinking animation in case of error
      stopThinking();
      console.error(chalk.red(`Error analyzing browser output: ${error.message}`));
      
      return {
        issue: 'Error analyzing browser output',
        explanation: `An error occurred while analyzing the browser output: ${error.message}`,
        fix: 'No fix suggested',
        files: []
      };
    }
  } catch (error) {
    console.error(chalk.red(`Error importing dependencies: ${error.message}`));
    
    return {
      issue: 'Error importing dependencies',
      explanation: `An error occurred while importing dependencies: ${error.message}`,
      fix: 'No fix suggested',
      files: []
    };
  }
}
