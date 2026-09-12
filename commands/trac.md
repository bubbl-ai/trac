---
description: Hand this session to Trac, which continues it unattended when quota and idle time allow
---
Run this exact command with the Bash tool and show its output to the user verbatim:

trac adopt "$CLAUDE_CODE_SESSION_ID" --repo "$PWD" $ARGUMENTS

If it fails because trac is not on the PATH, say so and stop. Do nothing else in this
session afterwards. The user should leave it now: Trac continues a forked copy of this
conversation, and anything typed here would continue the old one.
