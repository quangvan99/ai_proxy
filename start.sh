#!/bin/bash

DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$DIR"
node src/index.js
