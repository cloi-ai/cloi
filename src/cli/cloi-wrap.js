#!/usr/bin/env node

/**
 * CLOI Command Wrapper CLI
 * 
 * A standalone utility that wraps any command with real-time logging.
 * This is useful for capturing output from long-running processes that
 * the automatic terminal logger might miss.
 * 
 * Usage: cloi-wrap <command> [args...]
 */

import { cliWrapper } from '../utils/realtimeLogger.js';

// Execute the CLI wrapper
cliWrapper(); 