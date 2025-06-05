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
  installModelIfNeeded as installModel,
  determineNextAgentAction
} from '../core/index.js';
import { extractDiff, confirmAndApply } from '../utils/patch.js';
import { displaySnippetsFromError, readFileContext, extractFilesFromTraceback, buildErrorContext, getErrorLines } from '../utils/traceback.js';
import { startThinking } from '../core/ui/thinking.js';
// Import agentic system components
import { executeAgentTool } from '../core/agent_tools.js';
import { 
  createInitialAgentContext, 
  updateAgentContext, 
  createSessionSummary,
  shouldTerminateSession,
  updateErrorState
} from '../core/agent_prompt.js';
// Import prompt builders for debugging (kept for legacy support)
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

/* ───────────────  Agentic Debug loop  ─────────────── */
/**
 * Agentic debugging loop that uses an LLM agent to iteratively diagnose and fix issues.
 * The agent chooses tools and actions based on the current context and progresses
 * autonomously until the issue is resolved or cannot be fixed.
 * @param {string} initialCmd - The command that triggered the debugging session.
 * @param {number} limit - History limit (for legacy compatibility).
 * @param {string} currentModel - The Ollama model to use for the agent.
 * @param {string} userContext - The user's context/request for debugging.
 */
async function debugLoop(initialCmd, limit, currentModel, userContext = '') {
  try {
    // Get current working directory
    console.log(chalk.gray('  Starting agentic debugging session...'));
    const currentDir = process.cwd();
    
    // Run the initial command to get error details
    console.log(chalk.gray('  Running initial command...'));
    echoCommand(initialCmd);
    const { ok, output } = runCommand(initialCmd);
    
    // Check if command succeeded
    if (ok && !/error/i.test(output)) {
      console.log(boxen(chalk.green('No errors detected.'), { ...BOX.OUTPUT, title: 'Success' }));
      return;
    }
    
    // Create initial agent context
    const commandDetails = {
      command_string: initialCmd,  // Fixed: was 'command', should be 'command_string'
      stdout: ok ? output : '',
      stderr: ok ? '' : output,
      exit_code: ok ? 0 : 1
    };
    
    let agentContext = createInitialAgentContext(
      userContext,
      commandDetails, 
      currentDir
    );
    
    // NEW: Set initial error state from the command output
    if (!ok && output) {
      agentContext = updateErrorState(agentContext, output, 0);
    }
    
    // Note: Removed premature file reading - let the agent decide what to investigate
    
    console.log(boxen(
      `Agent initialized with ${agentContext.available_tools.length} tools available`,
      { ...BOX.OUTPUT, title: 'Agentic Debugging Started' }
    ));
    
    let stepCount = 0;
    const maxSteps = 20;
    
    // Main agentic loop
    while (stepCount < maxSteps) {
      stepCount++;
      
      // Check if we should terminate the session
      const terminationCheck = shouldTerminateSession(agentContext);
      if (terminationCheck.should_terminate) {
        console.log(boxen(
          `Session terminated: ${terminationCheck.reason}`,
          { ...BOX.OUTPUT, title: 'Session Ended' }
        ));
        break;
      }
      
      console.log(chalk.blue(`\n--- Agent Step ${stepCount} ---`));
      
      try {
        // NEW: Show progress visualization if not first step
        if (stepCount > 1) {
          const progressStatus = getProgressStatus(agentContext);
          console.log(chalk.blue(`Progress: ${progressStatus}`));
        }
        
        // Let the agent determine the next action
        const agentAction = await determineNextAgentAction(agentContext, currentModel);
        
        // Calculate context usage
        const { buildAgentPrompt } = await import('../core/agent_prompt.js');
        const currentPrompt = buildAgentPrompt(agentContext);
        const estimatedTokens = Math.ceil(currentPrompt.length / 4); // Rough estimate: 4 chars = 1 token
        const maxTokens = 8000; // Model context limit
        const remainingTokens = maxTokens - estimatedTokens;
        const contextUsage = Math.round((estimatedTokens / maxTokens) * 100);
        
        // Display agent's thought process with context info
        console.log(boxen(
          `Tool: ${chalk.bold(agentAction.tool_to_use)}\nThought: ${agentAction.thought}\n\n` +
          `${chalk.gray(`Context: ${estimatedTokens}/${maxTokens} tokens (${contextUsage}%) | ${remainingTokens} remaining`)}`,
          { ...BOX.OUTPUT_DARK, title: 'Agent Decision' }
        ));
        
        // Execute the chosen tool
        const toolResult = await executeAgentTool(
          agentAction.tool_to_use,
          agentAction.tool_parameters,
          agentContext
        );
        
        // Display tool result (brief summary)
        if (toolResult.status === 'success') {
          console.log(chalk.green(`✓ ${agentAction.tool_to_use} completed successfully`));
        } else if (toolResult.status === 'error') {
          console.log(chalk.red(`✗ ${agentAction.tool_to_use} failed: ${toolResult.message}`));
        } else if (toolResult.status === 'finished') {
          console.log(chalk.green(`✓ Debugging session completed`));
          break;
        } else if (toolResult.status === 'skipped') {
          console.log(chalk.yellow(`⏭ ${agentAction.tool_to_use} skipped: ${toolResult.message}`));
        }
        
        // Update agent context with the action and result
        agentContext = updateAgentContext(
          agentContext,
          stepCount,
          agentAction.thought,
          {
            tool_used: agentAction.tool_to_use,
            tool_to_use: agentAction.tool_to_use,
            parameters: agentAction.tool_parameters
          },
          toolResult
        );
        
        // NEW: Update error state if we ran a diagnostic command
        if (agentAction.tool_to_use === 'run_diagnostic_command' && toolResult.stderr) {
          agentContext = updateErrorState(agentContext, toolResult.stderr, stepCount);
        }
        
        // Special handling for finish_debugging tool
        if (agentAction.tool_to_use === 'finish_debugging') {
          break;
        }
        
        // Brief pause to make the process observable
        await new Promise(resolve => setTimeout(resolve, 500));
        
      } catch (error) {
        console.error(chalk.red(`Error in agent step ${stepCount}: ${error.message}`));
        
        // Try to recover by asking user for guidance
        try {
          const fallbackAction = {
            tool_to_use: 'ask_user_for_clarification',
            tool_parameters: {
              question_for_user: `I encountered an error: ${error.message}. How would you like me to proceed?`
            }
          };
          
          const userGuidance = await executeAgentTool(
            fallbackAction.tool_to_use,
            fallbackAction.tool_parameters,
            agentContext
          );
          
          agentContext = updateAgentContext(
            agentContext,
            stepCount,
            `Recovery attempt after error: ${error.message}`,
            fallbackAction,
            userGuidance
          );
          
        } catch (recoveryError) {
          console.error(chalk.red('Failed to recover from error. Ending session.'));
          break;
        }
      }
    }
    
    // Show session summary
    const summary = createSessionSummary(agentContext);
    console.log(boxen(
      `Session completed in ${summary.steps_taken} steps\n` +
      `Tools used: ${summary.tools_used.join(', ')}\n` +
      `Files analyzed: ${summary.files_analyzed}`,
      { ...BOX.OUTPUT, title: 'Session Summary' }
    ));
    
    // Save session log
    const ts = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 15);
    const logDir = join(__dirname, 'debug_history');
    await ensureDir(logDir);
    const logPath = join(logDir, `agent_session_${ts}.json`);
    
    try {
      await writeDebugLog([{
        session_type: 'agentic',
        timestamp: ts,
        initial_command: initialCmd,
        user_context: userContext,
        final_context: agentContext,
        steps_taken: stepCount
      }], logPath.replace('.txt', '.json'));
      console.log(chalk.gray(`Agent session saved to ${logPath}`));
    } catch (logError) {
      console.log(chalk.yellow(`Warning: Could not save session log: ${logError.message}`));
    }
    
  } catch (error) {
    console.error(chalk.red(`Fatal error in agentic debug loop: ${error.message}`));
    console.log(chalk.yellow('Falling back to user guidance...'));
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

/**
 * Gets progress status for user visualization
 */
function getProgressStatus(context) {
  const solved = context.solved_issues?.length || 0;
  const current = context.current_blocking_error?.type || "verification";
  
  if (solved === 0) {
    return `Analyzing: ${current}`;
  } else {
    return `✓ Solved ${solved} issue(s) | Current: ${current}`;
  }
}

// askInput is already imported from terminalUI.js at the top of the file