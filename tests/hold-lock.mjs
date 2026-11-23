#!/usr/bin/env node
// Holds a run's liveness socket so the CLI sees the run as alive. Test-only stand-in for a child pi.
import { createServer } from "node:net";

const socket = process.argv[2];
const server = createServer((client) => client.destroy());
server.listen(socket, () => process.stdout.write("locked\n"));
process.on("SIGTERM", () => server.close(() => process.exit(0)));
