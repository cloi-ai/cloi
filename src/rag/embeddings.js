/**
 * CodeBERT Embedding Generation Module
 * 
 * Module for generating code embeddings using CodeBERT model.
 * Uses downloaded model files or falls back to deterministic patterns
 * if model files are not available.
 */

// Dynamic imports to avoid breaking when packages are not installed
// import { pipeline } from '@huggingface/transformers'; // Moved to conditional import
import path from 'path';
import fs from 'fs';
// import seedrandom from 'seedrandom'; // Moved to conditional import
import { chunkCodeFile } from './chunking.js';

// Module constants
const MAX_LENGTH = 512; // Maximum sequence length for CodeBERT
const EMBEDDING_DIMENSION = 768; // CodeBERT embedding dimension
const BATCH_SIZE = 4; // Batch size for processing

// Cache for the model to avoid reloading
let embeddingModel = null;
let currentModel = null;
let modelType = null; // 'codebert'

/**
 * Start the CodeBERT Python service
 * @returns {Promise<void>}
 */
export async function startCodeBERTService() {
  const { spawn } = await import('child_process');
  const path = await import('path');
  const fs = await import('fs');
  const { fileURLToPath } = await import('url');
  
  const CODEBERT_PORT = 3090;
  
  // Get the Cloi installation directory (not current working directory)
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);
  const cloiRoot = path.resolve(__dirname, '..', '..');
  const scriptPath = path.join(cloiRoot, 'bin', 'codebert_service.py');
  
  console.log(`Starting CodeBERT service from ${scriptPath}`);
  
  // Check if the script exists
  if (!fs.existsSync(scriptPath)) {
    throw new Error(`CodeBERT service script not found at ${scriptPath}`);
  }
  
  // Start the Python service
  const pythonProcess = spawn('python', [scriptPath, '--port', CODEBERT_PORT], {
    detached: true,
    stdio: 'ignore'
  });
  
  // Detach the process
  pythonProcess.unref();
  
  console.log('CodeBERT service started in background');
}

/**
 * Initialize CodeBERT model using the Python service - NO fallbacks
 * @returns {Promise<Object>} The initialized model and metadata
 */
