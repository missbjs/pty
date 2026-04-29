# TUI Framework Reference

Detailed debugging guides for each major TUI framework.

## Ratatui (Rust)

### Setup pattern
```rust
use ratatui::{prelude::*, widgets::*};
use crossterm::{
    event::{self, Event, KeyCode},
    execute,
    terminal::{enable_raw_mode, disable_raw_mode, EnterAlternateScreen, LeaveAlternateScreen},
};

fn main() -> Result<()> {
    enable_raw_mode()?;
    execute!(stdout(), EnterAlternateScreen)?;
    let mut terminal = Terminal::new(CrosstermBackend::new(stdout()))?;

    loop {
        terminal.draw(|frame| {
            frame.render_widget(..., frame.size());
        })?;
        if let Event::Key(key) = event::read()? {
            if key.code == KeyCode::Char('q') { break; }
        }
    }

    execute!(stdout(), LeaveAlternateScreen)?;
    disable_raw_mode()?;
    Ok(())
}
```

### Common bugs
- **Panic leaves terminal broken**: Always use `disable_raw_mode()` in cleanup. Use `ctrlc::set_handler` or `Drop` guard.
- **Flicker on every frame**: Call `terminal.clear()` unnecessarily. Remove it — Ratatui does dirty tracking.
- **Mouse clicks offset by 1**: Ratatui uses 0-based coordinates. Check your click handler math.
- **Wide characters break layout**: Use `UnicodeWidthStr::width()` not `.len()` for string width.

### Debug commands
```bash
# Run with panic hook that restores terminal
RUST_BACKTRACE=1 cargo run

# Test in minimal PTY
script -q /dev/null -c "cargo run"
```

## Bubbletea (Go)

### Setup pattern
```go
package main

import (
    "fmt"
    "os"
    tea "github.com/charmbracelet/bubbletea"
)

type model struct { count int }

func (m model) Init() tea.Cmd { return nil }
func (m model) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
    switch msg := msg.(type) {
    case tea.KeyMsg:
        switch msg.String() {
        case "q", "ctrl+c": return m, tea.Quit
        }
    }
    return m, nil
}
func (m model) View() string { return fmt.Sprintf("Count: %d\n", m.count) }

func main() {
    p := tea.NewProgram(model{})
    if _, err := p.Run(); err != nil {
        fmt.Fprintf(os.Stderr, "Error: %v\n", err)
        os.Exit(1)
    }
}
```

### Common bugs
- **View() called too frequently**: Bubbletea calls View on every event. Use `tea.Batch` for timed updates.
- **Goroutine leaks**: Long-running `tea.Cmd` functions. Cancel via context or check shutdown signals.
- **Input stuck**: `tea.KeyMsg` vs `tea.ClipboardMsg` confusion. Check message types in `Update`.
- **ANSI rendering broken**: Use `lipgloss` or `renderer` — don't write raw escapes in `View()`.

### Debug commands
```bash
# Enable debug logging
BUBBLETEA_DEBUG=1 go run .

# Test without PTY (for CI)
go run . 2>&1 | cat  # Will fail — needs TTY
```

## Textual (Python)

### Setup pattern
```python
from textual.app import App, ComposeResult
from textual.widgets import Static, Input, Button

class MyApp(App):
    def compose(self) -> ComposeResult:
        yield Static("Hello!")
        yield Input(id="input")
        yield Button("Submit")

    def on_button_pressed(self) -> None:
        input = self.query_one("#input", Input)
        self.notify(input.value)

if __name__ == "__main__":
    MyApp().run()
```

### Common bugs
- **Widget not updating**: Forgot to call `self.refresh()` or use reactive bindings properly.
- **Layout broken on resize**: Use CSS flex/grid, not fixed positions. Textual handles resize automatically.
- **Key events not received**: Check `on_key` vs `on_input_submitted` — different event types.
- **Console printing doesn't work**: Use `self.notify()` or `self.print()`, not `print()`.

### Debug commands
```bash
# Textual devtools (separate terminal)
textual console     # Start dev console
textual run ./app.py  # Run app connected to console

# Run with debug logging
TEXTUAL_LOG=trace textual run ./app.py

# Check CSS compilation
textual css --watch ./app.tcss
```

## Ink (TypeScript/React)

### Setup pattern
```tsx
import React from 'react';
import {render, Text, useApp, useInput, Box} from 'ink';

function Counter() {
    const [count, setCount] = React.useState(0);
    useInput((input) => {
        if (input === 'q') process.exit(0);
        if (input === 'i') setCount(c => c + 1);
    });
    return <Text>Count: {count}</Text>;
}

render(<Counter />);
```

### Common bugs
- **`useInput` not firing**: Not in a React component context, or stdin piped.
- **Rerender loop**: State update in render body. Move to `useEffect`.
- **Output duplicated**: Multiple `render()` calls. Only render once.
- **ANSI in output**: Use `<Text>` component, not `console.log`.

### Debug commands
```bash
# Debug React re-renders
DEBUG=ink node dist/cli.js

# Test in CI (no TTY)
CI=true node dist/cli.js
```

## ncurses (C/C++)

### Setup pattern
```c
#include <ncurses.h>

int main() {
    initscr();
    cbreak();
    noecho();
    keypad(stdscr, TRUE);
    curs_set(0);  // hide cursor

    int ch = getch();
    mvprintw(0, 0, "Got: %d", ch);
    refresh();

    endwin();  // MUST call before exit
    return 0;
}
```

### Common bugs
- **Terminal broken after crash**: Forgot `endwin()`. Run `reset`. Use `atexit(endwin)`.
- **`getch()` returns -1**: No input available. Check `nodelay()` or `timeout()` settings.
- **Screen not updating**: Forgot `refresh()` after `printw()`/`mvprintw()`.
- **Wide chars garbled**: Compile with `-lncursesw`, use `setlocale(LC_ALL, "")`.

### Debug commands
```bash
# Compile with wide char support
gcc -o app app.c -lncursesw

# Check ncurses trace
export TRACE=1  # Some implementations support this
```

## General TTY Configuration

### Raw mode requirements
For a functional TUI, these terminal flags must be set:
- **Disable ICANON**: Line buffering off (character-at-a-time)
- **Disable ECHO**: Don't echo input
- **Disable ISIG**: Handle Ctrl+C yourself
- **Enable BRKINT**: Break signal handling

### Signal handling
TUI apps must handle:
- **SIGWINCH**: Terminal resized — update layout
- **SIGINT**: Ctrl+C — cleanup raw mode, then exit
- **SIGTERM**: Killed — cleanup raw mode
- **SIGHUP**: Terminal disconnected — cleanup

### Mouse encoding modes
| Mode | Escape | Reports |
|------|--------|---------|
| X10 | `\e[?9h` | Click only, 0-223 range |
| 256 | `\e[?1000h` | Click + release |
| Cell motion | `\e[?1002h` | Click + drag |
| Any motion | `\e[?1003h` | All mouse movement |
| SGR extended | `\e[?1006h` | Clicks > 223 coords |

Always pair enable with disable on exit: `\e[?1003l\e[?1006l`.
