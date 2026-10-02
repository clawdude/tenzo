#!/usr/bin/env node
import { VERSION } from "./app.ts";
import { readConfig } from "./config.ts";
import { startDaemon } from "./server.ts";

const USAGE = `tenzo ${VERSION}

Usage:
  tenzo serve       start the daemon on 127.0.0.1 (TENZO_PORT, default 4780)
  tenzo --version   print the version

Environment:
  TENZO_PORT     port to listen on
  TENZO_HOME     state directory (default ~/.tenzo)
  TENZO_WEB_DIR  built web app to serve (default apps/web/build)
`;

async function serve(): Promise<void> {
  const config = readConfig(process.env);
  const daemon = await startDaemon(config);
  console.log(`tenzo ${VERSION} · ${daemon.environmentId} · listening on ${daemon.url}`);

  let stopping = false;
  const stop = (signal: string) => {
    if (stopping) process.exit(1); // second signal: don't wait
    stopping = true;
    console.log(`\n${signal}: stopping`);
    daemon.close().then(
      () => process.exit(0),
      (error: unknown) => {
        console.error(error);
        process.exit(1);
      },
    );
  };
  process.on("SIGINT", () => stop("SIGINT"));
  process.on("SIGTERM", () => stop("SIGTERM"));
}

const [command] = process.argv.slice(2);
switch (command) {
  case "serve":
    await serve();
    break;
  case "--version":
  case "-v":
    console.log(VERSION);
    break;
  case undefined:
  case "help":
  case "--help":
  case "-h":
    console.log(USAGE);
    break;
  default:
    console.error(`Unknown command "${command}".\n\n${USAGE}`);
    process.exit(2);
}
