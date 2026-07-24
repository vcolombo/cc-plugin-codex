---
name: setup
description: Check Claude Code install/auth for this plugin and toggle the Stop review gate
---

# Claude plugin setup

## Locating the plugin scripts

Codex runs every Bash tool call in a fresh shell — a variable set in one
command is gone by the next. So the scripts-directory resolver MUST be
prepended to every command that invokes a script, joined with `;` into a
single command. Never run the resolver as a separate step. Canonical
resolver (prefers this plugin's own marketplace cache before falling back to
any same-named `claude` plugin from another marketplace):

    SCRIPTS=$(ls -d "${CODEX_HOME:-$HOME/.codex}"/plugins/cache/cc-plugin-codex/claude/*/scripts 2>/dev/null | sort -V | tail -1); [ -z "$SCRIPTS" ] && SCRIPTS=$(ls -d "${CODEX_HOME:-$HOME/.codex}"/plugins/cache/*/claude/*/scripts 2>/dev/null | sort -V | tail -1); [ -z "$SCRIPTS" ] && { echo "cc-plugin-codex scripts not found; reinstall the plugin"; exit 1; }

## Steps

1. Run, as ONE command:

       SCRIPTS=$(ls -d "${CODEX_HOME:-$HOME/.codex}"/plugins/cache/cc-plugin-codex/claude/*/scripts 2>/dev/null | sort -V | tail -1); [ -z "$SCRIPTS" ] && SCRIPTS=$(ls -d "${CODEX_HOME:-$HOME/.codex}"/plugins/cache/*/claude/*/scripts 2>/dev/null | sort -V | tail -1); [ -z "$SCRIPTS" ] && { echo "cc-plugin-codex scripts not found; reinstall the plugin"; exit 1; }; node "$SCRIPTS/setup.mjs" status < /dev/null

   and interpret the JSON:
   - `claude.found: false` — offer `npm install -g @anthropic-ai/claude-code`.
     Run it ONLY after the user explicitly confirms.
   - `auth.loggedIn: false` — walk the user through the auth flow in step 2.
   - `sessionRecorded: false` — plugin hooks not trusted yet or session predates
     install; suggest approving hooks and starting a fresh Codex session.
   - Relay the `notes` about sandbox/network requirements.
2. Authentication flow (when `auth.loggedIn` is false, or the user asks to set
   up auth). Under Codex's sandbox the macOS Keychain is blocked, so a machine
   that is logged in still reads as logged out; the fix is an env var in
   `~/.codex/.env`, which Codex loads at startup and passes into skill calls.
   - Ask the user which method they want:
     - **Subscription (OAuth)** — uses their Claude Max/Pro plan, no API billing. Recommended.
     - **API key** — bills as API usage.
   - Run, as ONE command, with `oauth` or `apikey`:

         SCRIPTS=$(ls -d "${CODEX_HOME:-$HOME/.codex}"/plugins/cache/cc-plugin-codex/claude/*/scripts 2>/dev/null | sort -V | tail -1); [ -z "$SCRIPTS" ] && SCRIPTS=$(ls -d "${CODEX_HOME:-$HOME/.codex}"/plugins/cache/*/claude/*/scripts 2>/dev/null | sort -V | tail -1); [ -z "$SCRIPTS" ] && { echo "cc-plugin-codex scripts not found; reinstall the plugin"; exit 1; }; node "$SCRIPTS/setup.mjs" env-help oauth < /dev/null

   - Relay the returned `steps` to the user verbatim. **SECURITY: never ask the
     user to paste the token/key into this chat, never read `~/.codex/.env`
     yourself, and never echo the secret. The user adds the value to the file
     directly.** The OAuth login (`claude setup-token`) must be run by the user
     in their own terminal — it opens a browser and needs network the sandbox
     denies.
   - After they've added the line and started a fresh Codex session, re-run the
     `status` command to confirm `auth.loggedIn: true`.
3. Gate toggle on request (resolver and script call as ONE command each time):
   - Enable:

         SCRIPTS=$(ls -d "${CODEX_HOME:-$HOME/.codex}"/plugins/cache/cc-plugin-codex/claude/*/scripts 2>/dev/null | sort -V | tail -1); [ -z "$SCRIPTS" ] && SCRIPTS=$(ls -d "${CODEX_HOME:-$HOME/.codex}"/plugins/cache/*/claude/*/scripts 2>/dev/null | sort -V | tail -1); [ -z "$SCRIPTS" ] && { echo "cc-plugin-codex scripts not found; reinstall the plugin"; exit 1; }; node "$SCRIPTS/setup.mjs" gate on

     WARN: every stop triggers a Claude review; token cost, possible loops,
     and the hook runs outside the Codex sandbox.
   - Disable:

         SCRIPTS=$(ls -d "${CODEX_HOME:-$HOME/.codex}"/plugins/cache/cc-plugin-codex/claude/*/scripts 2>/dev/null | sort -V | tail -1); [ -z "$SCRIPTS" ] && SCRIPTS=$(ls -d "${CODEX_HOME:-$HOME/.codex}"/plugins/cache/*/claude/*/scripts 2>/dev/null | sort -V | tail -1); [ -z "$SCRIPTS" ] && { echo "cc-plugin-codex scripts not found; reinstall the plugin"; exit 1; }; node "$SCRIPTS/setup.mjs" gate off
