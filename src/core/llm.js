/**
 * LLM Integration and Error Analysis Module
 * 
 * Manages interactions with Ollama language models for error analysis and code fixes.
 * This module handles model selection, installation, error classification, and
 * generation of solutions (both terminal commands and code patches). It includes
 * UI feedback elements like progress indicators and thinking animations to enhance
 * the user experience during potentially lengthy LLM operations.
 */

import { execSync, spawn } from 'child_process';
import { makePicker } from '../ui/prompt.js';
import { askYesNo, closeReadline, getReadline } from '../ui/prompt.js';
import { checkNetwork } from './command.js';
import chalk from 'chalk';
import { buildErrorContext, extractFilesFromTraceback, getErrorLines } from './traceback.js';
import { BOX } from '../ui/boxen.js';
import boxen from 'boxen';
import ollama from 'ollama'
import { runLLMWithTempScript } from '../utils/tempscript.js';
import { promises as fs } from 'fs';

import { cpus } from 'os';
import { convertToUnifiedDiff, extractDiff } from './patch.js';

/* ───────────────────────── Available Models Provider ────────────────────────────── */
/**
 * Returns a static list of recommended Ollama models for use with FigAI.
 * @returns {string[]} - Array of model names (e.g., 'phi4:latest').
 */
export function getAvailableModels() {
    return [
      'llama3.1:8b',
      'gemma3:4b',
      'gemma3:12b',
      'gemma3:27b',
      'qwen3:8b',
      'qwen3:14b',
      'qwen3:30b',
      'phi4:14b',
      'phi4-reasoning:plus',
      'phi4-reasoning:14b'
    ];
  }
  
/* ───────────────────────── Installed Models Reader ────────────────────────────── */
/**
 * Reads the list of currently installed Ollama models using `ollama list`.
 * @returns {string[]} - An array of installed model names, or empty array on error.
 */
export function readModels() {
  try {
    const output = execSync('ollama list', { encoding: 'utf8' });
    
    // Log the raw output for debugging
    //console.log(chalk.gray('Detected installed models:'));
    //console.log(chalk.gray(output));
    
    const models = output
      .split(/\r?\n/)
      .slice(1)                         // drop header line: NAME   SIZE
      .filter(Boolean)
      .map(l => l.split(/\s+/)[0]);    // first token is the model name
    
    //console.log(chalk.gray('Detected installed models:'), models);
    return models;
  } catch (error) {
    console.error(chalk.red('Error reading models:'), error.message);
    return [];
  }
}

/* ───────────────────────── Interactive Model Selector ────────────────────────────── */
/**
 * Allows the user to select an Ollama model using the interactive picker.
 * Shows available models if online, or only installed models if offline.
 * Marks installed models visually and prompts for installation if an uninstalled model is chosen.
 * @returns {Promise<string|null>} - The selected model name, or null if cancelled or installation failed.
 */
export async function selectModelItem() {
    const isOnline = checkNetwork();
    let models;
    let title;
  
    if (isOnline) {
      models = getAvailableModels();
      title = 'Available Models';
      // Get installed models to check status
      const installedModels = readModels();
      
      // To ensure we don't miss any models, create a combined list
      const allModels = [...new Set([...models, ...installedModels])];
      
      // Create display-friendly versions with installation status
      const displayNames = allModels.map(model => {
        const isInstalled = installedModels.includes(model);
        const displayName = model.replace(/:latest$/, '');
        return `${displayName} ${isInstalled ? chalk.green('✓') : chalk.gray('-')}`;
      });
      
      // Create pairs with install status for sorting (installed first, then alphabetical)
      const modelPairs = displayNames.map((display, i) => {
        const isInstalled = installedModels.includes(allModels[i]);
        return [display, allModels[i], isInstalled];
      });
      
      // Sort installed models first, then alphabetically
      modelPairs.sort((a, b) => {
        // First sort by installation status
        if (a[2] && !b[2]) return -1;
        if (!a[2] && b[2]) return 1;
        // Then sort alphabetically
        return a[0].localeCompare(b[0]);
      });
      
      // Extract sorted display names and original models
      const sortedDisplayNames = modelPairs.map(pair => pair[0]);
      const sortedModels = modelPairs.map(pair => pair[1]);
      
      // Create picker with sorted display names
      const picker = makePicker(sortedDisplayNames, title);
      const selected = await picker();
      
      if (!selected) return null;
      
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
    } else {
      models = readModels();
      title = 'Installed Models';
      
      // Create display-friendly versions of model names (strip ":latest" suffix)
      const displayNames = models.map(model => model.replace(/:latest$/, ''));
      
      // Create sorted pairs of [displayName, originalModel] for sorting and maintaining mapping
      const modelPairs = displayNames.map((display, i) => [display, models[i]]);
      modelPairs.sort((a, b) => a[0].localeCompare(b[0]));
      
      // Extract sorted display names and original models
      const sortedDisplayNames = modelPairs.map(pair => pair[0]);
      const sortedModels = modelPairs.map(pair => pair[1]);
      
      // Create picker with sorted display names
      const picker = makePicker(sortedDisplayNames, title);
      const selected = await picker();
      // Map back to the original model name if something was selected
      return selected ? sortedModels[sortedDisplayNames.indexOf(selected)] : null;
    }
  }