export async function initializeCodeModel() {
  // Return cached model if available
  if (embeddingModel) {
    return { model: embeddingModel, modelName: currentModel, modelType, embeddingDim: EMBEDDING_DIMENSION };
  }
  
  try {
    // Import necessary modules
    const fs = await import('fs');
    const path = await import('path');
    const { spawn } = await import('child_process');
    
    // Always use the global model from the home directory
    const homeDir = process.env.HOME || process.env.USERPROFILE;
    const modelFilesDir = path.join(homeDir, '.cloi', 'models', 'codebert-base');
    

    
    // Check that the model directory exists
    if (!fs.existsSync(modelFilesDir)) {
      throw new Error(`Model directory not found at ${modelFilesDir}. Please run: npm run codebert-setup`);
    }
    
    // Verify PyTorch model exists
    const pytorchFile = path.join(modelFilesDir, 'pytorch_model.bin');
    
    if (!fs.existsSync(pytorchFile)) {
      throw new Error(`PyTorch model file not found at ${pytorchFile}. Please run: npm run codebert-setup`);
    }
    
    // Verify other required files
    const requiredFiles = [
      'tokenizer.json',
      'config.json',
      'vocab.json'
    ];
    
    for (const file of requiredFiles) {
      const filePath = path.join(modelFilesDir, file);
      if (!fs.existsSync(filePath)) {
        throw new Error(`Required file not found: ${file}. Please run: npm run codebert-setup`);
      }
    }
    
    // Port for the CodeBERT service
    const CODEBERT_PORT = 3090;
    const CODEBERT_URL = `http://localhost:${CODEBERT_PORT}`;
    
    // Start the Python service if it's not already running
    
    // Try to connect to the service first to see if it's already running
    let serviceRunning = false;
    try {
      const response = await fetch(`${CODEBERT_URL}/health`);
      if (response.ok) {
        serviceRunning = true;
      }
    } catch (e) {
      // Service not running, will start it below
    }
    
    // Start the service if it's not running
    if (!serviceRunning) {
      // Get the Cloi installation directory (not current working directory)
      const { fileURLToPath } = await import('url');
      const __filename = fileURLToPath(import.meta.url);
      const __dirname = path.dirname(__filename);
      const cloiRoot = path.resolve(__dirname, '..', '..');
      const scriptPath = path.join(cloiRoot, 'bin', 'codebert_service.py');
      
      console.log(`Starting CodeBERT service from ${scriptPath}`);
      
      // Check if the script exists
      if (!fs.existsSync(scriptPath)) {
        throw new Error(`CodeBERT service script not found at ${scriptPath}`);
      }
      
      // Start the Python service
      const pythonProcess = spawn('python', [scriptPath, '--port', CODEBERT_PORT]);
      
      // Log stdout and stderr
      pythonProcess.stdout.on('data', (data) => {
        console.log(`CodeBERT service: ${data}`);
      });
      
      pythonProcess.stderr.on('data', (data) => {
        console.error(`CodeBERT service error: ${data}`);
      });
      
      // Handle process exit
      pythonProcess.on('close', (code) => {
        if (code !== 0) {
          console.error(`CodeBERT service exited with code ${code}`);
        }
      });
      
      // Wait for the service to start
      console.log('Waiting for CodeBERT service to start...');
      await new Promise((resolve) => setTimeout(resolve, 3000));
    }
    
    // Create a client for the CodeBERT service
    embeddingModel = async function(text, options = {}) {
      try {
        // Check if service is running first
        let serviceRunning = false;
        try {
          const healthCheck = await fetch(`${CODEBERT_URL}/health`, { timeout: 1000 });
          serviceRunning = healthCheck.ok;
        } catch (e) {
          // Try to start the service if it's not running
          await startCodeBERTService();
          // Wait a bit longer for it to initialize
          await new Promise(resolve => setTimeout(resolve, 5000));
        }
        

        
        // Call the Python service to get embeddings
        const response = await fetch(`${CODEBERT_URL}/embed`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({ text })
        });
        
        if (!response.ok) {
          throw new Error(`Service returned ${response.status}: ${response.statusText}`);
        }
        
        const data = await response.json();
        if (!data.embedding) {
          throw new Error('No embedding returned from service');
        }
        
        // CRITICAL: Create a true array for our output format - this is the format expected by transformers.js
        return [
          {
            values: new Float32Array(data.embedding),
            dims: data.embedding.length
          }
        ];
      } catch (error) {
        console.error(`Error calling CodeBERT service: ${error.message}`);
        throw error;
      }
    };
    
    
    
    // Test the service
    try {
      const testResult = await embeddingModel('function test() { return true; }');

    } catch (error) {
      console.error(`CodeBERT service test failed: ${error.message}`);
      throw new Error(`Failed to connect to CodeBERT service: ${error.message}`);
    }
    
    // Set model metadata
    currentModel = 'microsoft/codebert-base';
    modelType = 'codebert';
    
    return { model: embeddingModel, modelName: currentModel, modelType, embeddingDim: EMBEDDING_DIMENSION };
  } catch (error) {
    console.error(`ERROR: Cannot use CodeBERT model: ${error.message}`);
    throw new Error(`Failed to initialize CodeBERT model: ${error.message}`);
  }
}

/**
 * Generate embeddings for a code chunk
 * @param {string} codeChunk - The code chunk to embed
 * @returns {Promise<Float32Array>} The embedding vector as Float32Array
 */
export async function generateEmbedding(codeChunk) {
  // Ensure model is initialized
  const { model } = await initializeCodeModel();
  
  if (!model) {
    throw new Error('CodeBERT model not initialized');
  }

  // Preprocess and truncate code for the model
  const processedCode = preprocessCodeForCodeBERT(codeChunk);
  const truncatedCode = processedCode.length > MAX_LENGTH * 4 ? 
    processedCode.substring(0, MAX_LENGTH * 4) : processedCode;

  // Generate embedding with no fallbacks
  const output = await model(truncatedCode);
  
  // Extract embedding array - only accept the proper format
  let embedding;
  
  if (Array.isArray(output) && output[0] && output[0].values instanceof Float32Array) {
    // Model returns the expected format directly
    embedding = Array.from(output[0].values);
  } else if (output && output.embedding && Array.isArray(output.embedding)) {
    // Output is from our Python service
    embedding = output.embedding;
  } else {
    // No fallbacks - if we don't get the expected format, throw an error
    throw new Error('CodeBERT returned unexpected output format');
  }

  // Ensure it's an array of numbers with the right dimension
  if (!Array.isArray(embedding)) {
    throw new Error('Invalid embedding format, not an array');
  }

  const numericEmbedding = embedding.map(val => Number(val));
  
  // Validate embedding dimension
  if (numericEmbedding.length !== EMBEDDING_DIMENSION) {
    throw new Error(`Embedding dimension mismatch: expected ${EMBEDDING_DIMENSION}, got ${numericEmbedding.length}`);
  }

  // Return as Float32Array for consistency with FAISS expectations
  return new Float32Array(numericEmbedding);
}

