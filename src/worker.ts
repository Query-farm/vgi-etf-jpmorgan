// vgi-etf-jpmorgan stdio worker entry. DuckDB spawns this and ATTACHes it:
//   LOAD vgi;
//   ATTACH 'jpmorgan' AS jpm (TYPE vgi, LOCATION '/path/to/vgi-etf-jpmorgan/bin/vgi-etf-jpmorgan-worker');
//   SELECT * FROM jpm.products ORDER BY net_assets DESC LIMIT 10;
//   SELECT * FROM jpm.holdings WHERE fund_ticker = 'JEPI';
//   SELECT * FROM jpm.fund_details('JEPI');
//
// Keyless: no CREATE SECRET is needed. `products` and `holdings` are base TABLES (each backed by a
// scan function registered for scan dispatch — products' scan is unlisted, holdings' is listed);
// fund_details is a table function. All take the injected HTTP client (client.ts).

import { Worker, ReadOnlyCatalogInterface, FunctionRegistry } from "@query-farm/vgi";
import { makeJpmorganGet } from "./client.js";
import {
  makeProductsScan,
  makeHoldingsScan,
  makeFundDetailsFunction,
} from "./functions.js";
import { makeCatalog } from "./catalog.js";

const get = makeJpmorganGet();

// The callable table functions (products and holdings are base tables, not functions).
const functions = [makeFundDetailsFunction(get)];

// Backing scans for the base tables: registered so scan RPCs resolve, but products' scan is NOT
// added to the catalog's `functions` (exposed only as the `products` table); holdings' scan IS
// listed so DuckDB can push the fund_ticker filter into it.
const productsScan = makeProductsScan(get);
const holdingsScan = makeHoldingsScan(get);

const registry = new FunctionRegistry();
for (const fn of functions) registry.register(fn);
registry.register(productsScan);
registry.register(holdingsScan);

const catalogInterface = new ReadOnlyCatalogInterface(
  makeCatalog(functions, productsScan, holdingsScan),
  registry,
);

// `functions` for the Worker is the full set the registry serves (incl. the table scans).
new Worker({ functions: [...functions, productsScan, holdingsScan], catalogInterface }).run();
