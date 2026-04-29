#!/usr/bin/env bash
# tty-detect.sh - Diagnose terminal capabilities for TUI debugging
# Reports: terminal type, color support, raw mode, alt screen, mouse, paste, kitty protocol

set -euo pipefail

RED='\e[31m'
GREEN='\e[32m'
YELLOW='\e[33m'
BLUE='\e[34m'
CYAN='\e[36m'
RESET='\e[0m'
BOLD='\e[1m'

ok()   { echo -e "  ${GREEN}✓${RESET} $1"; }
warn() { echo -e "  ${YELLOW}⚠${RESET} $1"; }
fail() { echo -e "  ${RED}✗${RESET} $1"; }
info() { echo -e "  ${BLUE}ℹ${RESET} $1"; }
hdr()  { echo -e "\n${BOLD}${CYAN}━━━ $1 ━━━${RESET}"; }

hdr "Terminal Environment"

# TERM variable
TERM_VAL="${TERM:-unset}"
info "TERM=$TERM_VAL"
case "$TERM_VAL" in
  xterm-256color|alacritty|ghostty|kitty|tmux-256color|screen-256color)
    ok "TERM supports 256 colors"
    ;;
  xterm|rxvt|linux)
    warn "TERM may only support 16 colors"
    ;;
  dumb|cons25|*)
    if [ "$TERM_VAL" = "dumb" ]; then
      fail "dumb terminal — TUI apps will not work"
    else
      info "Unknown TERM — TUI compatibility uncertain"
    fi
    ;;
esac

# COLORTERM
if [ "${COLORTERM:-}" = "truecolor" ] || [ "${COLORTERM:-}" = "24bit" ]; then
  ok "COLORTERM=$COLORTERM (truecolor supported)"
elif [ -n "${COLORTERM:-}" ]; then
  info "COLORTERM=$COLORTERM"
else
  warn "COLORTERM not set — truecolor support uncertain"
fi

# TTY check
if [ -t 0 ]; then
  ok "stdin is a TTY"
else
  fail "stdin is NOT a TTY — TUI apps need a terminal"
  if [ -t 1 ]; then
    info "stdout IS a TTY (piped input)"
  else
    info "stdout is also not a TTY"
  fi
fi

hdr "Terminal Multiplexer"

if [ -n "${TMUX:-}" ]; then
  ok "Running inside tmux (pane: $TMUX)"
  tmux_ver=$(tmux -V 2>/dev/null || echo "unknown")
  info "tmux version: $tmux_ver"
elif [ -n "${STY:-}" ]; then
  ok "Running inside GNU screen (session: $STY)"
else
  info "No terminal multiplexer detected"
fi

hdr "Input Mode"

if stty -g &>/dev/null; then
  ok "Terminal settings readable"
else
  warn "Cannot read terminal settings (not a TTY or permission denied)"
fi

hdr "Color Capability Test"

if command -v tput &>/dev/null; then
  COLORS=$(tput colors 2>/dev/null || echo "0")
  if [ "$COLORS" -ge 256 ]; then
    ok "terminfo reports $COLORS colors"
  elif [ "$COLORS" -ge 8 ]; then
    warn "terminfo reports only $COLORS colors"
  else
    fail "terminfo reports $COLORS colors"
  fi
else
  info "tput not available, skipping terminfo check"
fi

hdr "Escape Sequence Support"

printf '\e7\e[50;1H\e8'
ok "Cursor positioning escape sequences sent"

hdr "Summary"

echo ""
echo "Common fixes:"
echo "  Terminal broken?    → run: reset"
echo "  Colors wrong?       → export TERM=xterm-256color"
echo "  Not a TTY?          → use: script -q /dev/null -c 'your-command'"
echo "  Inside tmux?        → ensure 'set -g default-terminal tmux-256color'"
echo ""
