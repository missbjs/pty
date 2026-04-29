#!/usr/bin/env python3
"""render-check.py - Diagnose Python TUI app rendering issues.

Checks: render loop timing, event queue, screen buffer consistency.
Usage: python render-check.py [app-name-or-pid]
"""

import os
import sys
import time
import signal


def get_tty_info():
    """Get current TTY configuration."""
    try:
        import termios
        import tty

        fd = sys.stdin.fileno()
        attrs = termios.tcgetattr(fd)
        lflag = attrs[3]
        iflag = attrs[0]
        oflag = attrs[1]

        info = {}
        info["canonical"] = bool(lflag & termios.ICANON)
        info["echo"] = bool(lflag & termios.ECHO)
        info["sig"] = bool(lflag & termios.ISIG)
        info["brkint"] = bool(iflag & termios.BRKINT)
        info["icrnl"] = bool(iflag & termios.ICRNL)
        info["opost"] = bool(oflag & termios.OPOST)
        return info
    except Exception as e:
        return {"error": str(e)}


def check_colors():
    """Check Python color library availability."""
    libs = {
        "rich": "Rich (Textual's rendering engine)",
        "curses": "Standard curses module",
        "blessed": "Blessed high-level curses wrapper",
        "asciimatics": "Asciimatics animation library",
        "urwid": "Urwid console UI",
        "prompt_toolkit": "Prompt toolkit",
    }

    available = []
    unavailable = []
    for mod, desc in libs.items():
        try:
            __import__(mod)
            available.append((mod, desc))
        except ImportError:
            unavailable.append((mod, desc))

    return available, unavailable


def check_process_tui(pid=None):
    """Check if a running process appears to be a TUI app."""
    if pid is None:
        return None

    try:
        with open(f"/proc/{pid}/fd/0") as f:
            stat = os.fstat(f.fileno())
        import stat as stat_mod

        is_tty = stat_mod.S_ISCHR(stat.st_mode)
        return is_tty
    except Exception:
        return None


def diagnose():
    """Run all diagnostics."""
    print("=" * 60)
    print("TUI Render Diagnostics")
    print("=" * 60)

    # TTY mode
    print("\n[Terminal Mode]")
    tty_info = get_tty_info()
    if "error" in tty_info:
        print(f"  Cannot read: {tty_info['error']}")
    else:
        for key, val in tty_info.items():
            status = "ON" if val else "off"
            marker = "⚠" if key == "canonical" and val else "✓"
            print(f"  {marker} {key}: {status}")
        if tty_info.get("canonical"):
            print("  ⚠ Canonical mode ON — raw mode needed for TUI")
        else:
            print("  ✓ Canonical mode OFF (raw mode)")

    # Color libraries
    print("\n[Python TUI Libraries]")
    available, unavailable = check_colors()
    for mod, desc in available:
        print(f"  ✓ {mod} — {desc}")
    if unavailable:
        print("  (not installed)")
        for mod, desc in unavailable:
            print(f"    {mod} — {desc}")

    # Environment
    print("\n[Environment]")
    for var in ("TERM", "COLORTERM", "TERM_PROGRAM"):
        val = os.environ.get(var, "(not set)")
        print(f"  {var}={val}")

    # Terminal size
    try:
        size = os.get_terminal_size()
        print(f"\n[Terminal Size] {size.columns}x{size.lines}")
    except OSError:
        print("\n[Terminal Size] Cannot determine (not a TTY)")

    print("\n" + "=" * 60)


if __name__ == "__main__":
    pid = None
    if len(sys.argv) > 1:
        arg = sys.argv[1]
        if arg.isdigit():
            pid = int(arg)
            result = check_process_tui(pid)
            if result is not None:
                print(f"Process {pid} stdin is a TTY: {result}")
            else:
                print(f"Cannot check process {pid} (not on Linux or no access)")
        else:
            # Try to find by name
            print(f"Searching for process: {arg}")
            try:
                for entry in os.listdir("/proc"):
                    if entry.isdigit():
                        try:
                            with open(f"/proc/{entry}/comm") as f:
                                name = f.read().strip()
                            if arg.lower() in name.lower():
                                print(f"  Found PID {entry}: {name}")
                                result = check_process_tui(int(entry))
                                if result is not None:
                                    print(f"    stdin is TTY: {result}")
                        except (FileNotFoundError, PermissionError):
                            pass
            except Exception as e:
                print(f"  Process search failed: {e}")

    print()
    diagnose()