/* ───────────────────────── Model Installation Handler ────────────────────────────── */
/**
 * Installs an Ollama model using `ollama pull`, displaying progress.
 * @param {string} modelName - The name of the model to install (e.g., 'phi4:latest').
 * @returns {Promise<boolean>} - True if installation succeeded, false otherwise.
 */
export async function installModel(modelName) {
    const downloader = startDownloading(modelName);
    try {
      const child = spawn('ollama', ['pull', modelName]);
      
      child.stdout.on('data', (data) => {
        const output = data.toString();
        // Extract progress information from Ollama's output
        const progressMatch = output.match(/(\d+%)/);
        if (progressMatch) {
          downloader.updateProgress(chalk.blue(progressMatch[0]));
        }
      });
  
      child.stderr.on('data', (data) => {
        const output = data.toString();
        // Extract progress information from Ollama's error output
        const progressMatch = output.match(/(\d+%)/);
        if (progressMatch) {
          downloader.updateProgress(chalk.blue(progressMatch[0]));
        }
      });
  
      return new Promise((resolve) => {
        child.on('close', (code) => {
          downloader.stop();
          resolve(code === 0);
        });
      });
    } catch (error) {
      downloader.stop();
      console.error(chalk.red(`Failed to install model ${modelName}: ${error.message}`));
      return false;
    }
  }

/* ───────────────────────── Model Uninstallation Handler ────────────────────────────── */
/**
 * Uninstalls a specified Ollama model after confirmation.
 * @param {string} modelName - The name of the model to remove.
 */
export async function uninstallModel(modelName) {
    try {
      console.log(boxen(
        `Uninstall ${modelName}?\nThis will remove the model from your system.\n\nProceed (y/N):`,
        { ...BOX.CONFIRM, title: 'Confirm Uninstallation' }
      ));
      const response = await askYesNo('', true);
      
      if (response) {
        execSync(`ollama rm ${modelName}`, { stdio: 'ignore' });
        process.stdout.write('\n');
        console.log(chalk.green(`Model ${modelName} has been uninstalled.`));
      }
      // Reset terminal state and readline
      // process.stdout.write('\n');
      closeReadline();
      // Don't directly modify rl here
      getReadline();
    } catch (error) {
      process.stdout.write('\n');
      console.error(chalk.red(`Failed to uninstall model ${modelName}: ${error.message}`));
      // Reset terminal state and readline
      process.stdout.write('\n');
      closeReadline();
      // Don't directly modify rl here
      getReadline();
    }
  }

/* ────────────────────────── Thinking Animation ─────────────────────────── */

/**
 * Starts and manages a terminal spinner animation with changing text phrases.
 * Indicates that a potentially long-running operation (like LLM interaction) is in progress.
 * @param {string[]} [customPhrases] - Optional custom phrases to display during thinking
 * @returns {function(): void} - A function to stop the animation and clear the line.
 */