/**
 * Extract embedding from CodeBERT model output
 * @param {*} output - Raw output from the model
 * @returns {Float32Array} Processed embedding
 */
function extractEmbeddingFromOutput(output) {

  
  let embedding;
  
  // Handle response from Python service (direct array of numbers)
  if (typeof output === 'object' && output !== null) {
    if (Array.isArray(output)) {
      // Direct array - common from Python service
      embedding = output;
    } else if (output.embedding) {
      // Python service might return {embedding: [...]} format
      embedding = output.embedding;
    } else if (output.data) {
      // HF Transformers output format
      embedding = Array.isArray(output.data) ? output.data[0] : output.data;
    } else if (output[0] && Array.isArray(output[0])) {
      // Array of arrays format
      embedding = output[0];
    } else {
      // Unknown object format, try to extract numerics
      embedding = Object.values(output);
    }
  } else if (typeof output === 'string') {
    // Try to parse JSON string
    try {
      const parsed = JSON.parse(output);
      return extractEmbeddingFromOutput(parsed); // Recursive call with parsed JSON
    } catch (e) {
      console.error('Failed to parse embedding string:', e);
      throw new Error('Invalid embedding format: string that is not valid JSON');
    }
  } else {
    throw new Error(`Unsupported embedding type: ${typeof output}`);
  }
  

  
  // Handle nested arrays by flattening
  if (Array.isArray(embedding)) {
    // Deep flatten any nested arrays
    const flattened = embedding.flat(Infinity);
    
    // Ensure all values are numbers
    const numericValues = flattened.map(v => {
      // Convert string numbers to actual numbers
      if (typeof v === 'string' && !isNaN(Number(v))) {
        return Number(v);
      }
      // Keep actual numbers
      else if (typeof v === 'number') {
        return v;
      }
      // Other types get filtered out
      return null;
    }).filter(v => v !== null && isFinite(v)); // Also filter out NaN and Infinity
    
    if (numericValues.length === 0) {
      throw new Error('Embedding contains no numeric values after processing');
    }
    
    // Ensure correct dimension
    if (numericValues.length !== EMBEDDING_DIMENSION) {
      console.warn(`Extracted embedding dimension mismatch: expected ${EMBEDDING_DIMENSION}, got ${numericValues.length}`);
      if (numericValues.length < EMBEDDING_DIMENSION) {
        numericValues.push(...new Array(EMBEDDING_DIMENSION - numericValues.length).fill(0.1));
      } else {
        numericValues.splice(EMBEDDING_DIMENSION);
      }
    }
    

    return new Float32Array(numericValues); // Return Float32Array instead of regular array
  } else if (embedding instanceof Float32Array) {
    // Already in the right format, but validate dimension
    if (embedding.length !== EMBEDDING_DIMENSION) {
      console.warn(`Float32Array embedding dimension mismatch: expected ${EMBEDDING_DIMENSION}, got ${embedding.length}`);
      const corrected = new Float32Array(EMBEDDING_DIMENSION);
      const copyLength = Math.min(embedding.length, EMBEDDING_DIMENSION);
      corrected.set(embedding.subarray(0, copyLength));
      if (copyLength < EMBEDDING_DIMENSION) {
        corrected.fill(0.1, copyLength);
      }
      return corrected;
    }
    return embedding;
  } else {
    throw new Error(`Unsupported embedding format: ${typeof embedding}`);
  }
}

/**
 * Preprocess code specifically for CodeBERT/GraphCodeBERT
 * @param {string} code - Raw code string
 * @returns {string} Preprocessed code
 */
