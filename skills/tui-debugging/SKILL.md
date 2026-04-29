---
name: tui-debugging
description: Debug terminal user interface (TUI) applications across all frameworks. Detects TUI frameworks (Ratatui, Bubbletea, Textual, Ink, ncurses, blessed), diagnoses rendering issues, terminal compatibility problems, input/keyboard event bugs, PTY/TTY configuration errors, and alt-screen issues. Use when debugging TUI apps, terminal UI bugs, keyboard input problems, ncurses/ratatui/bubbletea/textual/ink issues, escape sequences, raw mode, or terminal rendering bugs.
---

# TUI Debugging

Diagnose and fix terminal user interface bugs across all major TUI frameworks.

## Framework Detection

Identify the TUI framework before debugging:

1. **Check dependencies**: `package.json`, `Cargo.toml`, `go.mod`, `requirements.txt`
2. **Check imports**: Look for framework-specific imports
3. **Check project structure**: Frameworks have characteristic layouts

| Framework | Language | Key imports/files |
|-----------|----------|-------------------|
| Ratatui | Rust | `ratatui`, `crossterm`, `termion` |
| Bubbletea | Go | `charmbracelet/bubbletea` |
| Textual | Python | `textual`, `rich` |
| Ink | TypeScript | `ink`, `react` |
| ncurses | C/C++ | `ncurses.h`, `notcurses` |
| Blessed | Node.js | `blessed`, `blessed-contrib` |

## Common TUI Bug Categories

### 1. Terminal Mode Issues
- **Raw mode not enabled**: Input shows echo, special keys don't work
- **Raw mode not restored**: Terminal left broken after crash (run `reset`)
- **Alt screen**: Content persists after exit, or content lost on entry
- **Bracketed paste**: Paste inserts literal `^[[200~` sequences

### 2. Rendering Bugs
- **Screen corruption**: Overlapping text, missing characters
- **Dirty region tracking**: Only part of screen updates
- **Size changes**: Terminal resize breaks layout (`SIGWINCH` handling)
- **Flicker**: Full redraw instead of incremental update
- **Off-by-one**: Cursor positioning errors, wrap-around issues

### 3. Input/Keyboard Bugs
- **Arrow keys send `^[OA`, `^[OB`**: Not in raw mode or wrong terminfo
- **Ctrl+letter not working**: Terminal eating the binding
- **Mouse events broken**: Mouse reporting not enabled
- **Super/Cmd keys invisible**: Only works with kitty keyboard protocol
- **Backspace vs Delete**: `^H` vs `^?` terminfo mismatch

### 4. Terminal Compatibility
- **tmux/screen**: Nested terminal breaks escape sequences
- **Windows Console**: Legacy console vs ConPTY differences
- **SSH sessions**: TERM variable mismatch between client/server
- **Color support**: 16-color vs 256-color vs truecolor (24-bit)

## Debugging Workflow

Copy this checklist and track progress:

```
TUI Debug Progress:
- [ ] Identify framework and version
- [ ] Reproduce the bug
- [ ] Check terminal mode (raw/cooked, alt screen)
- [ ] Verify TERM env var matches actual terminal
- [ ] Test with minimal reproduction
- [ ] Check framework-specific known issues
```

### Step 1: Diagnose Terminal State

Run the detection script:
```bash
bash scripts/tty-detect.sh
```

This reports: terminal type, color support, raw mode status, alt screen, mouse reporting, bracketed paste, and kitty keyboard protocol support.

### Step 2: Test Escape Sequences

```bash
bash scripts/escape-test.sh
```

Tests cursor positioning, colors, mouse reporting, and key event encoding.

### Step 3: Check Render Pipeline

For Python TUI apps:
```bash
python scripts/render-check.py <app-name-or-pid>
```

Validates render loop timing, screen buffer consistency, and event queue depth.

## Quick Fixes by Symptom

| Symptom | Likely cause | Fix |
|---------|-------------|-----|
| Terminal broken after crash | Raw mode not restored | Run `reset` or `stty sane` |
| Arrow keys show `^[[A` | Not parsing escape sequences | Enable raw mode, check key parser |
| Colors wrong/washed out | TERM mismatch or 16-color fallback | Set `TERM=xterm-256color` |
| Screen flickers | Full redraw every frame | Use incremental/dirty rendering |
| Resize breaks layout | No `SIGWINCH` handler | Subscribe to resize events |
| Input lag | Synchronous render blocking | Decouple input from render loop |
| Mouse clicks wrong position | Off-by-one in coordinate parsing | Check 1-based vs 0-based indexing |
| Text wraps mid-word | Missing line wrapping handling | Enable terminal line wrap or handle manually |

## Escape Sequence Reference

Common sequences for debugging:

```
Cursor:  \e[<row>;<col>H     Move cursor
Clear:   \e[2J              Clear screen
Hide:    \e[?25l            Hide cursor
Show:    \e[?25h            Show cursor
Alt On:  \e[?1049h          Enter alt screen
Alt Off: \e[?1049l          Exit alt screen
Raw On:  \e[?2004h          Enable bracketed paste
Mouse:   \e[?1003h          Enable mouse tracking
Color:   \e[38;2;R;G;Bm     Truecolor foreground
Reset:   \e[0m              Reset all attributes
```

## Framework-Specific Guides

For detailed framework-specific debugging, see [reference.md](reference.md).

## Headless/CI Testing

TUI apps need a PTY. In CI environments:

```bash
# Use script/pty-run to allocate a PTY
script -q /dev/null -c "your-tui-app"

# Or use unbuffer (expect package)
unbuffer your-tui-app

# Or allocate PTY explicitly
python -c "import pty,os; pty.spawn(['your-tui-app'])"
```

Use `--no-tui` or `--plain` flags if the app supports them for non-interactive output.