export function startThinking(customPhrases) {
  const defaultPhrases = [
    'Brewing ideas','Cooking up something','Putting it together',
    'Low-key figuring it out','Thoughts are thoughting',
    'Prompt engineering in progress','Summoning tokens',
    'Reasoning like a transformer','Tokens are tokening',
    'Forking the universe','Ctrl+C won\'t help here'
  ];
  
  const phrases = customPhrases || defaultPhrases.sort(() => Math.random() - 0.5);
  let seconds = 0;
  let spinnerFrame = 0;
  let currentPhrase = phrases[0];
  const spinner = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
  const startTime = Date.now();
  
  const updateDisplay = () => {
    process.stdout.clearLine(0);
    process.stdout.cursorTo(0);
    process.stdout.write(`${spinner[spinnerFrame]} ${currentPhrase} (${seconds}s)`);
  };

  // Spinner animation
  const spinnerInterval = setInterval(() => {
    spinnerFrame = (spinnerFrame + 1) % spinner.length;
    updateDisplay();
  }, 80);

  const tick = () => {
    currentPhrase = phrases[Math.floor(seconds / 10) % phrases.length];
    seconds++;
    updateDisplay();
  };
  tick();
  const id = setInterval(tick, 1000);
  return () => {
    clearInterval(id);
    clearInterval(spinnerInterval);
    process.stdout.write('\n');
  };
}

/**
 * Returns thinking phrases specifically for error analysis
 * @returns {string[]} - Array of thinking phrases for analysis
 */
export function getThinkingPhrasesForAnalysis() {
  return [
    'Parsing the error, line by line...',
    'Locating the point of failure...',
    'Trying to make sense of the red text...',
    'This terminal error looks familiar...',
    'Analyzing what went wrong, precisely...',
    'Diagnosing the issue like a seasoned dev...',
    'Unraveling the terminal\'s last cry...',
    'Let\'s see why the shell screamed this time...'
  ].sort(() => Math.random() - 0.5);
}

/**
 * Returns thinking phrases specifically for patch generation
 * @returns {string[]} - Array of thinking phrases for patch generation
 */
export function getThinkingPhrasesForPatch() {
  return [
    'Locating the offending lines...',
    'Composing a surgical code fix...',
    'Patching with precision...',
    'Rewriting history, one `+` at a time...',
    'Turning errors into green text...',
    'Looking for the cleanest possible fix...',
    'Coding like it\'s commit time...',
    'Preparing a fix you can actually `git apply`...',
  ].sort(() => Math.random() - 0.5);
}

/**
 * Returns thinking phrases specifically for code summarization
 * @returns {string[]} - Array of thinking phrases for code summarization
 */
export function getThinkingPhrasesForSummarization() {
  return [
    'Reading the codebase...',
    'Parsing code structures...',
    'Understanding the logic flow...',
    'Extracting core concepts...',
    'Identifying key components...',
    'Mapping functions and relationships...',
    'Distilling essential patterns...',
    'Compressing code into concepts...',
    'Finding the signal in the syntax...',
    'Translating code to human language...'
  ].sort(() => Math.random() - 0.5);
}

/* ────────────────────────── Download Progress Indicator ─────────────────────────── */
/**
 * Starts and manages a terminal spinner animation specifically for model downloads.
 * Includes updating progress text based on Ollama output.
 * @param {string} modelName - The name of the model being downloaded.
 * @returns {{stop: function(): void, updateProgress: function(string): void}} - An object with
 * functions to stop the animation and update the displayed progress percentage.
 */
export function startDownloading(modelName) {
  // let seconds = 0;
  let spinnerFrame = 0;
  let progress = '';
  const spinner = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
  const startTime = Date.now();
  
  const updateDisplay = () => {
    process.stdout.clearLine(0);
    process.stdout.cursorTo(0);
    process.stdout.write(`${spinner[spinnerFrame]} Installing ${modelName}… ${progress}`);
  };

  // Spinner animation
  const spinnerInterval = setInterval(() => {
    spinnerFrame = (spinnerFrame + 1) % spinner.length;
    updateDisplay();
  }, 80);

  const tick = () => {
    // seconds++;
    updateDisplay();
  };
  tick();
  const id = setInterval(tick, 1000);
  return {
    stop: () => {
      clearInterval(id);
      clearInterval(spinnerInterval);
      const totalTime = ((Date.now() - startTime) / 1000).toFixed(1);
      // process.stdout.write(`\n  Model ${modelName} installed in ${totalTime}s\n`);
    },
    updateProgress: (newProgress) => {
      progress = newProgress;
      updateDisplay();
    }
  };
}

