//! Machine-readable comparison report structures and Markdown rendering.

use serde::Serialize;

use crate::metrics::{EffectMetrics, LatencyMetrics};

#[derive(Debug, Serialize)]
pub struct BenchmarkReport {
    pub schema_version: u32,
    pub generated_at_unix_seconds: u64,
    pub environment: Environment,
    pub configuration: Configuration,
    pub overall: Vec<OverallReport>,
    pub suites: Vec<SuiteReport>,
}

#[derive(Debug, Serialize)]
pub struct Environment {
    pub os: String,
    pub architecture: String,
    pub rustc: String,
}

#[derive(Debug, Serialize)]
pub struct Configuration {
    pub top_k: usize,
    pub repetitions: usize,
    pub tracks: Vec<String>,
    pub relevance: String,
}

#[derive(Debug, Serialize)]
pub struct OverallReport {
    pub system: String,
    pub track: String,
    pub effect: EffectMetrics,
}

#[derive(Debug, Serialize)]
pub struct SuiteReport {
    pub name: String,
    pub repository: String,
    pub commit: String,
    pub systems: Vec<SystemReport>,
}

#[derive(Debug, Serialize)]
pub struct SystemReport {
    pub system: String,
    pub version: String,
    pub index: IndexMetrics,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub refresh_symbol_latency: Option<LatencyMetrics>,
    pub tracks: Vec<TrackReport>,
}

#[derive(Debug, Serialize)]
pub struct IndexMetrics {
    pub cold_ready_ms: f64,
    pub cold_index_ms: f64,
    pub cached_load_ms: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub in_memory_prepare_ms: Option<f64>,
    pub indexed_files: usize,
    pub indexed_units: usize,
    pub indexed_unit: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub indexed_edges: Option<usize>,
    pub persisted_index_bytes: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_bytes: Option<u64>,
    pub units_per_second: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_mib_per_second: Option<f64>,
}

#[derive(Debug, Serialize)]
pub struct TrackReport {
    pub name: String,
    pub effect: EffectMetrics,
    pub query_latency: LatencyMetrics,
    pub queries: Vec<QueryReport>,
}

#[derive(Debug, Serialize)]
pub struct QueryReport {
    pub id: String,
    pub query: String,
    pub first_relevant_rank: Option<usize>,
    pub latency: LatencyMetrics,
    pub expected: Vec<String>,
    pub results: Vec<ResultSummary>,
}

#[derive(Debug, Serialize)]
pub struct ResultSummary {
    pub rank: usize,
    pub path: String,
    pub start_line: usize,
    pub end_line: usize,
    pub score: f32,
    pub relevant: bool,
}

