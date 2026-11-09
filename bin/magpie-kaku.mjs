#!/usr/bin/env bun
import { main } from "../dist/cli.js"

process.exitCode = main(process.argv.slice(2))