function preprocessCodeForCodeBERT(code) {
  // CodeBERT-specific preprocessing
  return code
    .replace(/\r\n/g, '\n')           // Normalize line endings
    .replace(/\t/g, '    ')           // Convert tabs to 4 spaces
    .replace(/\n\s*\n\s*\n/g, '\n\n') // Remove excessive blank lines (keep some structure)
    .replace(/^\s+|\s+$/g, '')        // Trim leading/trailing whitespace
    .trim();
}

/**
 * Generate embeddings for multiple code chunks in batches using CodeBERT
 * @param {Array<Object>} chunks - Array of chunk objects with content property
 * @returns {Promise<Array<Object>>} Chunks with added embedding property
 */
export async function batchGenerateEmbeddings(chunks) {
  try {
    // Ensure CodeBERT model is initialized
    const { model, modelType } = await initializeCodeModel();
    

    
    // Process in batches to avoid memory issues
    const results = [];
    
    for (let i = 0; i < chunks.length; i += BATCH_SIZE) {
      const batch = chunks.slice(i, i + BATCH_SIZE);
      
      // Process each chunk in the batch individually for better error handling
      for (const chunk of batch) {
        try {
          const embedding = await generateEmbedding(chunk.content);
          results.push({
            ...chunk,
            embedding: embedding,
            modelType: modelType,
            embeddingDim: EMBEDDING_DIMENSION
          });
        } catch (error) {
          console.error(`Error processing chunk from ${chunk.filePath || 'unknown'}:`, error.message);
          // Skip this chunk but continue with others
          results.push({
            ...chunk,
            embedding: null,
            error: error.message,
            modelType: modelType
          });
        }
      }
      
      // Progress tracking (silent)
      
      // Add a small delay to prevent overwhelming the system
      if (i + BATCH_SIZE < chunks.length) {
        await new Promise(resolve => setTimeout(resolve, 500));
      }
    }
    
    return results;
  } catch (error) {
    console.error('Error batch generating CodeBERT embeddings:', error);
    throw new Error(`Failed to batch generate CodeBERT embeddings: ${error.message}`);
  }
}

/**
 * Process a single file to generate CodeBERT embeddings for its chunks
 * @param {string} filePath - Path to the file
 * @param {Object} options - Chunking options
 * @returns {Promise<Array<Object>>} Chunks with embeddings
 */
export async function processFile(filePath, options = {}) {
  try {
    // Check if file exists and is readable
    if (!fs.existsSync(filePath)) {
      throw new Error(`File does not exist: ${filePath}`);
    }
    
    // Only process supported code files
    if (!isCodeFile(filePath)) {
      return [];
    }
    
    // Read file content
    const content = fs.readFileSync(filePath, 'utf-8');
    
    // Skip empty files
    if (!content.trim()) {
      return [];
    }
    
    // Get file extension for language-specific processing
    const fileExt = path.extname(filePath).toLowerCase();
    
    // Chunk the file
    const chunks = await chunkCodeFile(filePath, content, { 
      ...options,
      fileType: fileExt 
    });
    
    if (chunks.length === 0) {
      return [];
    }
    

    
    // Generate CodeBERT embeddings for chunks
    const chunksWithEmbeddings = await batchGenerateEmbeddings(chunks);
    
    // Filter out chunks with errors
    const validChunks = chunksWithEmbeddings.filter(chunk => chunk.embedding !== null);
    
    // Silent processing - no output during normal operation
    
    // Format embeddings for vector store
    return formatEmbeddingsForVectorStore(chunksWithEmbeddings);
  } catch (error) {
    console.error(`Error processing file ${filePath}:`, error);
    throw new Error(`Failed to process file ${filePath}: ${error.message}`);
  }
}

/**
 * Process multiple files to generate CodeBERT embeddings
 * @param {Array<string>} filePaths - Array of file paths
 * @param {Object} options - Processing options
 * @returns {Promise<Object>} Map of file paths to their chunks with embeddings
 */
export async function batchProcessFiles(filePaths, options = {}) {
  const results = {};
  let successCount = 0;
  let failCount = 0;
  
  // Initialize CodeBERT model once before processing all files
  const { modelType, modelName } = await initializeCodeModel(options.preferGraphCodeBERT, options.localModelPath);
  
  for (let i = 0; i < filePaths.length; i++) {
    const filePath = filePaths[i];
    try {
      results[filePath] = await processFile(filePath, options);
      successCount++;
    } catch (error) {
      console.error(`Skipping file ${filePath} due to error:`, error.message);
      failCount++;
      // Continue processing other files
    }
  }
  
  // Batch processing complete - silent operation
  return results;
}

