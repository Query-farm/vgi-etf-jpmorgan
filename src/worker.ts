// vgi-etf-jpmorgan stdio worker entry. DuckDB spawns this and ATTACHes it:
//   LOAD vgi;
//   ATTACH 'jpmorgan' AS jpmorgan (TYPE vgi, LOCATION '/path/to/vgi-etf-jpmorgan/bin/vgi-etf-jpmorgan-worker');
//
// What this worker serves is defined once in src/parts.ts and shared with the
// HTTP entrypoint (scripts/serve.ts).

import { Worker } from "@query-farm/vgi";
import { makeWorkerParts } from "./parts.js";

const { servedFunctions, catalogInterface } = makeWorkerParts();

// `functions` for the Worker is the full set the registry serves (incl. the table scans).
new Worker({ functions: servedFunctions, catalogInterface }).run();
