#!/usr/bin/env bash
# cclaw installer.
#
# Every step is detect -> report -> offer. Nothing is installed or changed
# without saying so first, and re-running is safe: it repairs rather than
# duplicates, which is what makes `cclaw setup` and this script the same path.
set -uo pipefail

# The guard must parse under bash 3.2 (Apple's /bin/bash) so an old shell gets a
# message instead of a syntax error.
if [[ "${BASH_VERSINFO[0]:-0}" -lt 4 ]]; then
  printf 'cclaw requires bash 4+ to install (found %s).\n' "${BASH_VERSION:-unknown}" >&2
  printf 'Try:  /opt/homebrew/bin/bash install.sh   or   brew install bash\n' >&2
  exit 1
fi

ROOT=$(cd -P "$(dirname "${BASH_SOURCE[0]}")" && pwd)
ASSUME_YES=0
[[ ${1:-} == "--yes" || ${1:-} == "-y" ]] && ASSUME_YES=1

if [[ -t 1 && -z ${NO_COLOR:-} ]]; then
  PINK=$'\033[38;2;230;2;120m'
  BLUE=$'\033[38;2;75;132;231m'
  DIM=$'\033[2m'
  RED=$'\033[31m'
  GREEN=$'\033[32m'
  YELLOW=$'\033[33m'
  RESET=$'\033[0m'
else
  PINK='' BLUE='' DIM='' RED='' GREEN='' YELLOW='' RESET=''
fi

say() { printf '%s\n' "$*"; }
ok() { printf '%s  ok%s %s\n' "$GREEN" "$RESET" "$*"; }
warn() { printf '%swarn%s %s\n' "$YELLOW" "$RESET" "$*"; }
err() { printf '%sfail%s %s\n' "$RED" "$RESET" "$*" >&2; }
step() { printf '\n%s==>%s %s\n' "$BLUE" "$RESET" "$*"; }

ask() {
  local prompt=$1
  ((ASSUME_YES)) && return 0
  [[ -t 0 ]] || return 1
  local reply
  read -r -p "     ${prompt} [y/N] " reply
  [[ $reply == [yY]* ]]
}

banner() {
  [[ -t 1 ]] || return 0
  printf '\n'
  printf '%s    ██████╗ ██████╗ ██╗      █████╗ ██╗    ██╗%s\n' "$PINK" "$RESET"
  printf '%s   ██╔════╝██╔════╝ ██║     ██╔══██╗██║    ██║%s\n' "$PINK" "$RESET"
  printf '%s   ██║     ██║      ██║     ███████║██║ █╗ ██║%s\n' "$PINK" "$RESET"
  printf '%s   ██║     ██║      ██║     ██╔══██║██║███╗██║%s\n' "$PINK" "$RESET"
  printf '%s   ╚██████╗╚██████╗ ███████╗██║  ██║╚███╔███╔╝%s\n' "$PINK" "$RESET"
  printf '%s    ╚═════╝ ╚═════╝ ╚══════╝╚═╝  ╚═╝ ╚══╝╚══╝ %s\n' "$PINK" "$RESET"
  printf '%s   installer%s\n\n' "$DIM" "$RESET"
}

have() { command -v "$1" > /dev/null 2>&1; }

install_hint() {
  case "$(uname -s)" in
    Darwin) printf 'brew install %s' "$1" ;;
    Linux)
      if have apt-get; then
        printf 'sudo apt-get install -y %s' "$1"
      elif have dnf; then
        printf 'sudo dnf install -y %s' "$1"
      elif have pacman; then
        printf 'sudo pacman -S --noconfirm %s' "$1"
      else printf 'install %s with your package manager' "$1"; fi
      ;;
    *) printf 'install %s' "$1" ;;
  esac
}

FAILED=0

banner

# --- 1. Bun, which runs cclaw itself ----------------------------------------
step "checking Bun"
if have bun; then
  ok "bun $(bun --version)"
else
  err "bun not found — cclaw is written for Bun"
  say "     install it with: curl -fsSL https://bun.sh/install | bash"
  if ask "run that now?"; then
    curl -fsSL https://bun.sh/install | bash || FAILED=1
    export PATH="$HOME/.bun/bin:$PATH"
    have bun && ok "bun $(bun --version)" || FAILED=1
  else
    FAILED=1
  fi
fi

# --- 2. The Cursor CLI, which does the actual work --------------------------
step "checking the Cursor CLI"
CURSOR_BIN=""
for candidate in agent cursor-agent; do
  if have "$candidate"; then
    CURSOR_BIN=$(command -v "$candidate")
    break
  fi
done
if [[ -z $CURSOR_BIN ]]; then
  for candidate in "$HOME/.local/bin/agent" "$HOME/.local/bin/cursor-agent"; do
    [[ -x $candidate ]] && CURSOR_BIN=$candidate && break
  done
fi

if [[ -n $CURSOR_BIN ]]; then
  ok "cursor cli $("$CURSOR_BIN" --version 2> /dev/null || echo '?') at $CURSOR_BIN"