/* ────────────────────────── Error Analysis With LLM ─────────────────────────── */
/**
 * Analyzes error output with an LLM using a Python script with optimized settings.
 * @param {string} errorOutput - The error output to analyze.
 * @param {string} [model='phi4:latest'] - The Ollama model to use.
 * @param {string} [fileContent=''] - Optional file content for additional context.
 * @param {string} [codeSummary=''] - Optional code summary for additional context.
 * @returns {Promise<string>} - The analysis text from the LLM.
 */
export async function analyzeWithLLM(errorOutput, model = 'phi4:latest', fileContent = '', codeSummary = '', filePath) {
  // Start thinking spinner to provide visual feedback
  const stopThinking = startThinking(getThinkingPhrasesForAnalysis());
  
  try {
    // Handle missing Ollama or model by ensuring it's there
    try {
      execSync('which ollama', { stdio: 'ignore' });
    } catch {
      stopThinking(); // Stop spinner before exiting
      console.error(chalk.red('Ollama CLI not found. Please install Ollama first.'));
      process.exit(1);
    }
    
    // Ensure the model exists
    const models = await readModels();
    if (!models.includes(model)) {
      console.log(chalk.yellow(`Model ${model} not found. Installing...`));
      if (!(await installModel(model))) {
        stopThinking(); // Stop spinner before exiting
        console.error(chalk.red(`Failed to install ${model}. Please install it manually.`));
        process.exit(1);
      }
    }
    
    // Set up the prompt for analysis with full context (±30 lines)
    const context = buildErrorContext(errorOutput, 30);
    
    // Build the prompt with additional context if provided
    let promptParts = [
      'You are a helpful terminal assistant analysing command errors.',
      '',
      'ERROR OUTPUT:',
      errorOutput,
      '',
      'FILE PATH:',
      filePath,
    ];
    
    // Add code summary if provided
    if (codeSummary) {
      promptParts.push('CODE SUMMARY:');
      promptParts.push(codeSummary);
      promptParts.push('');
    }
    
    // Add file content if provided
    if (fileContent) {
      promptParts.push('FILE CONTENT (First ~200 lines with line numbers):');
      promptParts.push(fileContent);
      promptParts.push('');
    }
    
    // Add traceback context if available
    if (context) {
      promptParts.push('TRACEBACK CONTEXT (±30 lines):');
      promptParts.push(context);
      promptParts.push('');
    }
    
    // Add instructions
    promptParts.push('Your response MUST include these sections:');
    promptParts.push('1. ERROR LOCATION: Specify the file name (example.py) and the exact line number (line 45) where you believe the error is occurring. Nothing else.');
    promptParts.push('2. Explain **VERY** concisely what went wrong.');
    promptParts.push('3. FIX: Propose a concrete solution to fix the error. There might be multiple fixes required for the same error, so put all in one code chunk. Do not move onto another error. No alternatives. Be final with your solution.');
    promptParts.push('');
    promptParts.push('Be precise about the error line number, even if it\'s not explicitly mentioned in the traceback.');
    promptParts.push('No to low explanation only and focused on the root cause and solution. Keep it **VERY** concise.');
    
    const prompt = promptParts.join('\n');

    // Run the analysis using the TempScript approach
    const output = await runLLMWithTempScript(prompt, model, 'error_analysis');
    
    // Stop thinking spinner before returning
    stopThinking();
    
    return output.trim();
  } catch (error) {
    // Make sure we stop the spinner even if there's an error
    stopThinking();
    return `Error during analysis: ${error.message}`;
  }
}

/* ────────────────────────── Code Summarization With LLM ─────────────────────────── */
/**
 * Summarizes code context with an LLM using a Python script with optimized settings.
 * @param {string} codeContent - The code content to summarize.
 * @param {string} [model='phi4:latest'] - The Ollama model to use.
 * @returns {Promise<string>} - The summary text from the LLM.
 */
