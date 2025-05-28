/**
 * RAG Integration Module
 * 
 * Provides integration between the core error analysis functionality
 * and the RAG system for retrieving relevant code files.
 */

import { retrieveRelevantFiles, getRAGStats, indexCodebase } from '../rag/index.js';
import { readFileContext } from '../utils/traceback.js';
import { findRepoOrProjectRoot, getProjectInfo } from '../utils/projectUtils.js';
import { checkRAGRequirements, displayRAGStatus } from '../utils/pythonCheck.js';
import fs from 'fs';
import path from 'path';

// Cache for RAG initialization to prevent duplicate loading messages
const ragInitCache = new Map();

/**
 * Enhance error analysis with RAG-retrieved context
 * @param {string} errorOutput - The error output to analyze
 * @param {Object} fileInfo - Current file information
 * @param {string} currentDir - Current working directory
 * @returns {Promise<Object>} Enhanced file info with RAG context
 */
export async function enhanceWithRAG(errorOutput, fileInfo, currentDir) {
  try {
    // Find project root using comprehensive detection
    const rootInfo = await findRepoOrProjectRoot(currentDir);
    
    if (rootInfo.confidence === 'minimal') {
      throw new Error('No clear project structure found. RAG works best in organized projects.');
    }
    
    // Retrieve relevant files using RAG with detected project root
    const ragResults = await retrieveRelevantFiles(errorOutput, rootInfo.root, {
      k: 3, // Get top 3 results
      identifyRoot: true
    });
    
    // If no results, return original file info
    if (!ragResults || !ragResults.results || ragResults.results.length === 0) {
      return fileInfo;
    }
    
    // Get the root cause file if identified
    const rootCauseFile = ragResults.rootCauseFile;
    
    // Get grouped results by file
    const { groupedResults } = ragResults;
    
    // Prepare enhanced context
    let enhancedContext = '';
    let enhancedFileInfo = { ...fileInfo };
    
    // If we have a root cause file, prioritize it
    if (rootCauseFile && rootCauseFile.metadata && rootCauseFile.metadata.filePath) {
      const filePath = rootCauseFile.metadata.filePath;
      
      // Check if file exists
      if (fs.existsSync(filePath)) {
        // Read context around the identified lines
        const startLine = rootCauseFile.metadata.startLine || 1;
        const endLine = rootCauseFile.metadata.endLine || startLine + 30;
        const midLine = Math.floor((startLine + endLine) / 2);
        
        // Read file context with the identified line in the middle
        const contextSize = 30; // Read 30 lines before and after
        const fileContentInfo = readFileContext(filePath, midLine, contextSize);
        
        // Add to enhanced context
        enhancedContext += `\n--- ROOT CAUSE FILE: ${filePath} ---\n`;
        enhancedContext += fileContentInfo.content;
        
        // Update file info with root cause file
        if (!enhancedFileInfo.ragContext) {
          enhancedFileInfo.ragContext = {};
        }
        
        enhancedFileInfo.ragContext.rootCauseFile = {
          path: filePath,
          content: fileContentInfo.content,
          startLine: fileContentInfo.start,
          endLine: fileContentInfo.end,
          score: rootCauseFile.combinedScore
        };
      }
    }
    
    // Add context from other relevant files (up to 2 more)
    const otherFiles = groupedResults
      .filter(group => !rootCauseFile || group.filePath !== rootCauseFile.metadata.filePath)
      .slice(0, 2);
    
    if (otherFiles.length > 0) {
      if (!enhancedFileInfo.ragContext) {
        enhancedFileInfo.ragContext = {};
      }
      
      enhancedFileInfo.ragContext.relatedFiles = [];
      
      for (const fileGroup of otherFiles) {
        const filePath = fileGroup.filePath;
        
        // Check if file exists
        if (fs.existsSync(filePath)) {
          // Get the highest scoring chunk for this file
          const bestChunk = fileGroup.chunks.reduce(
            (best, current) => current.combinedScore > best.combinedScore ? current : best, 
            fileGroup.chunks[0]
          );
          
          // Read context around the identified lines
          const startLine = bestChunk.metadata.startLine || 1;
          const endLine = bestChunk.metadata.endLine || startLine + 20;
          const midLine = Math.floor((startLine + endLine) / 2);
          
          // Read file context with the identified line in the middle
          const contextSize = 20; // Read 20 lines before and after for related files
          const fileContentInfo = readFileContext(filePath, midLine, contextSize);
          
          // Add to enhanced context
          enhancedContext += `\n--- RELATED FILE: ${filePath} ---\n`;
          enhancedContext += fileContentInfo.content;
          
          // Add to file info
          enhancedFileInfo.ragContext.relatedFiles.push({
            path: filePath,
            content: fileContentInfo.content,
            startLine: fileContentInfo.start,
            endLine: fileContentInfo.end,
            score: bestChunk.combinedScore
          });
        }
      }
    }
    
    // Add the enhanced context to the file info
    enhancedFileInfo.ragEnhancedContext = enhancedContext;
    
    return enhancedFileInfo;
  } catch (error) {
    // Log error for debugging but don't crash the analysis
    console.log(`  RAG enhancement skipped: ${error.message}`);
    // Return original file info if RAG enhancement fails
    return fileInfo;
  }
}

