/**
 * Prompt Template for Patch Generation
 * 
 * This module builds prompts for LLM-based code fix patch generation.
 */

/**
 * Creates a prompt for generating code patches
 * 
 * @param {string} errorOutput - The error output
 * @param {string[]} prevPatches - Previous attempted patches
 * @param {string} analysis - Previous error analysis
 * @param {string} currentDir - Current working directory
 * @param {Object} fileInfo - File information context
 * @param {string} codeSummary - Code summary
 * @param {string} errorFiles - Files with errors
 * @param {string} errorLines - Lines with errors
 * @param {string} exactErrorCode - Exact error code lines
 * @param {string} context - Traceback context
 * @param {Array} ragFiles - RAG enhanced file information
 * @param {string} userContext - Optional user context for debugging focus
 * @returns {string} - The formatted prompt
 */
export function buildPatchPrompt(
  errorOutput, 
  prevPatches, 
  analysis, 
  currentDir, 
  fileInfo, 
  codeSummary, 
  errorFiles, 
  errorLines, 
  exactErrorCode, 
  context,
  ragFiles = [],
  userContext = ''
) {
  let promptParts = [
    'You are an expert code fixer. Your job is to generate a unified diff patch that fixes the error.',
    '',
    'ERROR OUTPUT:',
    errorOutput,
  ];

  // Add user context early in the prompt if provided
  if (userContext) {
    promptParts.push('', 'USER CONTEXT:', userContext);
  }

  promptParts.push(
    '',
    'ANALYSIS:',
    analysis,
    '',
    'CURRENT DIRECTORY:',
    currentDir,
  );

  // Add code summary if available
  if (codeSummary) {
    promptParts.push('', 'CODE SUMMARY:', codeSummary);
  }

  // Add file content if available
  if (fileInfo && (fileInfo.withLineNumbers || fileInfo.content)) {
    const content = fileInfo.withLineNumbers || fileInfo.content || '';
    const start = fileInfo.start || 1;
    const end = fileInfo.end || (content ? content.split('\n').length : 1);
    promptParts.push('', `FILE CONTENT (lines ${start}-${end}):`, content);
  }

  // Add error context
  if (errorFiles) {
    promptParts.push('', 'ERROR FILES:', errorFiles);
  }

  if (errorLines) {
    promptParts.push('', 'ERROR LINES:', errorLines);
  }

  if (exactErrorCode) {
    promptParts.push('', 'EXACT ERROR CODE:', exactErrorCode);
  }

  if (context) {
    promptParts.push('', 'TRACEBACK CONTEXT:', context);
  }

  // Add RAG files if available
  if (ragFiles && ragFiles.length > 0) {
    promptParts.push('', 'RAG ENHANCED FILES:');
    ragFiles.forEach(file => {
      promptParts.push(`--- ${file.path} (lines ${file.startLine}-${file.endLine}) ---`);
      promptParts.push(file.content);
      promptParts.push('');
    });
  }

  // Add previous patches if any
  if (prevPatches && prevPatches.length > 0) {
    promptParts.push('', 'PREVIOUS PATCHES (these failed):', prevPatches.join('\n'));
  }

  // Add instructions
  promptParts.push(
    '',
    'INSTRUCTIONS:',
    'Generate a unified diff patch that fixes the error. The patch must be in standard unified diff format:',
    '',
    '--- a/path/to/file.py',
    '+++ b/path/to/file.py',
    '@@ -line_start,line_count +line_start,line_count @@',
    ' unchanged line',
    '-line to remove',
    '+line to add',
    ' unchanged line',
    '',
    'Requirements:',
    '1. Use relative paths from the current directory',
    '2. Include sufficient context lines (unchanged lines around changes)',
    '3. Make minimal, targeted changes',
    '4. Ensure the fix directly addresses the error',
  );

  // Add user context focus if provided
  if (userContext) {
    promptParts.push(`5. Pay special attention to the user's concern: "${userContext}"`);
  }

  promptParts.push(
    '',
    'Generate ONLY the unified diff patch. No explanations or additional text.',
  );

  return promptParts.join('\n');
} 