export async function summarizeCodeWithLLM(codeContent, model = 'phi4:latest') {
  // Start thinking spinner to provide visual feedback
  const stopThinking = startThinking(getThinkingPhrasesForSummarization());
  
  try {
    // Handle missing Ollama or model by ensuring it's there
    try {
      execSync('which ollama', { stdio: 'ignore' });
    } catch {
      stopThinking(); // Stop spinner before exiting
      console.error(chalk.red('Ollama CLI not found. Please install Ollama first.'));
      process.exit(1);
    }
    
    // Ensure the model exists
    const models = await readModels();
    if (!models.includes(model)) {
      console.log(chalk.yellow(`Model ${model} not found. Installing...`));
      if (!(await installModel(model))) {
        stopThinking(); // Stop spinner before exiting
        console.error(chalk.red(`Failed to install ${model}. Please install it manually.`));
        process.exit(1);
      }
    }
    
    const prompt = `
You are a concise code summarization assistant.

CODE:
${codeContent}

Provide an ultra-concise summary of this code in EXACTLY 1-2 lines maximum. Your summary must:
- Describe the main purpose/functionality
- Mention key components or patterns if relevant
- Be immediately useful to a developer skimming the code
- Not exceed 2 lines under any circumstances

Your entire response should be 1-2 lines only. No introductions, explanations, or lists. Make it concise and to the point.
`.trim();

    // Run the summarization using the TempScript approach
    const output = await runLLMWithTempScript(prompt, model, 'error_analysis');
    
    // Stop thinking spinner before returning
    stopThinking();
    
    return output.trim();
  } catch (error) {
    // Make sure we stop the spinner even if there's an error
    stopThinking();
    return `Error during summarization: ${error.message}`;
  }
}

/* ────────────────────────── Terminal Error Pattern Detection ─────────────────────────── */
/**
 * Checks if an error is likely related to a terminal command issue.
 * @param {string} errorOutput - The error output to analyze.
 * @returns {boolean} - True if it seems to be a terminal command issue.
 */
export function isTerminalCommandError(errorOutput) {
  const terminalErrors = [
    /command not found/i,
    /no such file or directory/i,
    /permission denied/i,
    /not installed/i,
    /invalid option/i,
    /unknown option/i,
    /missing argument/i,
    /too many arguments/i,
    /not recognized as an internal or external command/i,
    /is not recognized as a command/i,
  ];
  
  return terminalErrors.some(pattern => pattern.test(errorOutput));
}

/* ────────────────────────── Error Classification ─────────────────────────── */
/**
 * Determines the type of error (terminal command or code issue) using LLM.
 * @param {string} errorOutput - The error output to analyze.
 * @param {string} analysis - Previous analysis of the error.
 * @param {string} model - The model to use.
 * @returns {Promise<string>} - Either "TERMINAL_COMMAND_ERROR" or "CODE_FILE_ISSUE"
 */
export async function determineErrorType(errorOutput, analysis, model) {
  // First do a quick check for obvious terminal errors
  if (isTerminalCommandError(errorOutput)) {
    return "TERMINAL_COMMAND_ERROR";
  }
  
  // Start thinking spinner to provide visual feedback
  const stopThinking = startThinking(getThinkingPhrasesForAnalysis());
  
  try {
    // Use LLM to determine more complex cases
    const prompt = `
You are a binary classifier AI. Your ONLY task is to classify if a fix requires code changes or terminal commands.

ANALYSIS:
${analysis}

INSTRUCTIONS:
1. Look at the Proposed Fix section
2. If the fix requires running a command (like pip install, npm install, etc.), output: TERMINAL_COMMAND_ERROR
3. If the fix requires changing code files, output: CODE_FILE_ISSUE
4. You MUST output ONLY ONE of these exact phrases, and no additional thoughts: "TERMINAL_COMMAND_ERROR" or "CODE_FILE_ISSUE"

Output ONLY ONE of these exact phrases. No need for long explanations. Just a simple single word output:
'TERMINAL_COMMAND_ERROR',
'CODE_FILE_ISSUE'
`.trim();
    
    // Run the analysis using the TempScript approach
    const output = await runLLMWithTempScript(prompt, model, 'error_determination');
    
    // Stop thinking spinner before processing result
    stopThinking();
    
    const cleanOutput = output.trim();
    const isTerminal = cleanOutput.includes('TERMINAL_COMMAND_ERROR');
    
    return isTerminal ? "TERMINAL_COMMAND_ERROR" : "CODE_FILE_ISSUE";
  } catch (error) {
    // Make sure we stop the spinner even if there's an error
    stopThinking();
    return "CODE_FILE_ISSUE"; // Default to code issue if error
  }
}

/* ────────────────────────── Terminal Command Generator ─────────────────────────── */
/**
 * Generates a new terminal command to fix an error using LLM.
 * @param {string[]} prevCommands - Previous attempted fix commands.
 * @param {string} analysis - Previous error analysis.
 * @param {string} model - The model to use.
 * @returns {Promise<string>} - The generated command.
 */