/**
 * Check if a file is a code file suitable for CodeBERT
 * @param {string} filePath - Path to the file
 * @returns {boolean} Whether the file is a code file
 */
function isCodeFile(filePath) {
  const codeExtensions = [
    '.js', '.jsx', '.ts', '.tsx', // JavaScript/TypeScript
    '.py',                        // Python
    '.java',                      // Java
    '.c', '.cpp', '.cc', '.cxx', '.h', '.hpp', // C/C++
    '.go',                        // Go
    '.rb',                        // Ruby
    '.php',                       // PHP
    '.cs',                        // C#
    '.scala',                     // Scala
    '.swift',                     // Swift
    '.rs',                        // Rust
    '.kt', '.kts',                // Kotlin
    '.sh', '.bash',               // Shell scripts
    '.sql',                       // SQL
  ];
  
  const ext = path.extname(filePath).toLowerCase();
  return codeExtensions.includes(ext);
}

/**
 * Get current embedding dimension (always 768 for CodeBERT/GraphCodeBERT)
 * @returns {number} The dimension of the embeddings
 */
export function getEmbeddingDimension() {
  return EMBEDDING_DIMENSION;
}

/**
 * Check if a file is supported for code embedding
 * @param {string} filePath - Path to the file
 * @returns {boolean} Whether the file is supported
 */
export function isFileSupported(filePath) {
  return isCodeFile(filePath);
}

/**
 * Get current model information
 * @returns {Object} Information about the currently loaded CodeBERT model
 */
export function getModelInfo() {
  return {
    modelName: currentModel || 'xenova/codebert-base',
    modelType: modelType || 'codebert',
    isInitialized: embeddingModel !== null,
    embeddingDimension: EMBEDDING_DIMENSION,
    maxLength: MAX_LENGTH,
    batchSize: BATCH_SIZE,
    supportedModels: ['xenova/codebert-base']
  };
}

/**
 * Clear model cache and force reinitialization
 */
export function clearModelCache() {
  embeddingModel = null;
  currentModel = null;
  modelType = null;
  console.log('CodeBERT model cache cleared');
}

/**
 * Initialize with specific preference for GraphCodeBERT
 * @param {string} localModelPath - Optional local path to model files
 * @returns {Promise<Object>} The initialized GraphCodeBERT model
 */
export async function initializeGraphCodeBERT(localModelPath = null) {
  return await initializeCodeModel(true, localModelPath);
}

/**
 * Initialize with specific preference for CodeBERT
 * @param {string} localModelPath - Optional local path to model files
 * @returns {Promise<Object>} The initialized CodeBERT model
 */
export async function initializeCodeBERT(localModelPath = null) {
  return await initializeCodeModel(false, localModelPath);
}

/**
 * Convert embedding to the format expected by vector stores
 * @param {Float32Array|Array} embedding - The embedding vector
 * @returns {Float32Array} Float32Array for FAISS compatibility
 */
export function formatEmbeddingForVectorStore(embedding) {
  // Handle null or undefined embeddings with a default array
  if (!embedding) {
    console.warn('Received null or undefined embedding, using zero vector');
    return new Float32Array(new Array(EMBEDDING_DIMENSION).fill(0));
  }
  
  // Handle the case where embedding is an object with values property (from transformers.js)
  if (embedding && typeof embedding === 'object' && embedding.values instanceof Float32Array) {
    return embedding.values; // Return the Float32Array directly
  }
  
  // Handle direct Float32Array - this is now the expected format from generateEmbedding
  if (embedding instanceof Float32Array) {
    // Validate dimension
    if (embedding.length !== EMBEDDING_DIMENSION) {
      console.warn(`Embedding dimension mismatch in formatEmbeddingForVectorStore: expected ${EMBEDDING_DIMENSION}, got ${embedding.length}`);
      // Create a properly sized Float32Array
      const corrected = new Float32Array(EMBEDDING_DIMENSION);
      const copyLength = Math.min(embedding.length, EMBEDDING_DIMENSION);
      corrected.set(embedding.subarray(0, copyLength));
      // Fill remaining with zeros if needed
      if (copyLength < EMBEDDING_DIMENSION) {
        corrected.fill(0, copyLength);
      }
      return corrected;
    }
    return embedding; // Return the Float32Array directly
  } 
  
  // Handle regular arrays (legacy support)
  if (Array.isArray(embedding)) {
    // Ensure we have a flat array of numbers
    const flattened = embedding.flat(Infinity).filter(x => typeof x === 'number' && !isNaN(x));
    
    // If after flattening we have an empty array, return zero vector
    if (flattened.length === 0) {
      console.warn('Embedding flattened to empty array, using zero vector');
      return new Float32Array(new Array(EMBEDDING_DIMENSION).fill(0));
    }
    
    // Ensure correct dimension
    if (flattened.length !== EMBEDDING_DIMENSION) {
      console.warn(`Array embedding dimension mismatch: expected ${EMBEDDING_DIMENSION}, got ${flattened.length}`);
      // Pad or truncate to correct dimension
      if (flattened.length < EMBEDDING_DIMENSION) {
        flattened.push(...new Array(EMBEDDING_DIMENSION - flattened.length).fill(0));
      } else {
        flattened.splice(EMBEDDING_DIMENSION);
      }
    }
    
    // Return as Float32Array - this is what FAISS expects
    return new Float32Array(flattened);
  }
  
  // Fallback for other types
  console.warn(`Invalid embedding format: ${typeof embedding}, using zero vector`);
  return new Float32Array(new Array(EMBEDDING_DIMENSION).fill(0));
}