/**
 * Initialize the RAG system if needed
 * @param {string} currentPath - Current working directory
 * @returns {Promise<Object>} Project root information or null if failed
 */
export async function initializeRAGIfNeeded(currentPath) {
  try {
    // Simple project root detection first to get cache key
    const rootInfo = await findRepoOrProjectRoot(currentPath);
    const cacheKey = rootInfo.root;
    
    // Check if we've already initialized this project in this session
    if (ragInitCache.has(cacheKey)) {
      const cachedResult = ragInitCache.get(cacheKey);
      // Return cached result for subsequent calls
      return cachedResult.rootInfo;
    }
    
    // First check if Python and required packages are available
    const requirements = await checkRAGRequirements();
    
    if (!requirements.ready) {
      displayRAGStatus(requirements);
      throw new Error(`RAG system requirements not satisfied: ${requirements.issues.join(', ')}`);
    }
    
    // Accept any detection result - no more strict requirements
    
    // Get project information
    const projectInfo = await getProjectInfo(rootInfo.root, rootInfo.type);
    
    // Check if RAG is already initialized for this project
    let stats;
    try {
      stats = await getRAGStats(rootInfo.root);
    } catch (error) {
      // If we can't get stats, assume we need to initialize
      stats = { vectorStats: { vectorCount: 0 } };
    }
    
    // If RAG is not initialized or has no documents, initialize it
    if (!stats.vectorStats.vectorCount || stats.vectorStats.vectorCount === 0) {
      try {
        // Index the directory with reasonable limits
        await indexCodebase(rootInfo.root, {
          maxFilesToProcess: 200, // Allow more files for better coverage
          batchSize: 20
        });
        
        // Get updated stats after indexing
        try {
          stats = await getRAGStats(rootInfo.root);
        } catch (error) {
          stats = { vectorStats: { vectorCount: 0 } };
        }
      } catch (indexError) {
        // If indexing fails (e.g., due to CodeBERT issues), still allow the system to work
        console.log(`  RAG indexing failed: ${indexError.message}`);
        
        // Check if this is a CodeBERT-related error
        if (indexError.message.includes('CodeBERT') || indexError.message.includes('Model directory not found')) {
          throw new Error(`  CodeBERT model not available. Please run 'npm run codebert-setup' to download the model files, or continue with basic error analysis.`);
        } else {
          // For other errors, just warn but continue
          console.log(`  Warning: RAG indexing failed, but continuing with basic analysis: ${indexError.message}`);
          stats = { vectorStats: { vectorCount: 0 } };
        }
      }
    }
    
    // Cache the result to prevent duplicate initialization
    ragInitCache.set(cacheKey, {
      rootInfo,
      vectorCount: stats.vectorStats?.vectorCount || 0,
      timestamp: Date.now()
    });
    
    return rootInfo;
  } catch (error) {
    throw new Error(`RAG initialization failed: ${error.message}`);
  }
}

/**
 * Clear the RAG initialization cache
 * Useful for testing or when project structure changes
 */
export function clearRAGCache() {
  ragInitCache.clear();
  console.log('RAG initialization cache cleared');
}

/**
 * Get current RAG cache status
 * @returns {Array} Array of cached project information
 */
export function getRAGCacheStatus() {
  return Array.from(ragInitCache.entries()).map(([path, data]) => ({
    path,
    vectorCount: data.vectorCount,
    timestamp: new Date(data.timestamp).toISOString()
  }));
}
