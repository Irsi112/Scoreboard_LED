#!/bin/bash

# Define variables
REMOTE_USER="admin"
REMOTE_HOST="kylltal-scoreboard"
REMOTE_PATH="~/scoreboard-led"

# Local paths
LOCAL_BACKEND="c:/Users/Irsi1/OneDrive/Documents/Projects/Scoreboard_LED/backend/server.js"
LOCAL_FRONTEND_INDEX="c:/Users/Irsi1/OneDrive/Documents/Projects/Scoreboard_LED/frontend/index.html"
LOCAL_FRONTEND_ADMIN="c:/Users/Irsi1/OneDrive/Documents/Projects/Scoreboard_LED/frontend/admin.html"

# Sync files
scp "$LOCAL_BACKEND" "$REMOTE_USER@$REMOTE_HOST:$REMOTE_PATH/backend/"
scp "$LOCAL_FRONTEND_INDEX" "$REMOTE_USER@$REMOTE_HOST:$REMOTE_PATH/frontend/"
scp "$LOCAL_FRONTEND_ADMIN" "$REMOTE_USER@$REMOTE_HOST:$REMOTE_PATH/frontend/"

echo "Files synchronized successfully!"