else
  err "Cursor CLI not found (looked for 'agent' and 'cursor-agent')"
  say "     install it with: curl https://cursor.com/install -fsS | bash"
  if ask "run that now?"; then
    curl https://cursor.com/install -fsS | bash || FAILED=1
    export PATH="$HOME/.local/bin:$PATH"
    for candidate in agent cursor-agent; do
      have "$candidate" && CURSOR_BIN=$(command -v "$candidate") && break
    done
    [[ -n $CURSOR_BIN ]] && ok "installed at $CURSOR_BIN" || FAILED=1
  else
    FAILED=1
  fi
fi

# ACP is the interface our TUI speaks. It is hidden from --help, so probe it.
if [[ -n $CURSOR_BIN ]]; then
  if "$CURSOR_BIN" help acp > /dev/null 2>&1; then
    ok "cursor acp available"
  else
    warn "this Cursor build has no 'acp' subcommand; 'cclaw chat' needs it"
    say "     update with: $CURSOR_BIN update"
  fi
fi

# --- 3. The Cursor desktop app is NOT required ------------------------------
step "checking the Cursor desktop app (optional)"
if [[ -d /Applications/Cursor.app ]] || have cursor; then
  ok "Cursor desktop found"
else
  say "     ${DIM}not installed — that is fine, the CLI is standalone${RESET}"
fi

# --- 4. Supporting tools ----------------------------------------------------
step "checking supporting tools"
for tool in git jq; do
  if have "$tool"; then
    ok "$tool"
  else
    warn "$tool not found ($(install_hint "$tool"))"
  fi
done

# --- 5. PATH ----------------------------------------------------------------
step "checking PATH"
# shellcheck disable=SC2088  # the tilde is literal display text, not a path we use
case ":$PATH:" in
  *":$HOME/.local/bin:"*) ok "~/.local/bin is on PATH" ;;
  *)
    warn "~/.local/bin is not on PATH; the Cursor CLI lives there"
    say "     add: export PATH=\"\$HOME/.local/bin:\$PATH\""
    ;;
esac

# --- 6. Credentials ---------------------------------------------------------
step "checking Cursor credentials"
if [[ -n $CURSOR_BIN ]]; then
  STATUS=$("$CURSOR_BIN" status --format json 2> /dev/null || echo '{}')
  if have jq; then
    AUTHED=$(printf '%s' "$STATUS" | jq -r '.isAuthenticated // false')
    EMAIL=$(printf '%s' "$STATUS" | jq -r '.userInfo.email // ""')
    TIER=$("$CURSOR_BIN" about --format json 2> /dev/null | jq -r '.subscriptionTier // ""')
  else
    case "$STATUS" in *'"isAuthenticated":true'*) AUTHED=true ;; *) AUTHED=false ;; esac
    EMAIL="" TIER=""
  fi

  if [[ $AUTHED == true ]]; then
    ok "signed in${EMAIL:+ as $EMAIL}"
    if [[ $TIER == Free ]]; then
      warn "plan: Free — only the 'auto' model can run; named models are rejected"
    elif [[ -n $TIER ]]; then
      ok "plan: $TIER"
    fi
  else
    warn "not signed in"
    say "     browser login:  $CURSOR_BIN login"
    say "     over SSH:       NO_OPEN_BROWSER=1 $CURSOR_BIN login"
    say "     or an API key:  printf %s \"\$KEY\" | cclaw profile cred set default"
    if ask "run '$CURSOR_BIN login' now?"; then
      "$CURSOR_BIN" login || warn "login did not complete"
    fi
  fi
fi

# --- 7. Dependencies and the first profile ----------------------------------
if ((FAILED == 0)) && have bun; then
  step "installing cclaw dependencies"
  (cd "$ROOT" && bun install) && ok "dependencies installed" || FAILED=1

  step "setting up the default profile"
  # `setup` creates the profile if needed and seeds policy. It is a merge, so
  # re-running reports "unchanged" rather than clobbering local edits.
  (cd "$ROOT" && bun run src/cli.ts setup) || FAILED=1

  step "linking the cclaw command"
  mkdir -p "$HOME/.local/bin"
  if ln -sf "$ROOT/bin/cclaw" "$HOME/.local/bin/cclaw" 2> /dev/null; then
    ok "linked ~/.local/bin/cclaw"
  else
    warn "could not link ~/.local/bin/cclaw; run cclaw from $ROOT instead"
  fi
fi

# --- done -------------------------------------------------------------------
step "summary"
if ((FAILED)); then
  err "setup incomplete — resolve the items above and re-run ./install.sh"
  exit 1
fi
ok "cclaw is ready"
say ""
say "  ${BLUE}cclaw${RESET}             start the chat TUI"
say "  ${BLUE}cclaw raw${RESET}         Cursor's own TUI (the only mode with a live context figure)"
say "  ${BLUE}cclaw doctor${RESET}      re-check this setup"
say "  ${BLUE}cclaw goal set${RESET}    give the agent a standing objective"
say ""
exit 0