pub fn markdown(report: &BenchmarkReport) -> String {
    let mut output = String::new();
    output.push_str("# Semble vs CodeGraph React/Vue comparison benchmark\n\n");
    output.push_str(&format!(
        "- Environment: {} {}, {}\n- Queries: Top {}, each repeated {} times\n- natural_language: English behavioral descriptions; literal: multi-word code/error literal fragments; symbol: exact symbol names\n- Comparison: natural_language and literal use CodeGraph explore; symbol uses CodeGraph searchNodes\n- Verdict: the returned code range must cover the manually annotated implementation lines\n\n",
        report.environment.os,
        report.environment.architecture,
        report.environment.rustc,
        report.configuration.top_k,
        report.configuration.repetitions
    ));
    output.push_str("## Overall effectiveness\n\n");
    output.push_str(
        "| System | Query track | Recall@1 | Recall@5 | Recall@10 | MRR@10 | nDCG@10 |\n",
    );
    output.push_str("| --- | --- | ---: | ---: | ---: | ---: | ---: |\n");
    for item in &report.overall {
        output.push_str(&format!(
            "| {} | {} | {:.1}% | {:.1}% | {:.1}% | {:.3} | {:.3} |\n",
            item.system,
            item.track,
            item.effect.recall_at_1 * 100.0,
            item.effect.recall_at_5 * 100.0,
            item.effect.recall_at_10 * 100.0,
            item.effect.mrr_at_10,
            item.effect.ndcg_at_10,
        ));
    }
    output.push_str("\n## Performance comparison\n\n");
    output.push_str("Cold-start ready covers runtime loading and the first index; Semble queries reuse the checked index directly within a one-second refresh window, and the source fingerprint is revalidated when the window expires or an explicit refresh is requested. Cached queries and refresh+symbol are timed separately; query latency is the actual tool-handling time inside a persistent process, excluding CLI process startup. Each query is warmed up once first.\n\n");
    output.push_str("| Dataset | System | Cold-start ready | Cached load | Natural language P50 / P95 / σ | Literal P50 / P95 / σ | Cached symbol P50 / P95 / σ | Refresh+symbol P50 / P95 | Files / index units | Index size |\n");
    output.push_str("| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |\n");
    for suite in &report.suites {
        for system in &suite.systems {
            let natural = track(system, "natural_language");
            let literal = track(system, "literal");
            let symbol = track(system, "symbol");
            output.push_str(&format!(
                "| {} | {} {} | {:.1} ms | {:.1} ms | {:.2} / {:.2} / {:.2} ms | {:.2} / {:.2} / {:.2} ms | {:.2} / {:.2} / {:.2} ms | {} | {} / {} {}{} | {:.2} MiB |\n",
                suite.name,
                system.system,
                system.version,
                system.index.cold_ready_ms,
                system.index.cached_load_ms,
                natural.query_latency.p50_ms,
                natural.query_latency.p95_ms,
                natural.query_latency.stddev_ms,
                literal.query_latency.p50_ms,
                literal.query_latency.p95_ms,
                literal.query_latency.stddev_ms,
                symbol.query_latency.p50_ms,
                symbol.query_latency.p95_ms,
                symbol.query_latency.stddev_ms,
                system
                    .refresh_symbol_latency
                    .as_ref()
                    .map(|latency| format!("{:.2} / {:.2} ms", latency.p50_ms, latency.p95_ms))
                    .unwrap_or_else(|| "—".into()),
                system.index.indexed_files,
                system.index.indexed_units,
                system.index.indexed_unit,
                system
                    .index
                    .indexed_edges
                    .map(|edges| format!(" / {edges} edges"))
                    .unwrap_or_default(),
                as_mib(system.index.persisted_index_bytes),
            ));
        }
    }
    output.push_str("\n## Per-dataset effectiveness\n\n");
    output.push_str("| Dataset | System | Track | Recall@1 / @5 / @10 | MRR@10 | nDCG@10 |\n");
    output.push_str("| --- | --- | --- | ---: | ---: | ---: |\n");
    for suite in &report.suites {
        for system in &suite.systems {
            for track in &system.tracks {
                output.push_str(&format!(
                    "| {} | {} | {} | {:.1}% / {:.1}% / {:.1}% | {:.3} | {:.3} |\n",
                    suite.name,
                    system.system,
                    track.name,
                    track.effect.recall_at_1 * 100.0,
                    track.effect.recall_at_5 * 100.0,
                    track.effect.recall_at_10 * 100.0,
                    track.effect.mrr_at_10,
                    track.effect.ndcg_at_10,
                ));
            }
        }
    }
    for suite in &report.suites {
        for system in &suite.systems {
            for track in &system.tracks {
                output.push_str(&format!(
                    "\n## {} · {} · {} details\n\n",
                    suite.name, system.system, track.name
                ));
                output.push_str("| Query | First hit | P50 / P95 / σ | Top 1 |\n");
                output.push_str("| --- | ---: | ---: | --- |\n");
                for query in &track.queries {
                    let rank = query
                        .first_relevant_rank
                        .map(|rank| rank.to_string())
                        .unwrap_or_else(|| "miss".into());
                    let top = query
                        .results
                        .first()
                        .map(|result| {
                            format!("{}:{}-{}", result.path, result.start_line, result.end_line)
                        })
                        .unwrap_or_else(|| "—".into());
                    output.push_str(&format!(
                        "| `{}` | {} | {:.2} / {:.2} / {:.2} ms | `{}` |\n",
                        query.id,
                        rank,
                        query.latency.p50_ms,
                        query.latency.p95_ms,
                        query.latency.stddev_ms,
                        top
                    ));
                }
            }
        }
    }
    output.push_str("\n## Fairness notes\n\n");
    output.push_str("The natural-language and multi-word literal tracks call CodeGraph's officially recommended codegraph_explore, including graph expansion and the final source read; the symbol track calls searchNodes. All three Semble tracks call the same hybrid search interface. Every query shares the same set of manually annotated implementation locations; no system gets a different ground truth. The two systems emit results at different granularity, so this report compares the effectiveness of reaching the same code location and actual tool latency — it is not a microbenchmark of each internal algorithm. CodeGraph's standalone callers, callees, and impact capabilities are outside this scope.\n");
    output
}

