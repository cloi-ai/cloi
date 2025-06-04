#!/usr/bin/env node
/**
 * Main CLI Application Entry Point
 * 
 * This is the core entry point for the CLOI application, providing an interactive
 * command-line interface for error analysis and automatic debugging.
 * 
 * The module integrates all other components (LLM, UI, patch application, etc.)
 * to provide a seamless experience for users to analyze and fix errors in their
 * terminal commands and code files. It handles command-line arguments, manages the
 * interactive loop, and coordinates the debugging workflow.
 */

/* ----------------------------------------------------------------------------
 *  CLOI — Secure Agentic Debugger
 *  ----------------------------------------------------------------------------
 */

import chalk from 'chalk';
import boxen from 'boxen';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import fs from 'fs';
import { execSync } from 'child_process';

// Import from our modules
import { 
  BOX, 
  echoCommand, 
  truncateOutput, 
  createCommandBox, 
  askYesNo, 
  getReadline, 
  closeReadline, 
  askInput,
  ensureCleanStdin 
} from '../ui/terminalUI.js';
import { runCommand, ensureDir, writeDebugLog } from '../utils/cliTools.js';
import { readHistory, lastRealCommand, selectHistoryItem } from '../utils/history.js';
import { 
  analyzeWithLLM, 
  determineErrorType, 
  generateTerminalCommandFix, 
  generatePatch, 
  summarizeCodeWithLLM, 
  getInstalledModels as readModels, 
  getAllAvailableModels as getAvailableModels,
  installModelIfNeeded as installModel
} from '../core/index.js';
import { extractDiff, confirmAndApply } from '../utils/patch.js';
import { displaySnippetsFromError, readFileContext, extractFilesFromTraceback, buildErrorContext, getErrorLines } from '../utils/traceback.js';
import { startThinking } from '../core/ui/thinking.js';
// Import prompt builders for debugging
import { buildAnalysisPrompt, buildSummaryPrompt } from '../core/promptTemplates/analyze.js';
import { buildErrorTypePrompt } from '../core/promptTemplates/classify.js';
import { buildCommandFixPrompt } from '../core/promptTemplates/command.js';
import { buildPatchPrompt } from '../core/promptTemplates/patch.js';

// Import model configuration utilities
import { getDefaultModel } from '../utils/modelConfig.js';

// Get directory references
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/* ───────────────────────── Interactive Loop ────────────────────────────── */
/**
 * Runs the main interactive loop of the FigAI CLI.
 * Presents a prompt allowing the user to execute commands like /analyze, /debug, /history, /model.
 * Manages the state (last command, current model) between interactions.
 * @param {string|null} initialCmd - The initial command to have ready for analysis/debugging.
 * @param {number} limit - The history limit to use for /history selection.
 * @param {string} initialModel - The model to use.
 */
async function interactiveLoop(initialCmd, limit, initialModel) {
    let lastCmd = initialCmd;
    let currentModel = initialModel;
    let userContext = ''; // Store user's context/request
  
    while (true) {
      closeReadline(); // Ensure clean state before each iteration
      console.log(boxen(
        `${chalk.gray('Describe what you want to do, or use commands:')} (${chalk.blue('/debug')}, ${chalk.blue('/model')}, ${chalk.blue('/help')})`,
        BOX.PROMPT
      ));
      // Add improved gray text below the boxen prompt for exit instructions and /debug info
      console.log(chalk.gray('  Describe your goal or use /debug to analyze and auto-fix the last command. Press ctrl+c to exit.'));
  
      const input = await new Promise(r => {
        const rl = getReadline();
        rl.question('> ', t => {
          closeReadline(); // Clean up after getting input
          r(t.trim());
        });
      });

      // Check if input is a command or user context
      const isCommand = input.toLowerCase().startsWith('/');
      
      if (!isCommand && input) {
        // Store user context and automatically trigger debug
        userContext = input;
        console.log(boxen(`User context: ${userContext}`, { ...BOX.OUTPUT, title: 'Context Set' }));
        process.stdout.write('\n');
        await debugLoop(lastCmd, limit, currentModel, userContext);
        process.stdout.write('\n');
        continue;
      }

      const command = input.toLowerCase();
  
      switch (command) {
        case '/debug': {
          process.stdout.write('\n');
          await debugLoop(lastCmd, limit, currentModel, userContext);
          process.stdout.write('\n');
          break;
        }
  
        case '/history': {
          const sel = await selectHistoryItem(limit);
          if (sel) {
            lastCmd = sel;
            console.log(boxen(`Selected command: ${lastCmd}`, { ...BOX.OUTPUT, title: 'History Selection' }));
          }
          process.stdout.write('\n');
          break;
        }
  
        case '/model': {
          const newModel = await selectModelFromList();
          if (newModel) {
            currentModel = newModel;
            process.stdout.write('\n');
            
            const { setDefaultModel } = await import('../utils/modelConfig.js');
            const saveResult = await setDefaultModel(newModel);
            
            if (saveResult) {
              console.log(boxen(`Model ${currentModel} is now set as default`, { ...BOX.OUTPUT, title: 'Success' }));
            } else {
              console.log(boxen(`Using model: ${currentModel} for this session only`, BOX.PROMPT));
              console.log(chalk.yellow('Failed to save as default model'));
            }
          }
          break;
        }
        
        case '/help':
          console.log(boxen(
            [
              '/debug    – auto-patch errors using chosen LLM',
              '/model    – pick from installed Ollama models',
              // '/history  – pick from recent shell commands', // Hidden from help
              '/help     – show this help',
              // '/exit     – quit' // Remove from help
            ].join('\n'),
            BOX.PROMPT
          ));
          break;
  
        case '':
          break;

        default:
          console.log(chalk.red('Unknown command. Type'), chalk.bold('/help'));
      }
    }
  }

