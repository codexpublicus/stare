#!/bin/sh
# Pick session file if it exists (resume mode), otherwise full URL list
SESSION=/aria2/data/session.txt
URLS=/aria2/urls-aria2.txt
INPUT=/aria2/data/input.txt

if [ -s "$SESSION" ]; then
    echo "Resuming from session file ($(grep -c '^http' "$SESSION") URLs remaining)"
    ln -sf "$SESSION" "$INPUT"
else
    echo "Starting fresh from full URL list ($(grep -c '^http' "$URLS") URLs)"
    ln -sf "$URLS" "$INPUT"
fi

exec /aria2/start.sh "$@"
