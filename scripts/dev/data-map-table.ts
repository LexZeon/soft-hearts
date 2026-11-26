// Prints the 数据地图 table (electron/foundation/data-map.ts) as the Chinese Markdown table docs/data-map.md shows.
//   node node_modules/tsx/dist/cli.mjs scripts/dev/data-map-table.ts
// tests/data-map.test.ts fails when the docs page and the table differ.
import { renderDataMapMarkdown } from '../../electron/foundation/data-map';

console.log(renderDataMapMarkdown());