/* ───────────────  Debug loop  ─────────────── */
/**
 * Main debugging loop that analyzes errors and fixes them.
 * 1. Runs the current command (`cmd`).
 * 2. If successful, breaks the loop.
 * 3. If error, analyzes the error (`analyzeWithLLM`).
 * 4. Determines error type (`determineErrorType`).
 * 5. If Terminal Issue: generates a new command (`generateTerminalCommandFix`), confirms with user, updates `cmd`.
 * 6. If Code Issue: generates a patch (`generatePatch`), confirms and applies (`confirmAndApply`).
 * 7. Logs the iteration details (`writeDebugLog`).
 * Continues until the command succeeds or the user cancels.
 * @param {string} initialCmd - The command to start debugging.
 * @param {number} limit - History limit (passed down from interactive loop/args).
 * @param {string} currentModel - The Ollama model to use.
 * @param {string} userContext - The user's context/request for debugging.
 */
async function debugLoop(initialCmd, limit, currentModel, userContext = '') {
    const iterations = [];
    const ts = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 15);
    const logDir = join(__dirname, 'debug_history');
    await ensureDir(logDir);
    const logPath = join(logDir, `${ts}.txt`);
  
    // Get current working directory for context
    console.log(chalk.gray('  Locating current working directory...'));
    echoCommand('pwd');
    const { output: currentDir } = runCommand('pwd');
    
    // Initialize file content and summary variables outside try-catch scope
    let fileContentRaw = '';
    let fileContentWithLineNumbers = '';
    let codeSummary = '';
    let filePath = '';
    let isValidSourceFile = false; // Track if we have a valid source file
    // Initialize fileInfo with default values
    let fileInfo = null;
    
    // First, try to extract recent errors from terminal logs
  let cmd = initialCmd;
  console.log(chalk.gray('  Running command...\n'));
  
  // Run the command
  echoCommand(cmd);
  const { ok, output } = runCommand(cmd);
  
  if (ok && !/error/i.test(output)) {
    console.log(boxen(chalk.green('No errors detected.'), { ...BOX.OUTPUT, title: 'Success' }));
    return;
  }
    
    // Extract possible file paths from the command or error logs
      try {
    // Extract possible filename from commands like "python file.py", "node script.js", etc.
    let possibleFile = initialCmd;
    
    // Common command prefixes to check for
    const commandPrefixes = ['python', 'python3', 'node', 'ruby', 'perl', 'php', 'java', 'javac', 'bash', 'sh'];
    
    // Check if the command starts with any of the common prefixes
    for (const prefix of commandPrefixes) {
      if (initialCmd.startsWith(prefix + ' ')) {
        // Extract everything after the prefix and a space
        possibleFile = initialCmd.substring(prefix.length + 1).trim();
        break;
      }
    }
    
    // Further extract arguments if present (get first word that doesn't start with -)
    possibleFile = possibleFile.split(' ').find(part => part && !part.startsWith('-')) || '';
    
    // First check relative path
    filePath = possibleFile;
    isValidSourceFile = filePath && fs.existsSync(filePath) && fs.statSync(filePath).isFile();
    
    // If not a file, try as absolute path
    if (!isValidSourceFile && filePath && !filePath.startsWith('/')) {
      filePath = join(currentDir.trim(), filePath);
      isValidSourceFile = fs.existsSync(filePath) && fs.statSync(filePath).isFile();
    }
    
    // Check if we need additional context from the file
          // We'll read file content only if:
      // 1. It's a valid file AND
      // 2. There are NO clear error lines in the traceback
      const filesWithErrors = extractFilesFromTraceback(output);
      const hasErrorLineInfo = filesWithErrors.size > 0;
      
      if (isValidSourceFile && !hasErrorLineInfo) {
        console.log(chalk.gray(`  Analyzing file content...`));
        // Show the sed command that will be used
        const start = 1; // Since we want first 200 lines, starting from line 1
        const end = 200; // Read first 200 lines
        const sedCmd = `sed -n '${start},${end}p' ${filePath}`;
        echoCommand(sedCmd);
        
        // Use readFileContext to get the first 200 lines (using line 100 as center with ctx=100)
        const fileContentInfo = readFileContext(filePath, 100, 100);
        fileContentRaw = fileContentInfo.content;
        
        // Create a version with line numbers for analysis
        fileContentWithLineNumbers = fileContentRaw.split('\n')
          .map((line, index) => `${fileContentInfo.start + index}: ${line}`)
          .join('\n');
        
        // Create file info object with content and line range
        fileInfo = {
          content: fileContentRaw,
          withLineNumbers: fileContentWithLineNumbers,
          start: fileContentInfo.start,
          end: fileContentInfo.end,
          path: filePath
        };
        
        // Summarize code without displaying the prompt
        
        // Summarize the content - use the version with line numbers for better context
        codeSummary = await summarizeCodeWithLLM(fileContentWithLineNumbers, currentModel);
        // Display summary as indented gray text instead of boxen
        console.log('\n' +'  ' + chalk.gray(codeSummary) + '\n');
      }
    } catch (error) {
      console.log(chalk.yellow(`  Note: Could not analyze file content: ${error.message}`));
    }
  
    // Display snippets from error traceback
    if (!ok || /error/i.test(output)) {
      displaySnippetsFromError(output);
    }
    
    /* eslint-disable no-await-in-loop */
    while (true) {
      // First, run analysis like /analyze would do, but pass additional context
      // Build the analysis prompt but don't display it
      
      const { analysis, reasoning: analysisReasoning, wasStreamed } = await analyzeWithLLM(
        output, 
        currentModel, 
        fileInfo || { 
          content: fileContentRaw, 
          withLineNumbers: fileContentWithLineNumbers, 
          start: 1, 
          end: fileContentRaw.split('\n').length, 
          path: filePath 
        },
        codeSummary, 
        filePath,
        'error_analysis',
        userContext
      );
      
      // Display reasoning if available
      if (analysisReasoning) {
        console.log(boxen(analysisReasoning, { ...BOX.OUTPUT_DARK, title: 'Reasoning' }));
      }
      
      // Only display analysis if it wasn't already streamed
      if (!wasStreamed) {
        console.log('\n' +'  ' + chalk.gray(analysis.replace(/\n/g, '\n  ')) + '\n');
      }
      
      // Determine if this is a terminal command issue using LLM
      // Determine error type without displaying the prompt
      
      const errorType = await determineErrorType(output, analysis, currentModel, userContext);
      // Display error type as indented gray text
      console.log('  ' + chalk.gray(errorType) + '\n');
      
      if (errorType === "TERMINAL_COMMAND_ERROR") {
        // Generate a new command to fix the issue
        const prevCommands = iterations.map(i => i.patch).filter(Boolean);
        
        // Generate command fix without displaying the prompt
        
        const { command: newCommand, reasoning: cmdReasoning } = await generateTerminalCommandFix(prevCommands, analysis, currentModel, userContext);
        
        // Display command reasoning if available
        if (cmdReasoning) {
          console.log(boxen(cmdReasoning, { ...BOX.OUTPUT_DARK, title: 'Command Reasoning' }));
        }
        // Show the proposed command
        console.log(boxen(newCommand, { ...BOX.OUTPUT, title: 'Proposed Command' }));
        
        // Ask for confirmation
        if (!(await askYesNo('Run this command?'))) {
          console.log(chalk.yellow('\nDebug loop aborted by user.'));
          break;
        }
        
        // Update the command for the next iteration
        cmd = newCommand;
        iterations.push({ error: output, patch: newCommand, analysis: analysis });
      } else {
        // Original code file patching logic
        const prevPatches = iterations.map(i => i.patch);
        
        // Extract file paths and line numbers from the traceback
        const filesWithErrors = extractFilesFromTraceback(output);
        const errorFiles = Array.from(filesWithErrors.keys()).join('\n');
        const errorLines = Array.from(filesWithErrors.values()).join('\n');
        
        // Get the exact lines of code where errors occur
        const exactErrorCode = getErrorLines(output);
        
        // Get the code context with reduced context size (±3 lines)
        const context = buildErrorContext(output, 3, false);
        
        // Generate patch without displaying the prompt
        
        const { diff: rawDiff, reasoning: patchReasoning } = await generatePatch(
          output,
          prevPatches,
          analysis,
          currentDir.trim(),
          currentModel,
          fileInfo || { 
            content: fileContentRaw, 
            withLineNumbers: fileContentWithLineNumbers, 
            start: 1, 
            end: fileContentRaw ? fileContentRaw.split('\n').length : 0, 
            path: filePath 
          },
          codeSummary,
          userContext
        );
        
        // Display patch reasoning if available
        if (patchReasoning) {
          console.log(boxen(patchReasoning, { ...BOX.OUTPUT_DARK, title: 'Patch Reasoning' }));
        }
                
        // Just extract the diff without displaying it
        const cleanDiff = extractDiff(rawDiff);
        
        // Check if we have a valid diff
        const isValidDiff = 
          // Standard unified diff format
          (cleanDiff.includes('---') && cleanDiff.includes('+++')) || 
          // Path with @@ hunks and -/+ changes
          (cleanDiff.includes('@@') && cleanDiff.includes('-') && cleanDiff.includes('+')) ||
          // File path and -/+ lines without @@ marker (simpler format)
          (cleanDiff.includes('/') && cleanDiff.includes('-') && cleanDiff.includes('+'));
        
        if (!isValidDiff) {
          console.error(chalk.red('LLM did not return a valid diff. Aborting debug loop.'));
          break;
        }
  
        const applied = await confirmAndApply(cleanDiff, currentDir.trim());
        
        if (!applied) {
          console.log(chalk.yellow('Debug loop aborted by user.'));
          break;
        }
  
        iterations.push({ error: output, patch: cleanDiff, analysis: analysis });
        
        // Write the debug log
        await writeDebugLog(iterations, logPath);
        console.log(chalk.gray(`Debug session saved to ${logPath}`));
        
        // Exit the loop after applying the patch instead of running the command again
        console.log(chalk.green('Patch applied. Returning to main loop.'));
        break;
      }
      
      await writeDebugLog(iterations, logPath);
      console.log(chalk.gray(`Debug session saved to ${logPath}`));
    }
  }
  

