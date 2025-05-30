# Real-time Terminal Logging

## Overview

The enhanced terminal logging system now supports capturing output from long-running processes like development servers, including proper handling of Ctrl+C interruptions. This solves the original limitation where commands like `npm start` or `python manage.py runserver` couldn't be logged.

## How It Works

### 1. Automatic Command Detection

The system automatically detects common long-running commands and wraps them with real-time logging:

**Supported Commands:**
- `npm start`, `npm dev`, `npm serve`, `npm run dev`
- `yarn start`, `yarn dev`, `yarn serve`
- `pnpm start`, `pnpm dev`, `pnpm serve`, `pnpm run dev`
- `python manage.py runserver` (Django)
- `node server.js` (or any node command with "server")
- `rails server`, `rails s`
- `bundle exec rails server`
- `php artisan serve` (Laravel)

### 2. Real-time Output Capture

When a long-running command is detected, the system:

1. **Creates a session log** with unique ID
2. **Sets up a named pipe (FIFO)** for real-time communication
3. **Redirects command output** to the pipe
4. **Monitors the pipe** in the background to capture all output
5. **Handles Ctrl+C interruptions** gracefully
6. **Merges the session log** to the main terminal log when complete

### 3. Signal Handling

The system properly handles interruptions:
- **Ctrl+C detection**: Captures the interruption event
- **Graceful cleanup**: Ensures logs are saved even when interrupted
- **Exit status tracking**: Records proper exit codes (130 for Ctrl+C)

## Usage

### Automatic (Recommended)

Simply run your commands normally after enabling terminal logging:

```bash
# These will be automatically wrapped with real-time logging
npm start
yarn dev
python manage.py runserver
rails server
```

### Manual Wrapping

For commands not automatically detected, use the `cloi-wrap` utility:

```bash
# Wrap any command with real-time logging
cloi-wrap your-custom-server
cloi-wrap docker run -it myapp
cloi-wrap tail -f logfile.log
```

## Log Format

Real-time captured logs include additional metadata:

```
===================================================
[2024-01-15 10:30:45] COMMAND: npm start
[2024-01-15 10:30:45] DIRECTORY: /path/to/project
[2024-01-15 10:30:45] SESSION: 1705312245_12345
[2024-01-15 10:30:45] REAL-TIME CAPTURE: ENABLED
[2024-01-15 10:30:45] OUTPUT BEGINS BELOW:
---------------------------------------------------
> myapp@1.0.0 start
> node server.js

Server running on port 3000...
[2024-01-15 10:32:15] === INTERRUPTED BY USER (Ctrl+C) ===
---------------------------------------------------
[2024-01-15 10:32:15] EXIT STATUS: 130
[2024-01-15 10:32:15] SESSION ENDED
===================================================
```

## Error Detection

The system now detects errors in interrupted commands:

1. **Interrupted commands** (Ctrl+C) are automatically flagged as potential errors
2. **Runtime errors** in long-running processes are captured in real-time
3. **File references** in error messages are extracted for context

## Technical Implementation

### Named Pipes (FIFO)

The system uses named pipes for real-time communication:

```bash
# Creates: ~/.cloi/fifo_<session_id>
mkfifo ~/.cloi/fifo_1705312245_12345
```

### Process Redirection

Output redirection is handled at the shell level:

```bash
# Redirect stdout/stderr to the named pipe
exec 1>fifo_path 2>&1
eval "your-command"
exec 1>&3 2>&4  # Restore original streams
```

### Background Monitoring

A background process monitors the pipe:

```bash
while IFS= read -r line; do
  printf "%s\n" "$line" >> session.log
done < fifo_path &
```

## Fallback Mechanisms

If advanced features fail, the system falls back to:

1. **Simple tee-based capture**: `command 2>&1 | tee -a logfile`
2. **Traditional re-execution**: For short commands (existing behavior)
3. **Detection-only logging**: Records that a long-running command was detected

## Benefits

1. **Complete Coverage**: Captures output from any type of command
2. **Real-time Logging**: No delay between command output and logging
3. **Interruption Handling**: Properly captures Ctrl+C events
4. **Backward Compatibility**: Existing short-command logging unchanged
5. **Automatic Detection**: No user intervention required for common commands
6. **Manual Override**: `cloi-wrap` for edge cases

## Troubleshooting

### Quick Test

To verify real-time logging is working, run this test command:

```bash
# Test if function override is active
type python

# You should see the custom function definition, not just a path
# If you see a path like "/usr/bin/python", the override isn't loaded

# Test the capture with a simple command
cloi-wrap echo "This is a test"

# Check if it was logged
tail -20 ~/.cloi/terminal_output.log
```

### If real-time logging isn't working:

1. **Restart your terminal completely** (close and reopen the terminal app)

2. **Or reload your zshrc manually**:
   ```bash
   source ~/.zshrc
   ```

3. **Check if terminal logging is enabled**:
   ```bash
   grep "_cloi_" ~/.zshrc
   ```

4. **Verify the python function is loaded**:
   ```bash
   type python
   # Should show a function definition, not a path
   ```

5. **Use manual wrapping** for problematic commands:
   ```bash
   cloi-wrap python manage.py runserver 5050
   ```

6. **Check log permissions**:
   ```bash
   ls -la ~/.cloi/
   touch ~/.cloi/test.log && rm ~/.cloi/test.log
   ```

### Common Issues:

- **Function not loaded**: Terminal logging setup needs to be run and terminal restarted
- **Permission errors**: Ensure ~/.cloi directory is writable
- **Command not detected**: The pattern matching might need adjustment
- **No output in logs**: Command might be using a different output method
- **"suspended (tty output)" error**: This was caused by the `script` command running in background - fixed in latest version
- **Background job creation**: If you see `[6] 54677` type messages, kill with `jobs` then `kill %1` (or relevant job number)

## Future Enhancements

Potential improvements:
- **WebSocket monitoring**: For web-based development servers
- **Log streaming**: Real-time log viewing in CLOI interface
- **Custom patterns**: User-defined long-running command patterns
- **Performance monitoring**: Resource usage tracking during capture 