export async function generateTerminalCommandFix(prevCommands, analysis, model) {
  // Start thinking spinner to provide visual feedback
  const stopThinking = startThinking(getThinkingPhrasesForAnalysis());
  
  try {
    // Format previous commands more robustly
    const prevCommandsText = Array.isArray(prevCommands) && prevCommands.length > 0
      ? `\n\nPreviously tried commands:\n${prevCommands.map(cmd => `- ${cmd}`).join('\n')}`
      : '';
    
    const prompt = `
You are a terminal command fixing AI. Given an analysis, extract a new command to fix it.

Error Analysis:
${analysis}

Previous Commands:
${prevCommandsText}

Instructions:
1. Analyze the Proposed Fix section carefully
2. Extract a single command that will fix the issue
3. The command should be complete and ready to run
4. Do not include any explanations, commentary, or markdown formatting
5. Only output the command itself

Example Format:
pip install missing-package

Generate ONLY the command, nothing else. No explanations, no markdown, just the raw command.
Make sure it's valid syntax that can be directly executed in a terminal.
`.trim();
    
    // Run the analysis using the TempScript approach
    const output = await runLLMWithTempScript(prompt, model, 'command_generation');
    
    // Stop thinking spinner before processing result
    stopThinking();
    
    // Clean the output to get just the command
    let command = output.trim();
    
    // Remove markdown code blocks if present
    command = command.replace(/^```[a-z]*\n/, '').replace(/\n```$/, '');
    
    // Remove any leading "Run: " or similar text
    command = command.replace(/^(Run|Execute|Type|Use|Try):\s*/i, '');
    
    // Remove any $ prefix (common in examples)
    command = command.replace(/^\$\s*/, '');
    
    // Ensure we have a valid command
    if (!command || command.startsWith('Error')) {
      throw new Error('Failed to generate a valid command');
    }
    
    return command;
  } catch (error) {
    // Make sure we stop the spinner even if there's an error
    stopThinking();
    return `echo "Error generating command: ${error.message}"`;
  }
}

/* ────────────────────────── Code Patch Generator ─────────────────────────── */
/**
 * Generates a patch to fix code issues using LLM with structured outputs.
 * @param {string} errorOutput - The error output.
 * @param {string[]} prevPatches - Previous attempted patches.
 * @param {string} analysis - Previous error analysis.
 * @param {string} currentDir - The current working directory.
 * @param {string} model - The model to use.
 * @param {string} [fileContent=''] - Optional file content for additional context.
 * @param {string} [codeSummary=''] - Optional code summary for additional context.
 * @returns {Promise<string>} - The generated diff.
 */