/* ───────────────────────────────  Main  ──────────────────────────────── */

/**
 * Main entry point for the Cloi CLI application.
 * Parses command line arguments using yargs, displays a banner,
 * and routes execution based on the provided flags (`--analyze`, `--debug`, `--history`, `model`).
 * Handles fetching the last command and initiating the appropriate loop (interactive or debug).
 */
(async function main() {
    const argv = yargs(hideBin(process.argv))
      .option('model', {
        alias: 'm',
        describe: 'Ollama model to use for completions',
        default: null,
        type: 'string'
      })
      .help().alias('help', '?')
      .epilog('CLOI - Open source and completely local debugging agent.')
      .parse();
  
    // Load default model from config or use command line argument if provided
    let currentModel;
    
    try {
      // First try to get the user's saved default model
      const savedModel = await getDefaultModel();
      
      // If command-line argument is provided, it overrides the saved default
      currentModel = argv.model || savedModel;
    } catch (error) {
      console.error(chalk.yellow(`Error loading default model: ${error.message}`));
      currentModel = 'phi4:latest';
    }
    
    
    
    if (currentModel) {
      const isOnline = checkNetwork();
      const installedModels = await readModels();
      
      if (!installedModels.includes(currentModel)) {
        console.log(boxen(
          `Model ${currentModel} is not installed. Install now?\nThis may take a few minutes.\n\nProceed (y/N):`,
          { ...BOX.CONFIRM, title: 'Model Installation' }
        ));
        
        const response = await askYesNo('', true);
        console.log(response ? 'y' : 'N');
        
        if (response) {
          console.log(chalk.blue(`Installing ${currentModel}...`));
          const success = await installModel(currentModel);
          
          if (!success) {
            console.log(chalk.yellow(`Failed to install ${currentModel}. Using default model instead.`));
            currentModel = 'phi4:latest';
          } else {
            console.log(chalk.green(`Successfully installed ${currentModel}.`));
          }
        } else {
          console.log(chalk.yellow(`Using default model instead.`));
          currentModel = 'phi4:latest';
        }
      }
    }
    
    const banner = chalk.blueBright.bold('Cloi') + ' — secure agentic debugging tool';
    console.log(boxen(
      `${banner}\n↳ model: ${currentModel}\n↳ completely local and secure`,
      BOX.WELCOME
    ));
  
    const lastCmd = await lastRealCommand();
    if (!lastCmd) {
      console.log(chalk.yellow('No commands found in history.'));
      return;
    }

    console.log(boxen(lastCmd, { ...BOX.WELCOME, title: 'Last Command'}));
    await interactiveLoop(lastCmd, 15, currentModel);
  })().catch(err => {
    console.error(chalk.red(`Fatal: ${err.message}`));
    process.exit(1);
  });

