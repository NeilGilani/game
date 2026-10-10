/** `npm start` (or `npx tsx src/cli.ts --port 8787`): serve the sandbox web world for demos. */
import { SITES, startSandbox } from "./server.ts";

const i = process.argv.indexOf("--port");
const port = i >= 0 ? Number(process.argv[i + 1]) : Number(process.env.PORT ?? 8787);
const sb = await startSandbox({ port });
console.log(`Sandbox web world (nothing here is real) on 127.0.0.1:${sb.port}`);
for (const [name, s] of Object.entries(SITES)) console.log(`  ${s.title.padEnd(22)} ${sb.url(name)}`);
console.log(`  Test API               http://localhost:${sb.port}/__test/state`);
