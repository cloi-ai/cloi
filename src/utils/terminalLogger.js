/**
 * Terminal Logger Module (Revised)
 *
 * Provides functionality to set up automatic terminal output logging by modifying
 * the user's .zshrc file (with explicit user permission). This enables capturing
 * runtime errors even when the application is not running, while attempting
 * to preserve terminal formatting and colors.
 */

import fs from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { askYesNo } from '../ui/terminalUI.js';
import chalk from 'chalk';
import boxen from 'boxen';
import { BOX } from '../ui/terminalUI.js';

// Markers used to identify the code block in .zshrc
const START_MARKER = '# >>> cloi initialize >>>';
const END_MARKER = '# <<< cloi initial <<<';

// Generate the ZSH script for terminal logging (Real-time Capture with advanced monitoring)
function generateZshLoggingScript() {
  return [
    START_MARKER,
    '_cloi_log_file_path="$HOME/.cloi/terminal_output.log"',
    '_cloi_log_dir_path="$HOME/.cloi"',
    '_cloi_session_log=""',
    '_cloi_current_command=""',
    '_cloi_monitor_pid=""',
    '_cloi_original_command=""',
    '',
    '# Ensure log directory and file exist',
    'mkdir -p "$_cloi_log_dir_path"',
    'touch "$_cloi_log_file_path"',
    '',
    '_cloi_rotate_logs() {',
    '  if [[ ! -f "$_cloi_log_file_path" ]]; then',
    '    return 0',
    '  fi',
    '',
    '  local file_size',
    '  if command -v stat &>/dev/null; then',
    '    if [[ "$(uname)" == "Darwin" ]]; then # macOS',
    '      file_size=$(stat -f%z "$_cloi_log_file_path")',
    '    elif [[ "$(uname)" == "Linux" ]]; then # Linux',
    '      file_size=$(stat -c%s "$_cloi_log_file_path")',
    '    else',
    '      return 0',
    '    fi',
    '  else',
    '    return 0',
    '  fi',
    '',
    '  if (( file_size > 102400 )); then',
    '    local lines=$(wc -l < "$_cloi_log_file_path" | tr -d \' \')',
    '    if (( lines > 10 )); then',
    '        local half=$((lines / 2))',
    '        tail -n "$half" "$_cloi_log_file_path" > "${_cloi_log_file_path}.tmp" && \\',
    '        mv "${_cloi_log_file_path}.tmp" "$_cloi_log_file_path" && \\',
    '        printf "[%s] === Log file rotated by Cloi ===\\n" "$(date \'+%Y-%m-%d %H:%M:%S\')" >> "$_cloi_log_file_path"',
    '    fi',
    '  fi',
    '}',
    '',
    '# Function to detect if a command is likely to be long-running',
    '_cloi_is_long_running_command() {',
    '  local cmd="$1"',
    '  # Common patterns for long-running commands',
    '  if [[ "$cmd" =~ (npm|yarn|pnpm)\\s+(start|dev|serve|run\\s+dev) ]] ||',
    '     [[ "$cmd" =~ python.*manage\\.py\\s+runserver ]] ||',
    '     [[ "$cmd" =~ (rails|bundle\\s+exec\\s+rails)\\s+(server|s) ]] ||',
    '     [[ "$cmd" =~ node.*server ]] ||',
    '     [[ "$cmd" =~ (php\\s+)?artisan\\s+serve ]] ||',
    '     [[ "$cmd" =~ hugo\\s+server ]] ||',
    '     [[ "$cmd" =~ jekyll\\s+serve ]] ||',
    '     [[ "$cmd" =~ gatsby\\s+(develop|dev) ]] ||',
    '     [[ "$cmd" =~ next\\s+(dev|start) ]] ||',
    '     [[ "$cmd" =~ vite(\\s+dev)? ]] ||',
    '     [[ "$cmd" =~ webpack.*serve ]] ||',
    '     [[ "$cmd" =~ docker.*run.*-it ]] ||',
    '     [[ "$cmd" =~ (watch|nodemon|pm2) ]] ||',
    '     [[ "$cmd" =~ tail\\s+-f ]] ||',
    '     [[ "$cmd" =~ (ssh|telnet|nc|netcat) ]]; then',
    '    return 0',
    '  fi',
    '  return 1',
    '}',
    '',
    '# Advanced command wrapper with real-time monitoring',
    '_cloi_command_wrapper() {',
    '  local cmd="$*"',
    '  local session_id="$(date +%s)_$$"',
    '  local session_log="$_cloi_log_dir_path/session_${session_id}.log"',
    '  ',
    '  # Log command header immediately',
    '  {',
    '    printf "===================================================\\n"',
    '    printf "[%s] COMMAND: %s\\n" "$(date \'+%Y-%m-%d %H:%M:%S\')" "$cmd"',
    '    printf "[%s] DIRECTORY: %s\\n" "$(date \'+%Y-%m-%d %H:%M:%S\')" "$(pwd)"',
    '    printf "[%s] SESSION: %s\\n" "$(date \'+%Y-%m-%d %H:%M:%S\')" "$session_id"',
    '    printf "[%s] OUTPUT BEGINS BELOW:\\n" "$(date \'+%Y-%m-%d %H:%M:%S\')"',
    '    printf -- "---------------------------------------------------\\n"',
    '  } > "$session_log"',
    '  ',
    '  # Append header to main log immediately so it shows up',
    '  cat "$session_log" >> "$_cloi_log_file_path"',
    '  ',
    '  local exit_status=0',
    '  local interrupted=false',
    '  ',
    '  # Set up signal handling',
    '_cloi_handle_interrupt() {',
    '    interrupted=true',
    '    printf "\\n[%s] === INTERRUPTED BY USER (Ctrl+C) ===\\n" "$(date \'+%Y-%m-%d %H:%M:%S\')" >> "$session_log"',
    '  }',
    '  ',
    '  # Install trap for this function',
    '  trap \'_cloi_handle_interrupt\' INT',
    '  ',
    '  # Execute command with real-time output capture',
    '  # Use the most reliable approach: direct execution with tee',
    '  if command -v stdbuf >/dev/null 2>&1; then',
    '    # Use stdbuf to disable buffering (most reliable)',
    '    stdbuf -oL -eL bash -c "$cmd" 2>&1 | tee -a "$session_log"',
    '    exit_status=${PIPESTATUS[0]}',
    '  elif command -v unbuffer >/dev/null 2>&1; then',
    '    # Use unbuffer if stdbuf not available',
    '    unbuffer -p bash -c "$cmd" 2>&1 | tee -a "$session_log"',
    '    exit_status=${PIPESTATUS[0]}',
    '  else',
    '    # Final fallback: basic execution with tee',
    '    # This will work on all systems, though output might be buffered',
    '    bash -c "$cmd" 2>&1 | tee -a "$session_log"',
    '    exit_status=${PIPESTATUS[0]}',
    '  fi',
    '  ',
    '  # Handle interruption',
    '  if [[ "$interrupted" == "true" ]]; then',
    '    exit_status=130',
    '  fi',
    '  ',
    '  # Remove the trap',
    '  trap - INT',
    '  ',
    '  # Add footer to session log',
    '  {',
    '    printf -- "---------------------------------------------------\\n"',
    '    printf "[%s] EXIT STATUS: %s\\n" "$(date \'+%Y-%m-%d %H:%M:%S\')" "$exit_status"',
    '    printf "[%s] SESSION ENDED\\n" "$(date \'+%Y-%m-%d %H:%M:%S\')"',
    '    printf "===================================================\\n\\n"',
    '  } >> "$session_log"',
    '  ',
    '  # Append the output and footer to main log',
    '  tail -n +7 "$session_log" >> "$_cloi_log_file_path" 2>/dev/null || {',
    '    # Fallback: append everything except the header we already added',
    '    sed \'1,/---------------------------------------------------/d\' "$session_log" >> "$_cloi_log_file_path"',
    '  }',
    '  ',
    '  # Clean up session log',
    '  rm -f "$session_log"',
    '  ',
    '  return $exit_status',
    '}',
    '',
    '# Simple fallback wrapper when advanced features fail',
    '_cloi_simple_wrapper() {',
    '  local cmd="$1"',
    '  local session_log="$2"',
    '  ',
    '  # Log command header',
    '  {',
    '    printf "===================================================\\n"',
    '    printf "[%s] COMMAND: %s\\n" "$(date \'+%Y-%m-%d %H:%M:%S\')" "$cmd"',
    '    printf "[%s] DIRECTORY: %s\\n" "$(date \'+%Y-%m-%d %H:%M:%S\')" "$(pwd)"',
    '    printf "[%s] OUTPUT BEGINS BELOW:\\n" "$(date \'+%Y-%m-%d %H:%M:%S\')"',
    '    printf -- "---------------------------------------------------\\n"',
    '  } > "$session_log"',
    '  ',
    '  # Execute command with tee for real-time capture',
    '  local exit_status=0',
    '  {',
    '    eval "$cmd" 2>&1 | tee -a "$session_log"',
    '    exit_status=${PIPESTATUS[0]}',
    '  }',
    '  ',
    '  # Add footer',
    '  {',
    '    printf -- "---------------------------------------------------\\n"',
    '    printf "[%s] EXIT STATUS: %s\\n" "$(date \'+%Y-%m-%d %H:%M:%S\')" "$exit_status"',
    '    printf "===================================================\\n\\n"',
    '  } >> "$session_log"',
    '  ',
    '  # Merge to main log',
    '  cat "$session_log" >> "$_cloi_log_file_path"',
    '  rm -f "$session_log"',
    '  ',
    '  return $exit_status',
    '}',
    '',
    '# Override common long-running commands to use our wrapper',
    'npm() {',
    '  if [[ "$1" == "start" || "$1" == "dev" || "$1" == "serve" || ("$1" == "run" && "$2" == "dev") ]]; then',
    '    _cloi_command_wrapper "command npm $*"',
    '  else',
    '    command npm "$@"',
    '  fi',
    '}',
    '',
    'yarn() {',
    '  if [[ "$1" == "start" || "$1" == "dev" || "$1" == "serve" ]]; then',
    '    _cloi_command_wrapper "command yarn $*"',
    '  else',
    '    command yarn "$@"',
    '  fi',
    '}',
    '',
    'pnpm() {',
    '  if [[ "$1" == "start" || "$1" == "dev" || "$1" == "serve" || ("$1" == "run" && "$2" == "dev") ]]; then',
    '    _cloi_command_wrapper "command pnpm $*"',
    '  else',
    '    command pnpm "$@"',
    '  fi',
    '}',
    '',
    'python() {',
    '  case "$*" in',
    '    *manage.py*runserver*)',
    '      _cloi_command_wrapper "command python $*"',
    '      ;;',
    '    *)',
    '      command python "$@"',
    '      ;;',
    '  esac',
    '}',
    '',
    'node() {',
    '  if [[ "$*" =~ server ]] || [[ "$1" =~ .*server.* ]]; then',
    '    _cloi_command_wrapper "command node $*"',
    '  else',
    '    command node "$@"',
    '  fi',
    '}',
    '',
    '# Add more command overrides for comprehensive coverage',
    'rails() {',
    '  if [[ "$1" == "server" || "$1" == "s" ]]; then',
    '    _cloi_command_wrapper "command rails $*"',
    '  else',
    '    command rails "$@"',
    '  fi',
    '}',
    '',
    'bundle() {',
    '  if [[ "$1" == "exec" && "$2" == "rails" && ("$3" == "server" || "$3" == "s") ]]; then',
    '    _cloi_command_wrapper "command bundle $*"',
    '  else',
    '    command bundle "$@"',
    '  fi',
    '}',
    '',
    'php() {',
    '  if [[ "$*" =~ artisan\\s+serve ]]; then',
    '    _cloi_command_wrapper "command php $*"',
    '  else',
    '    command php "$@"',
    '  fi',
    '}',
    '',
    '# Enhanced preexec function for non-overridden commands',
    '_cloi_log_preexec() {',
    '  _cloi_current_command="$1"',
    '  _cloi_original_command="$1"',
    '',
    '  # Skip cloi-related commands and self-referential operations',
    '  if [[ -z "$_cloi_current_command" ]] ||',
    '     [[ "$_cloi_current_command" == *"_cloi_"* ]] ||',
    '     [[ "$_cloi_current_command" == "cloi"* ]] ||',
    '     [[ "$_cloi_current_command" == "source "*".zshrc"* ]] ||',
    '     [[ "$_cloi_current_command" == *"$_cloi_log_file_path"* ]] ||',
    '     [[ "$_cloi_current_command" == *"command npm"* ]] ||',
    '     [[ "$_cloi_current_command" == *"command yarn"* ]] ||',
    '     [[ "$_cloi_current_command" == *"command pnpm"* ]] ||',
    '     [[ "$_cloi_current_command" == *"command python"* ]] ||',
    '     [[ "$_cloi_current_command" == *"command node"* ]] ||',
    '     [[ "$_cloi_current_command" == *"command rails"* ]] ||',
    '     [[ "$_cloi_current_command" == *"command bundle"* ]] ||',
    '     [[ "$_cloi_current_command" == *"command php"* ]]; then',
    '    _cloi_current_command=""',
    '    return',
    '  fi',
    '',
    '  # For commands not handled by function overrides, use traditional logging',
    '  if _cloi_is_long_running_command "$_cloi_current_command"; then',
    '    # For unhandled long-running commands, try to use wrapper',
    '    return  # Let the command run, we\'ll capture it in precmd',
    '  else',
    '    # For short commands, just log the header',
    '    {',
    '      printf "===================================================\\n"',
    '      printf "[%s] COMMAND: %s\\n" "$(date \'+%Y-%m-%d %H:%M:%S\')" "$_cloi_current_command"',
    '      printf "[%s] DIRECTORY: %s\\n" "$(date \'+%Y-%m-%d %H:%M:%S\')" "$(pwd)"',
    '      printf "[%s] OUTPUT BEGINS BELOW:\\n" "$(date \'+%Y-%m-%d %H:%M:%S\')"',
    '      printf -- "---------------------------------------------------\\n"',
    '    } >> "$_cloi_log_file_path"',
    '  fi',
    '}',
    '',
    '# Enhanced precmd function',
    '_cloi_log_precmd() {',
    '  local last_cmd_status=$?',
    '  ',
    '  if [[ -z "$_cloi_current_command" ]]; then',
    '    return',
    '  fi',
    '',
    '  # For short commands, capture output by re-execution (existing behavior)',
    '  if ! _cloi_is_long_running_command "$_cloi_current_command"; then',
    '    local output',
    '    output=$(eval "$_cloi_current_command" 2>&1)',
    '    ',
    '    # Append the output to the log file',
    '    printf "%s\\n" "$output" >> "$_cloi_log_file_path"',
    '    ',
    '    # Log command footer',
    '    {',
    '      printf -- "---------------------------------------------------\\n"',
    '      printf "[%s] EXIT STATUS: %s\\n" "$(date \'+%Y-%m-%d %H:%M:%S\')" "$last_cmd_status"',
    '      printf "===================================================\\n\\n"',
    '    } >> "$_cloi_log_file_path"',
    '  else',
    '    # For long-running commands that weren\'t caught by function overrides',
    '    # Try to use the wrapper as a last resort',
    '    if [[ -n "$_cloi_original_command" ]]; then',
    '      {',
    '        printf "[%s] === LONG-RUNNING COMMAND DETECTED ===\\n" "$(date \'+%Y-%m-%d %H:%M:%S\')"',
    '        printf "[%s] Command: %s\\n" "$(date \'+%Y-%m-%d %H:%M:%S\')" "$_cloi_original_command"',
    '        printf "[%s] Note: Limited output capture for this command type\\n" "$(date \'+%Y-%m-%d %H:%M:%S\')"',
    '        printf "[%s] Suggestion: Use npm/yarn/python/node/rails overrides for better capture\\n" "$(date \'+%Y-%m-%d %H:%M:%S\')"',
    '        printf -- "---------------------------------------------------\\n"',
    '        printf "[%s] EXIT STATUS: %s\\n" "$(date \'+%Y-%m-%d %H:%M:%S\')" "$last_cmd_status"',
    '        printf "===================================================\\n\\n"',
    '      } >> "$_cloi_log_file_path"',
    '    fi',
    '  fi',
    '',
    '  _cloi_current_command=""',
    '  _cloi_original_command=""',
    '  _cloi_rotate_logs',
    '}',
    '',
    'typeset -ga preexec_functions precmd_functions',
    'preexec_functions=("${preexec_functions[@]}")',
    'precmd_functions=("${precmd_functions[@]}")',
    '',
    'if ! (($preexec_functions[(Ie)_cloi_log_preexec])); then',
    '  preexec_functions+=(_cloi_log_preexec)',
    'fi',
    'if ! (($precmd_functions[(Ie)_cloi_log_precmd])); then',
    '  precmd_functions+=(_cloi_log_precmd)',
    'fi',
    END_MARKER
  ].join('\n');
}