/* ───────────────────────── Model Selection ────────────────────────────── */
/**
 * Allows the user to select a model using an interactive picker.
 * @returns {Promise<string|null>} - Selected model or null if canceled
 */
export async function selectModelFromList() {
  const { makePicker } = await import('../ui/terminalUI.js');
  
  try {
    // Get all installed models first
    const installedModels = await readModels();
    
    // Check for online connectivity to show additional models
    const isOnline = checkNetwork();
    let allModels = [...installedModels]; // Start with installed models
    let popularModels = [];
    
    if (isOnline) {
      // Get popular models from the static list
      popularModels = getAvailableModels();
      
      // Add popular models that aren't already installed
      for (const model of popularModels) {
        if (!installedModels.includes(model)) {
          allModels.push(model);
        }
      }
    }
    
    if (allModels.length === 0) {
      console.log(boxen(
        chalk.yellow('No Ollama models found. Please install Ollama and at least one model.'),
        { ...BOX.OUTPUT, title: 'Error' }
      ));
      return null;
    }
    
    // Create display-friendly versions with installation status
    const displayNames = allModels.map(model => {
      const isInstalled = installedModels.includes(model);
      const displayName = model.replace(/:latest$/, '');
      const displayStatus = isInstalled ? 
        chalk.green(' ✓ (installed)') : 
        chalk.gray(' - (available to install)');
      
      return `${displayName}${displayStatus}`;
    });
    
    // Create pairs with install status for sorting
    const modelPairs = displayNames.map((display, i) => {
      const isInstalled = installedModels.includes(allModels[i]);
      return [display, allModels[i], isInstalled];
    });
    
    // Sort: installed models first, then alphabetically
    modelPairs.sort((a, b) => {
      if (a[2] !== b[2]) return b[2] - a[2]; // Installed models first
      return a[0].localeCompare(b[0]); // Then alphabetically
    });
    
    // Extract sorted display names and original models
    const sortedDisplayNames = modelPairs.map(pair => pair[0]);
    const sortedModels = modelPairs.map(pair => pair[1]);
    
    // Create picker with sorted display names
    const picker = makePicker(sortedDisplayNames, 'Select Model');
    const selected = await picker();
    
    if (!selected) return null;
    
    // Map back to the original model name
    const selectedModel = sortedModels[sortedDisplayNames.indexOf(selected)];
    
    const isInstalled = installedModels.includes(selectedModel);
    
    if (!isInstalled) {
      console.log(boxen(
        `Install ${selectedModel}?\nThis may take a few minutes.\n\nProceed (y/N):`,
        { ...BOX.CONFIRM, title: 'Confirm Installation' }
      ));
      const response = await askYesNo('', true);
      console.log(response ? 'y' : 'N');
      if (response) {
        const success = await installModel(selectedModel);
        if (!success) return null;
      } else {
        return null;
      }
    }
    
    return selectedModel;
  } catch (error) {
    console.error(chalk.red(`Error selecting model: ${error.message}`));
    return null;
  }
}

/**
 * Checks if network is available by checking if DNS resolution works
 * @returns {boolean} - True if network is available
 */
function checkNetwork() {
  try {
    execSync('ping -c 1 -W 1 1.1.1.1 > /dev/null 2>&1', { stdio: 'ignore' });
    return true;
  } catch (error) {
    return false;
  }
}

// askInput is already imported from terminalUI.js at the top of the file