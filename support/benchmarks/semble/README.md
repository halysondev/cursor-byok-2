<!-- Reproducible benchmark protocol for Semble's React and Vue evaluation. -->
# Semble / CodeGraph React/Vue comparison benchmark

This benchmark compares Semble against a locally installed CodeGraph on identical React and Vue commits. Every query is manually annotated to specific implementation lines; a result only counts as a hit when the returned code range covers that line.

To cover different retrieval styles, effectiveness is split into three tracks:

- `natural_language`: Semble `search` versus CodeGraph's officially recommended `codegraph_explore`;
- `literal`: multi-word code fragments, error text, or adjacent identifier combinations, retrieved through each system's product-level search entry;
- `symbol`: Semble `search` versus CodeGraph `searchNodes`, given the same exact symbol name.

All three tracks reuse the same manually annotated implementation locations. Each run also verifies that the annotation files exist and that their line numbers are in range, so stale ground truth cannot produce false scores.

## Metrics

Performance covers:

- cold start to queryable, cold indexing, and index-unit throughput;
- persisted index load time;
- cached hot-query min, max, mean, standard deviation, P50, P95, P99;
- a separate latency for symbol queries after an explicit Semble index refresh;
- indexed files, code chunks or graph nodes, graph edges, and persisted index size.

Effectiveness covers:

- Recall@1, Recall@3, Recall@5, Recall@10;
- MRR@10;
- nDCG@10;
- the first-hit rank and Top 10 result details for every query.

## Running

`codegraph` must be on the local `PATH`. From the workspace root:

```sh
cargo run --release -p semble-benchmark
```

Add `--check` for CI or local regression gating. The benchmark report is still generated, but the command fails if any Semble track falls below the public quality gates in [`quality-gates.json`](./quality-gates.json). The full two-system report additionally requires Semble's cached load, plus symbol-query P50 and P95, to stay within 90% of CodeGraph's:

```sh
cargo run --release -p semble-benchmark -- --check
```

To validate only Semble query effectiveness and quality gates, skipping the slower CodeGraph rebuild:

```sh
cargo run --release -p semble-benchmark -- --semble-only --check
```

By default the tool fetches the pinned commits itself and clears the isolated benchmark indexes; model caches are kept. CodeGraph uses a separate Git working copy under `target` and never creates, overwrites, or deletes `.codegraph` in the repositories passed in. Workspaces already at the exact commits can be reused:

```sh
cargo run --release -p semble-benchmark -- \
  --source react=/path/to/react \
  --source vue=/path/to/vue \
  --repetitions 5
```

Results are written to `results/latest.json` and `results/latest.md`. The JSON feeds later regression comparisons; the Markdown is for human review. The runtime environment, commits, parameters, and per-query results are all included in the report.

## Interpretation limits

This is a code-location benchmark; it does not evaluate generated answers. `codegraph_explore`'s graph expansion and source reads count toward actual tool latency, so this compares product paths, not internal algorithm microbenchmarks. Semble persists both incremental build snapshots and a directly deserializable runtime index; after loading, queries reuse the checked in-memory index within a fixed one-second refresh window, and the first query after expiry — or an explicit `refresh` — scans file metadata in parallel and reprocesses only changed files. The report records cached queries separately from refresh-plus-symbol queries. CodeGraph's load metric opens a prepared graph database. CodeGraph's standalone callers, callees, and impact capabilities are outside this scope. The annotation set is small — suitable for guarding against retrieval-quality regressions, but it should not be read as overall accuracy across all React/Vue development questions. Each query runs one untimed warmup before five recorded repetitions; the reported standard deviation helps spot jitter, but cross-version performance comparisons should still repeat at least three rounds on the same machine and power state.