/**
 * Gets the path to the user's .zshrc file
 * @returns {string} Path to the user's .zshrc file
 */
export function getZshrcPath() {
  return join(homedir(), '.zshrc');
}

/**
 * Gets the path to the terminal output log file
 * @returns {string} Path to the terminal output log file
 */
export function getTerminalLogPath() {
  return join(homedir(), '.cloi', 'terminal_output.log');
}

/**
 * Checks if the automatic logging function is already present in .zshrc
 * @returns {Promise<boolean>} True if the logging function exists
 */
export async function isLoggingEnabled() {
  const zshrcPath = getZshrcPath();
  
  // Check if .zshrc exists
  if (!existsSync(zshrcPath)) {
    return false;
  }
  
  try {
    const content = await fs.readFile(zshrcPath, 'utf8');
    return content.includes(START_MARKER) && content.includes('_cloi_log_preexec');
  } catch (error) {
    console.error(`Error checking .zshrc: ${error.message}`);
    return false;
  }
}

/**
 * Adds the logging function to the user's .zshrc file
 * @returns {Promise<boolean>} True if the function was added successfully
 */
export async function enableLogging() {
  const zshrcPath = getZshrcPath();
  
  try {
    let content = '';
    // Check if .zshrc exists, create it if it doesn't
    if (existsSync(zshrcPath)) {
      content = await fs.readFile(zshrcPath, 'utf8');
      
      // Remove existing block if present
      const startIndex = content.indexOf(START_MARKER);
      const endIndex = content.indexOf(END_MARKER);
      if (startIndex !== -1 && endIndex !== -1 && endIndex > startIndex) {
        content = content.substring(0, startIndex) + 
                 content.substring(endIndex + END_MARKER.length);
        // Clean up excessive newlines
        content = content.replace(/\n\s*\n/g, '\n').trim();
      }
    }
    
    // Generate the zsh logging script and append it
    const zshScript = generateZshLoggingScript();
    const finalContent = (content ? content + '\n\n' : '') + zshScript;
    await fs.writeFile(zshrcPath, finalContent, 'utf8');
    return true;
  } catch (error) {
    console.error(`Error modifying .zshrc: ${error.message}`);
    return false;
  }
}

