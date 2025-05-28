/**
 * Prompt Template for Patch Generation
 * 
 * This module builds prompts for LLM-based code fix patch generation.
 */

/**
 * Creates a prompt for generating a code fix patch
 * 
 * @param {string} errorOutput - The error output
 * @param {string[]} prevPatches - Previous attempted patches
 * @param {string} analysis - Previous error analysis
 * @param {string} currentDir - Current working directory
 * @param {Object} fileInfo - Optional file information
 * @param {string} codeSummary - Optional code summary
 * @param {string} errorFiles - Files containing errors
 * @param {string} errorLines - Line numbers with errors
 * @param {string} exactErrorCode - Exact code with errors
 * @param {string} context - Error context
 * @param {Array<Object>} ragFiles - Array of RAG file objects with { path, startLine, endLine, content }
 * @returns {string} - The formatted prompt
 */
export function buildPatchPrompt(
  errorOutput, 
  prevPatches, 
  analysis, 
  currentDir, 
  fileInfo = {}, 
  codeSummary = '',
  errorFiles = '',
  errorLines = '',
  exactErrorCode = '',
  context = '',
  ragFiles = []
) {
  const prevPatchesText = prevPatches.length
    ? `\n\nPreviously attempted patches:\n${prevPatches.join('\n\n')}`
    : '';

  // Format file content info for the prompt
  const fileContentInfo = fileInfo && (fileInfo.withLineNumbers || fileInfo.content)
    ? `File Content (lines ${fileInfo.start || 1}-${fileInfo.end || '?'}):\n${fileInfo.withLineNumbers || fileInfo.content}\n` 
    : '';

  // Format RAG context info for the prompt
  let ragContextInfo = '';
  if (fileInfo && fileInfo.ragContext) {
    if (fileInfo.ragRootCause) {
      ragContextInfo += `RAG Root Cause Analysis:\n${fileInfo.ragRootCause}\n\n`;
    }
    if (fileInfo.ragRelatedFiles) {
      ragContextInfo += `RAG Related Files:\n${fileInfo.ragRelatedFiles}\n\n`;
    }
    if (fileInfo.ragEnhancedContent) {
      ragContextInfo += `RAG Enhanced Context:\n${fileInfo.ragEnhancedContent}\n\n`;
    }
  }

  // Format RAG files and their contents
  let ragFilesInfo = '';
  if (ragFiles && ragFiles.length > 0) {
    ragFilesInfo = 'RAG Retrieved Files and Contents:\n';
    ragFiles.forEach(file => {
      ragFilesInfo += `- File: ${file.path} (lines ${file.startLine}-${file.endLine})\n`;
      ragFilesInfo += `  Content:\n${file.content}\n\n`;
    });
  }

  return `
Analyze the error and generate a structured patch in JSON format with the following schema:
{
  "changes": [
    {
      "file_path": "relative/path/to/file.py",
      "line_number": 42,
      "old_line": "    z = x + yy",
      "new_line": "    z = x + y"
    },
    ...
  ]
}

Error Analysis:
${analysis}

Current Working Directory:
${currentDir}

${codeSummary ? `Code Summary:\n${codeSummary}\n` : ''}
${fileContentInfo}
${ragContextInfo}
${ragFilesInfo}
Error File:
${errorFiles || '(none)'}

Error Line:
${errorLines || '(none)'}

Error Code:
${exactErrorCode || '(none)'}

Code Context (±3 lines from error locations):
${context || '(none)'}

Previous Patches:
${prevPatchesText || '(none)'}

Instructions:
1. Ensure the file_path is relative to: ${currentDir}
2. Include the ENTIRE line for both old_line and new_line
3. For deletions, include old_line but set new_line to null
4. For additions, set line_number of the line that comes before and set old_line to ""
5. The line_number should correspond to the line number in the original file

IMPORTANT: PRESERVE EXACT INDENTATION
- Python code relies on proper indentation for correct execution
- Do not change indentation levels unless that's specifically part of the fix
- Each space and tab matters in the generated patch
- Copy the exact whitespace from the beginning of each line
- Ensure that relative indentation between lines remains consistent

Make sure to:
1. Only include lines that are actually changed
2. Use the correct line numbers from the error traceback (line ${errorLines || '?'})
3. Keep the changes as minimal as possible
4. Return ONLY valid JSON with no explanations or extra text

Return ONLY the JSON object with no additional text or code blocks.
`.trim();
} 