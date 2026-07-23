---
name: transfer
description: Hand this Codex session off to an interactive Claude Code session
---

# Transfer session to Claude Code

Builds a handoff document from this session and gives the user a command that
starts interactive Claude Code with it. You compose the narrative; the script
only extracts bounded, redacted evidence and handles files safely.

## Locating the plugin scripts

Resolve the scripts directory once (single glob match expected):

    SCRIPTS=$(ls -d ~/.codex/plugins/cache/*/claude/*/scripts 2>/dev/null | head -1)

If `$SCRIPTS` is empty the plugin install is broken — tell the user to reinstall the plugin.

## Steps

1. Run: `node "$SCRIPTS/transfer.mjs" extract < /dev/null`
   - Exit 2 with candidate transcripts listed: ask the user which one, then
     re-run with `CODEX_THREAD_ID` unset is NOT the fix — instead pass the
     chosen file by extracting evidence yourself from that path in step 2.
   - Output is JSON: `goals`, `recent` (last exchanges), `filesTouched`.
2. Compose the handoff narrative from the evidence AND your own knowledge of
   this session. Sections: Goal, Key decisions, Files touched, Current state,
   Next steps. Do not include secrets. Start it with `# Handoff from Codex`.
3. Write the narrative VERBATIM to a temp file with your file-writing tool,
   then run:

       node "$SCRIPTS/transfer.mjs" write-handoff < /tmp/claude-handoff.txt

4. Relay the printed handoff path and launch command to the user. DO NOT run
   the launch command yourself — it starts an interactive TUI the user must own.
