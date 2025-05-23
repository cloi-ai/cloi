#!/usr/bin/env node
/* ----------------------------------------------------------------------------
 *  CLOI — Secure Agentic Debugger                                         v1.3.0
 *  ----------------------------------------------------------------------------
 *  PURPOSE  ▸  Local helper to re‑run shell commands, capture & pretty‑print
 *              their output, and (on errors) feed that output to a local
 *              Llama‑3 model for analysis.
 *
 * ----------------------------------------------------------------------------*/

// This file is just a wrapper that loads the modular implementation
import '../src/cli/index.js';
