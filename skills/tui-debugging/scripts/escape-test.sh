#!/usr/bin/env bash
# escape-test.sh - Test terminal escape sequence support
# Tests: cursor, colors, mouse, key encoding, alt screen

set -euo pipefail

GREEN='\e[32m'
YELLOW='\e[33m'
BLUE='\e[34m'
RESET='\e[0m'
BOLD='\e[1m'

ok()   { echo -e "  ${GREEN}✓${RESET} $1"; }
warn() { echo -e "  ${YELLOW}⚠${RESET} $1"; }
info() { echo -e "  ${BLUE}ℹ${RESET} $1"; }
hdr()  { echo -e "\n${BOLD}$1${RESET}"; }

hdr "━━━ Escape Sequence Test ━━━"
echo ""
echo "Each test sends an escape sequence. Observe terminal output."
echo "Press Ctrl+C to stop early."
echo ""

# Test 1: Cursor positioning
hdr "Test 1: Cursor Positioning"
echo "Moving cursor to row 10, col 1..."
sleep 0.5
printf '\e[10;1H'
echo -e "${GREEN}If cursor moved to line 10, positioning works.${RESET}"
sleep 1
printf '\e[1;1H'  # return to top

# Test 2: Colors
hdr "Test 2: Color Support"
echo "Printing 256-color gradient..."
for i in $(seq 0 21 255); do
  printf "\e[38;5;${i}m█"
done
echo -e "${RESET}"
echo "If you see a color gradient (not just one color), 256-color works."
sleep 1

# Test 3: Truecolor
hdr "Test 3: Truecolor (24-bit)"
echo "Printing truecolor gradient..."
for i in $(seq 0 10 255); do
  printf "\e[38;2;${i};$((255-i));128m█"
done
echo -e "${RESET}"
echo "If colors change smoothly, truecolor works."
sleep 1

# Test 4: Alt screen
hdr "Test 4: Alternate Screen Buffer"
echo "Switching to alt screen in 1 second..."
sleep 1
printf '\e[?1049h'
echo "You should now see a fresh screen (alt buffer)."
echo "Returning to normal screen in 2 seconds..."
sleep 2
printf '\e[?1049l'
echo "Back to normal screen. If screen cleared/changed, alt screen works."
sleep 1

# Test 5: Cursor visibility
hdr "Test 5: Cursor Hide/Show"
echo "Hiding cursor in 1 second..."
sleep 1
printf '\e[?25l'
echo "Cursor should be hidden now."
echo "Restoring in 1 second..."
sleep 1
printf '\e[?25h'
echo "Cursor restored."
sleep 0.5

# Test 6: Bracketed paste
hdr "Test 6: Bracketed Paste"
info "Enabling bracketed paste mode..."
printf '\e[?2004h'
echo "Bracketed paste enabled. If you paste text now, it should be wrapped"
echo "in CSI 200 ~ (paste start) and CSI 201 ~ (paste end)."
echo "Disabling..."
printf '\e[?2004l'
sleep 0.5

# Test 7: Mouse reporting
hdr "Test 7: Mouse Reporting"
info "Enabling mouse tracking (SGR mode)..."
printf '\e[?1006h\e[?1003h'
echo "Move your mouse or click in the terminal."
echo "You should see escape sequences like ^[[<0;x;yM"
echo "Press any key to continue..."
read -r -n1 -s
printf '\e[?1003l\e[?1006l'
echo "Mouse tracking disabled."

# Test 8: Key encoding
hdr "Test 8: Key Encoding"
echo "Press keys to see their escape sequences:"
echo "  Arrow keys, Home, End, PageUp, PageDown"
echo "  Ctrl+letter, Alt+letter, F1-F12"
echo "  Backspace, Delete, Tab, Enter"
echo ""
echo "Expected sequences:"
echo "  Up:    ^[[A  or  ^[OA"
echo "  Down:  ^[[B  or  ^[OB"
echo "  Home:  ^[[H  or  ^[OH  or  ^[[1~"
echo "  End:   ^[[F  or  ^[OF  or  ^[[4~"
echo "  Back:  ^?    or  ^H"
echo "  Delete: ^[[3~"
echo ""
echo "Press Ctrl+C when done, then run: stty sane"
echo ""

# Final reset
printf '\e[0m\e[?25h\e[?1049l'
echo -e "${GREEN}Tests complete. Run 'reset' if terminal behaves oddly.${RESET}"