/**
 * Process embeddings to ensure they're compatible with vector stores
 * @param {Array<Object>} chunksWithEmbeddings - Chunks with embedding property
 * @returns {Array<Object>} Chunks with properly formatted embeddings
 */
export function formatEmbeddingsForVectorStore(chunksWithEmbeddings) {
  return chunksWithEmbeddings.map(chunk => {
    if (chunk.embedding) {
      return {
        ...chunk,
        embedding: formatEmbeddingForVectorStore(chunk.embedding)
      };
    }
    return chunk;
  });
}

/**
 * Test CodeBERT model initialization and embedding generation
 * @returns {Promise<Object>} Test results
 */
export async function testCodeBERTModel() {
  try {
    console.log('Testing CodeBERT model initialization...');
    const { modelName, modelType, embeddingDim } = await initializeCodeModel();
    
    console.log('Testing CodeBERT embedding generation...');
    const testCode = `function fibonacci(n) {
  if (n <= 1) return n;
  return fibonacci(n - 1) + fibonacci(n - 2);
}`;
    
    const embedding = await generateEmbedding(testCode);
    const formattedEmbedding = formatEmbeddingForVectorStore(embedding);
    
    return {
      success: true,
      modelName,
      modelType,
      embeddingDim,
      embeddingLength: embedding.length,
      formattedLength: formattedEmbedding.length,
      sampleEmbedding: formattedEmbedding.slice(0, 5), // First 5 values
      isValidArray: Array.isArray(formattedEmbedding),
      allNumbers: formattedEmbedding.every(x => typeof x === 'number'),
      isCodeBERTModel: modelType === 'codebert' || modelType === 'graphcodebert'
    };
  } catch (error) {
    return {
      success: false,
      error: error.message
    };
  }
}

/**
 * Validate that embeddings are proper arrays for vector store
 * @param {Array<Object>} chunksWithEmbeddings - Chunks with embeddings
 * @returns {Object} Validation results
 */
export function validateEmbeddings(chunksWithEmbeddings) {
  const results = {
    totalChunks: chunksWithEmbeddings.length,
    validEmbeddings: 0,
    invalidEmbeddings: 0,
    errors: []
  };
  
  for (const chunk of chunksWithEmbeddings) {
    if (chunk.embedding) {
      try {
        const formatted = formatEmbeddingForVectorStore(chunk.embedding);
        if (Array.isArray(formatted) && formatted.length === EMBEDDING_DIMENSION && 
            formatted.every(x => typeof x === 'number' && !isNaN(x))) {
          results.validEmbeddings++;
        } else {
          results.invalidEmbeddings++;
          results.errors.push(`Invalid embedding format in chunk: ${chunk.id || 'unknown'}`);
        }
      } catch (error) {
        results.invalidEmbeddings++;
        results.errors.push(`Error validating embedding: ${error.message}`);
      }
    } else {
      results.invalidEmbeddings++;
      results.errors.push(`Missing embedding in chunk: ${chunk.id || 'unknown'}`);
    }
  }
  
  return results;
}