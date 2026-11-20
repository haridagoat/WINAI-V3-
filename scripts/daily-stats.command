#!/bin/bash
# Double-clickable / schedulable wrapper: runs the daily stats fetch+upload in Terminal (which already has access to this folder),
# then closes the window if everything went fine. See scripts/daily-stats.sh.
"$(dirname "$0")/daily-stats.sh"
exit 0