export async function generatePatch(errorOutput, prevPatches, analysis, currentDir = process.cwd(), model, fileContent = '', codeSummary = '') {
  // Start thinking spinner to provide visual feedback
  const stopThinking = startThinking(getThinkingPhrasesForPatch());
  
  try {
    const prevPatchesText = prevPatches.length
      ? `\n\nPreviously attempted patches:\n${prevPatches.join('\n\n')}`
      : '';
    
    // Extract file paths and line numbers from the traceback
    const filesWithErrors = extractFilesFromTraceback(errorOutput);
    const errorFiles = Array.from(filesWithErrors.keys()).join('\n');
    const errorLines = Array.from(filesWithErrors.values()).join('\n');
    
    // Get the exact lines of code where errors occur
    const exactErrorCode = getErrorLines(errorOutput);
    
    // Get only the last two lines of the error output
    const errorOutputLines = errorOutput.split('\n');
    const lastTwoLines = errorOutputLines.slice(-2).join('\n');
    
    // Get the code context with reduced context size (±3 lines) for generatePatch
    // Don't include file path and line headers in the context
    const context = buildErrorContext(errorOutput, 3, false);

    const parts = [
      // ───── Intro
      'You are a code-fixing AI. Given an analysis, extract a structured patch to fix it.',
      '',

      // ───── Analysis
      'Error Analysis',
      analysis,
      '',
    
      // ───── Current Directory (for context)
      '### Current Working Directory',
      currentDir,
      '',
    ];
    
    // Add code summary if provided
    if (codeSummary) {
      parts.push('### Code Summary');
      parts.push(codeSummary);
      parts.push('');
    }
    
    // Add file content if provided - use raw content for patch generation to avoid line number issues
    if (fileContent) {
      parts.push('### File Content (First ~200 lines)');
      parts.push(fileContent);
      parts.push('');
    }
    
    // Continue with the rest of the sections
    parts.push(
      // ───── Error Files (separate section)
      '### Error File:',
      errorFiles || '(none)',
      '',
      
      // ───── Error Lines (separate section)
      '### Error Line:',
      errorLines || '(none)',
      '',
      
      // ───── Error Code (exact line with error)
      '### Error Code:',
      exactErrorCode || '(none)',
      '',
    
      // ───── Code Context (with reduced context)
      '### Code Context (±3 lines from error locations)',
      context || '(none)',
      '',
    
      // ───── Previous patches (optional)
      '### Previous Patches',
      prevPatchesText || '(none)',
      '',
    );
    
    // Add structured output instructions
    parts.push(
      // ───── Instructions
      '### Instructions',
      'Analyze the error and generate a structured patch in JSON format with the following schema:',
      '{',
      '  "changes": [',
      '    {',
      '      "file_path": "relative/path/to/file.py",',
      '      "line_number": 42,',
      '      "old_line": "    z = x + yy",',
      '      "new_line": "    z = x + y"',
      '    },',
      '    ...',
      '  ],',
      '  "description": "Fixed typo in variable name and syntax error"',
      '}',
      '',
      '1. Ensure the file_path is relative to: ' + currentDir,
      '2. Include the ENTIRE line for both old_line and new_line',
      '3. For deletions, include old_line but set new_line to null',
      '4. For additions, set line_number of the line that comes before and set old_line to ""',
      '',
      'Make sure to:',
      '1. Only include lines that are actually changed',
      '2. Never modify the same line twice',
      '3. Keep the changes as minimal as possible',
      '4. Maintain the correct order of operations',
      '',
      '### JSON Output'
    );
    
    const prompt = parts.join('\n');
    
    // Define the schema for the patch response
    const patchSchema = {
      type: "object",
      properties: {
        changes: {
          type: "array",
          items: {
            type: "object",
            properties: {
              file_path: { type: "string" },
              line_number: { type: "integer" },
              old_line: { type: "string" },
              new_line: { type: "string", nullable: true }
            },
            required: ["file_path", "line_number", "old_line"]
          }
        },
        description: { type: "string" }
      },
      required: ["changes"]
    };

    let output;
    try {
      // Add diagnostic logs
      //console.log(chalk.gray('Starting Ollama API call with model:', model));
      const cpuThreads = Math.min(8, (cpus()?.length || 2));
      
      // Try using the structured output API if available
      const response = await ollama.chat({
        model: model,
        messages: [{ role: 'user', content: prompt }],
        format: patchSchema,  // Pass the schema to the format parameter
        stream: false,        // Structured outputs don't work with streaming
        options: {            
          // Use the same optimized settings from patch_generation preset
          temperature: 0.1,
          num_predict: 768,
          num_thread: cpuThreads,
          num_batch: 32,
          mmap: true,
          int8: true,
          f16: false,
          repeat_penalty: 1.0,
          top_k: 40,
          top_p: 0.95,
          cache_mode: "all",
          use_mmap: true,
          use_mlock: true
        }
      });
      
      // Log successful response
      
      // The response will automatically be in the schema format
      const structuredPatch = JSON.parse(response.message.content);
      
      console.log(chalk.gray(JSON.stringify(structuredPatch, null, 2)));
      
      // Convert the structured patch to unified diff format
      output = convertToUnifiedDiff(structuredPatch, currentDir);


    } catch (error) {
      // Add detailed error logging
      console.log(chalk.red('Ollama API call error details:'));
      console.log(chalk.red('Error name:', error.name));
      //console.log(chalk.red('Error message:', error.message));
      //console.log(chalk.red('Error stack:', error.stack));
      
      // Fall back to the traditional approach if structured outputs fail
      console.log(chalk.yellow(`Structured format unavailable - reverting to standard text output: ${error.message}`));
      output = await runLLMWithTempScript(prompt, model, 'patch_generation');
    }
    
    // Stop thinking spinner before processing result
    stopThinking();
    
    return output.trim();
  } catch (error) {
    // Make sure we stop the spinner even if there's an error
    stopThinking();
    console.error(chalk.red(`Error generating patch: ${error.message}`));
    return '';
  }
} 
