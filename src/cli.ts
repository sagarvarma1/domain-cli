#!/usr/bin/env node
import { main, reportError } from "./app.js";

main(process.argv.slice(2)).catch((err: unknown) => {
  reportError(err);
  process.exit(1);
});