fn track<'a>(system: &'a SystemReport, name: &str) -> &'a TrackReport {
    system
        .tracks
        .iter()
        .find(|track| track.name == name)
        .expect("every system report contains all benchmark tracks")
}

fn as_mib(bytes: u64) -> f64 {
    bytes as f64 / 1_048_576.0
}

#[cfg(test)]
mod tests {
    use super::*;

    fn effect() -> EffectMetrics {
        EffectMetrics {
            query_count: 1,
            recall_at_1: 1.0,
            recall_at_3: 1.0,
            recall_at_5: 1.0,
            recall_at_10: 1.0,
            mrr_at_10: 1.0,
            ndcg_at_10: 1.0,
        }
    }

    fn track_report(name: &str) -> TrackReport {
        TrackReport {
            name: name.into(),
            effect: effect(),
            query_latency: LatencyMetrics {
                samples: 1,
                min_ms: 1.0,
                max_ms: 1.0,
                mean_ms: 1.0,
                stddev_ms: 0.0,
                p50_ms: 1.0,
                p95_ms: 1.0,
                p99_ms: 1.0,
            },
            queries: Vec::new(),
        }
    }

    #[test]
    fn markdown_contains_both_systems_and_tracks() {
        let report = BenchmarkReport {
            schema_version: 4,
            generated_at_unix_seconds: 0,
            environment: Environment {
                os: "test".into(),
                architecture: "test".into(),
                rustc: "rustc test".into(),
            },
            configuration: Configuration {
                top_k: 10,
                repetitions: 3,
                tracks: vec!["natural_language".into(), "literal".into(), "symbol".into()],
                relevance: "location overlap".into(),
            },
            overall: vec![OverallReport {
                system: "Semble".into(),
                track: "natural_language".into(),
                effect: effect(),
            }],
            suites: vec![SuiteReport {
                name: "fixture".into(),
                repository: "repo".into(),
                commit: "commit".into(),
                systems: vec![SystemReport {
                    system: "Semble".into(),
                    version: "0.1".into(),
                    index: IndexMetrics {
                        cold_ready_ms: 1.0,
                        cold_index_ms: 1.0,
                        cached_load_ms: 1.0,
                        in_memory_prepare_ms: Some(1.0),
                        indexed_files: 1,
                        indexed_units: 2,
                        indexed_unit: "chunks".into(),
                        indexed_edges: None,
                        persisted_index_bytes: 3,
                        source_bytes: Some(4),
                        units_per_second: 5.0,
                        source_mib_per_second: Some(6.0),
                    },
                    refresh_symbol_latency: Some(LatencyMetrics {
                        samples: 1,
                        min_ms: 2.0,
                        max_ms: 2.0,
                        mean_ms: 2.0,
                        stddev_ms: 0.0,
                        p50_ms: 2.0,
                        p95_ms: 2.0,
                        p99_ms: 2.0,
                    }),
                    tracks: vec![
                        track_report("natural_language"),
                        track_report("literal"),
                        track_report("symbol"),
                    ],
                }],
            }],
        };
        let rendered = markdown(&report);
        assert!(rendered.contains("Semble"));
        assert!(rendered.contains("natural_language"));
    }
}
