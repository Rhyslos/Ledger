# Ledger roadmap

Ideas that are planned but not built yet.

## Database viewer (free, built in)

Open database files straight in Ledger, the way paid VS Code extensions do, but free.

- **SQLite first** (`.db`, `.sqlite`, `.sqlite3`): list the tables and views, browse every row in a fast scrolling grid, see each table's columns, types, keys and indexes.
- **Filters without SQL**: per-column filters (equals, contains, greater than, is empty…), sorting, and a row count, so you can find things without writing a query.
- **A query tab**: write SQL with completion for table and column names, run it, see results in the same grid, and keep a history of queries.
- **Editing**, carefully: change a cell, add or delete rows, with a "these changes will be saved" step before anything is written.
- **Export** results to CSV or JSON.
- **LQL**: to be confirmed what format this means, and added once it's clear.
- **Later, more databases**: DuckDB files, `.sql` dump files, and connections to PostgreSQL and MySQL servers.

Likely approach: the `rusqlite` crate (with SQLite bundled, so nothing to install) on the Rust side, and a grid page in a tab like Settings.
