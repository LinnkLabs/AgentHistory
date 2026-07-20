#!/usr/bin/env node
// Thin alias: run the canonical @getlinnk/agent-history CLI with the same argv.
// (Keeps `npx agent-history-cli` working; the real code lives in the scoped package.)
import '@getlinnk/agent-history/bin/agent-manager.mjs';