/**
 * Prompts the user for permission to enable automatic terminal output logging
 * @param {object} uiTools - Object containing UI tools (askYesNo, askInput, etc.)
 * @param {boolean} showModelSelection - Whether to show model selection (default: false)
 * @returns {Promise<boolean>} True if the user granted permission and logging was enabled
 */
export async function setupTerminalLogging(uiTools, showModelSelection = false) {
  // Use provided UI tools or import them if not provided
  const { askYesNo, askInput, closeReadline } = uiTools || await import('../ui/terminalUI.js');
  
  const alreadyEnabled = await isLoggingEnabled();
  
  if (alreadyEnabled) {
    console.log(boxen(
      chalk.gray('Terminal logging is already enabled.'),
      { ...BOX.OUTPUT, title: 'Status' }
    ));
    return true;
  }
  
  console.log(boxen(
    [
      '',
      'This will add a small script to your .zshrc file that automatically logs terminal commands and their output.',
      'This helps CLOI detect and diagnose errors even when not explicitly running with `/debug`.',
      '',
      'How it works:',
      '- Creates a log file at ~/.cloi/terminal_output.log',
      '- Logs all commands and their output',
      '- Automatically rotates logs to save disk space',
      '',
      'Would you like to enable this feature? (y/N):',
    ].join('\n'),
    { ...BOX.CONFIRM, title: 'Terminal Logging' }
  ));
  
  const response = await askYesNo('', true);
  console.log(response ? 'y' : 'N');
  
  if (!response) {
    return false;
  }
  
  const success = await enableLogging();
  
  if (success) {
    console.log(boxen(
      chalk.green('Terminal logging setup successful.\nPlease restart your terminal or run `source ~/.zshrc` to activate.'),
      { ...BOX.OUTPUT, title: 'Success' }
    ));
    
    // After successful logging setup, ask user to set default model only if showModelSelection is true
    if (showModelSelection) {
      console.log(boxen(
        'Would you like to set a default model to use? (y/N):',
        { ...BOX.CONFIRM, title: 'Default Model Setup' }
      ));
      
      const setModelResponse = await askYesNo('', true);
      console.log(setModelResponse ? 'y' : 'N');
      
      if (setModelResponse) {
        // Import the necessary functions to select a model
        const { setDefaultModel } = await import('./modelConfig.js');
        
        // Import the selectModelFromList function
        const { selectModelFromList } = await import('../cli/index.js');
        
        console.log(boxen(
          'Please select your preferred default model:',
          { ...BOX.PROMPT, title: 'Model Selection' }
        ));
        
        const selectedModel = await selectModelFromList();
        
        if (selectedModel) {
          // Save the selected model as default
          const saveResult = await setDefaultModel(selectedModel);
          
          if (saveResult) {
            console.log(boxen(
              chalk.green(`Your default model has been set to: ${selectedModel}`),
              { ...BOX.OUTPUT, title: 'Success' }
            ));
          } else {
            console.log(boxen(
              chalk.gray('Failed to save the default model.'),
              { ...BOX.OUTPUT_DARK, title: 'Setup Incomplete' }
            ));
          }
        }
      }
    }
    
    console.log(boxen(
      'Please restart your terminal or run "source ~/.zshrc" for changes to take effect. Run `cloi` when you encounter the next error.',
      { ...BOX.OUTPUT, title: 'Action Required' }
    ));
    
    // Force exit the process after showing the message
    // First cleanup any resources
    if (closeReadline) {
      closeReadline();
    }
    
    // Force exit with a minimal delay to allow the message to be displayed
    process.stdout.write('\n');
    
    // Ensure all terminal state is reset and process exits 
    setTimeout(() => {
      // This is the most reliable way to force Node.js to exit
      process.exit(0);
    }, 100);
    
    return true;
  } else {
    console.log(boxen(
      chalk.red('Failed to enable terminal logging.'),
      { ...BOX.OUTPUT, title: 'Error' }
    ));
    return false;
  }
}

/**
 * Removes the logging function from the user's .zshrc file
 * @returns {Promise<boolean>} True if the function was removed successfully
 */
export async function disableLogging() {
  const zshrcPath = getZshrcPath();
  
  // Check if .zshrc exists
  if (!existsSync(zshrcPath)) {
    return true; // Nothing to disable
  }
  
  try {
    let content = await fs.readFile(zshrcPath, 'utf8');
    
    // Remove the logging code block using start/end markers
    const startIndex = content.indexOf(START_MARKER);
    const endIndex = content.indexOf(END_MARKER);
    if (startIndex !== -1 && endIndex !== -1 && endIndex > startIndex) {
      content = content.substring(0, startIndex) + 
               content.substring(endIndex + END_MARKER.length + 1);
      // Clean up excessive newlines
      content = content.replace(/\n\s*\n/g, '\n').trim();
      await fs.writeFile(zshrcPath, content ? content + '\n' : '', 'utf8');
    }
    return true;
  } catch (error) {
    console.error(`Error modifying .zshrc during disable: ${error.message}`);
    return false;
  }
} 