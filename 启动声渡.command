#!/bin/zsh
set -eu
launcher='/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh'
exec "$launcher" subcast --port 32203
